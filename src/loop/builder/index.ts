import { err, ok, type Result } from "neverthrow";

import type { AutonomousRequest, LlmBackend } from "../../backends/index.ts";
import type { Outcome } from "../../conversation/index.ts";
import { flow, llm } from "../../flow/index.ts";
import { backendFailed, type BackendTag, type RuntimeError, type Usage } from "../../model/index.ts";
import { fixLoop, type FixLoopAction } from "../../review/index.ts";
import { analyzeGraph, type Edge } from "../graph/index.ts";
import { measure as manifestMeasure, type TaskManifest } from "../state/index.ts";
import { enforceTerminationContract, type TerminationContractError } from "../termination-contract.ts";
import type {
  ConfidenceState,
  GatesState,
  LoopBuilder,
  LoopGuards,
  LoopOutcome,
  LoopRunError,
  LoopRunOptions,
  LoopVariant,
  TerminationPreset,
} from "./types.ts";

export * from "./types.ts";

// The loop() builder lowers a declarative loop onto flow() + the generic fixLoop convergence
// primitive (spec loop-builder / flow-runtime, design D1+D3). Effect lives in src/loop/engine;
// this surface never touches it, so the single-cycle case reads like a guarded `while`.

/** One body node: a deterministic `.step()` transform or the single `.reason()` LLM verb. */
interface StepItem<S> {
  readonly kind: "step";
  readonly name: string;
  readonly body: (state: S) => Promise<S> | S;
}
interface ReasonItem {
  readonly kind: "reason";
  readonly tag: BackendTag;
  /** Resolved lazily so `llm()` reads the flow context established by `.run()`. */
  readonly run: () => Promise<Outcome>;
}
type BodyItem<S> = StepItem<S> | ReasonItem;

interface Probe<S> {
  readonly state: S;
  readonly measure: number;
}

interface BodyResult<S> {
  readonly state: S;
  readonly usage?: Usage;
}

/** A constant cycle action: the fingerprint guard is disabled, so its identity never matters. */
const CYCLE_ACTION: FixLoopAction = { identity: "loop-cycle", inputs: null };

class LoopBuilderImpl<S> implements LoopBuilder<S> {
  private readonly items: BodyItem<S>[] = [];
  private measureFn: ((state: S) => Promise<number> | number) | undefined;
  private termination: TerminationPreset<S> | LoopVariant<S> | undefined;
  private readonly guards: { maxIterations?: number; wallClockMs?: number; tokenBudget?: number } = {};

  constructor(private readonly name: string) {}

  reason<B extends BackendTag, Output = unknown>(
    backend: LlmBackend<B>,
    request: AutonomousRequest<Output, B>
  ): LoopBuilder<S> {
    this.items.push({
      kind: "reason",
      tag: backend.tag,
      run: () => llm().autonomous(backend, request).awaitResult(),
    });
    return this;
  }

  step(name: string, body: (state: S) => Promise<S> | S): LoopBuilder<S> {
    this.items.push({ kind: "step", name, body });
    return this;
  }

  measure(fn: (state: S) => Promise<number> | number): LoopBuilder<S> {
    this.measureFn = fn;
    return this;
  }

  until(termination: TerminationPreset<S> | LoopVariant<S>): LoopBuilder<S> {
    this.termination = termination;
    return this;
  }

  guard(opts: LoopGuards): LoopBuilder<S> {
    if (opts.maxIterations !== undefined) this.guards.maxIterations = opts.maxIterations;
    if (opts.wallClockMs !== undefined) this.guards.wallClockMs = opts.wallClockMs;
    if (opts.tokenBudget !== undefined) this.guards.tokenBudget = opts.tokenBudget;
    return this;
  }

  async run(initial?: S, options: LoopRunOptions = {}): Promise<Result<LoopOutcome<S>, LoopRunError>> {
    // 1. Termination by construction (design D3): reject an unguarded back-edge before running.
    const contract = this.enforceContract();
    if (contract.isErr()) {
      return err(contract.error);
    }

    const variant = this.resolveVariant();
    const guards = this.resolveGuards();

    // 2. Lower onto flow() + fixLoop(); accessors (and test overrides) resolve from this context.
    return await flow<Result<LoopOutcome<S>, LoopRunError>>(options.args ?? [], options.overrides ?? {})(async () => {
      let current = initial as S;
      let cycle = 0;

      const summary = await fixLoop<Probe<S>>({
        evaluate: async () => ok({ state: current, measure: await variant(current, cycle) }),
        converged: (probe) => probe.measure <= 0,
        nextAction: (probe) => (probe.measure <= 0 ? undefined : CYCLE_ACTION),
        fix: async () => {
          const body = await this.runBody(current);
          if (body.isErr()) {
            return err(body.error);
          }
          current = body.value.state;
          cycle += 1;
          // Post-cycle measure from the SAME variant the loop converges on, so the emitted
          // progress stream cannot drift from the termination variant (spec execution-observability).
          if (options.onCycle !== undefined) {
            const measure = await variant(current, cycle);
            options.onCycle({
              iteration: cycle,
              measure,
              ...(body.value.usage === undefined ? {} : { usage: body.value.usage }),
            });
          }
          return ok(body.value.usage === undefined ? {} : { usage: body.value.usage });
        },
        fingerprint: false,
        ...(guards.maxIterations === undefined ? {} : { maxIterations: guards.maxIterations }),
        ...(guards.wallClockMs === undefined ? {} : { wallClockMs: guards.wallClockMs }),
        ...(guards.tokenBudget === undefined ? {} : { tokenBudget: guards.tokenBudget }),
      });

      if (summary.isErr()) {
        return err(summary.error);
      }
      const value = summary.value;
      return ok({
        state: value.lastEvaluation.state,
        stopReason: value.stop,
        iterations: value.iterations,
      });
    });
  }

  /** Run the cycle body once, threading state through `.step()`s and folding `.reason()` usage. */
  private async runBody(state: S): Promise<Result<BodyResult<S>, RuntimeError>> {
    let current = state;
    let usage: Usage | undefined;
    for (const item of this.items) {
      if (item.kind === "step") {
        current = await item.body(current);
        continue;
      }
      const outcome = await item.run();
      if (outcome.type === "failed") {
        return err(outcome.error);
      }
      if (outcome.type === "cancelled") {
        return err(backendFailed(item.tag, "reason verb cancelled before completion"));
      }
      const reported = outcome.result.usage;
      if (reported !== undefined) {
        usage = usage === undefined ? reported : addUsage(usage, reported);
      }
    }
    return ok(usage === undefined ? { state: current } : { state: current, usage });
  }

  /** The loop has a variant iff a custom measure or a termination (preset/variant) was supplied. */
  private hasVariant(): boolean {
    return this.measureFn !== undefined || this.termination !== undefined;
  }

  /** Normalize the variant to one async measure; priority: `.measure()` > `.until()`. */
  private resolveVariant(): (state: S, cycle: number) => Promise<number> {
    const measureFn = this.measureFn;
    if (measureFn !== undefined) {
      return (state) => Promise.resolve(measureFn(state));
    }
    const termination = this.termination;
    if (termination !== undefined) {
      if (isPreset(termination)) {
        const preset = termination;
        return (state, cycle) => Promise.resolve(preset.measure(state, cycle));
      }
      const variant = termination;
      return (state) => Promise.resolve(variant.measure(state));
    }
    // Unreachable after the contract check; an unguarded loop rests on its ceiling.
    return () => Promise.resolve(Number.POSITIVE_INFINITY);
  }

  /** Explicit `.guard()` values win; a preset's default seatbelts fill the rest (design D3). */
  private resolveGuards(): LoopGuards {
    const termination = this.termination;
    const presetGuards = termination !== undefined && isPreset(termination) ? termination.guards : undefined;
    const maxIterations = this.guards.maxIterations ?? presetGuards?.maxIterations;
    const wallClockMs = this.guards.wallClockMs ?? presetGuards?.wallClockMs;
    const tokenBudget = this.guards.tokenBudget ?? presetGuards?.tokenBudget;
    return {
      ...(maxIterations === undefined ? {} : { maxIterations }),
      ...(wallClockMs === undefined ? {} : { wallClockMs }),
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
    };
  }

  /** Build the cyclic graph (one declared back-edge) and enforce termination by construction. */
  private enforceContract(): Result<void, TerminationContractError> {
    const ids = this.nodeIds();
    const first = ids.at(0);
    const last = ids.at(-1);
    if (first === undefined || last === undefined) {
      return ok(undefined); // no body ⇒ no cycle to guard
    }
    const edges: Edge[] = [];
    for (let i = 0; i + 1 < ids.length; i += 1) {
      const from = ids[i];
      const to = ids[i + 1];
      if (from !== undefined && to !== undefined) {
        edges.push({ from, to });
      }
    }
    const backEdge: Edge = { from: last, to: first };
    const report = analyzeGraph({
      nodes: ids,
      edges: [...edges, backEdge],
      declaredBackEdges: [backEdge],
    });
    const guarded = this.hasVariant();
    return enforceTerminationContract(report, () => guarded);
  }

  /** Unique, loop-namespaced node ids in authored order (so contract errors name the loop). */
  private nodeIds(): string[] {
    const used = new Set<string>();
    const ids: string[] = [];
    for (const item of this.items) {
      const base = `${this.name}:${item.kind === "reason" ? "reason" : item.name}`;
      let id = base;
      let suffix = 1;
      while (used.has(id)) {
        id = `${base}#${String(suffix)}`;
        suffix += 1;
      }
      used.add(id);
      ids.push(id);
    }
    return ids;
  }
}

function isPreset<S>(termination: TerminationPreset<S> | LoopVariant<S>): termination is TerminationPreset<S> {
  return "kind" in termination;
}

function addUsage(a: Usage, b: Usage): Usage {
  const reasoning = (a.reasoning ?? 0) + (b.reasoning ?? 0);
  const base = { input: a.input + b.input, output: a.output + b.output };
  return reasoning > 0 ? { ...base, reasoning } : base;
}

/** Entry point for the declarative loop builder (task 5.1). */
export function loop<S = unknown>(name: string): LoopBuilder<S> {
  return new LoopBuilderImpl<S>(name);
}

// Preset termination archetypes (design D3 / task 5.2). Each bundles a loop variant whose
// measure floors at 0; choosing one satisfies the termination contract with no author math.

/** TDD / compiler loop: drive failing tests/gates to zero. */
export function untilGatesGreen(): TerminationPreset<GatesState> {
  return { kind: "untilGatesGreen", measure: (state) => Math.max(0, state.failingGates) };
}

/** The "Ralph" case: drive the manifest's pending-task count to zero (variant from L05 projection). */
export function untilManifestComplete(): TerminationPreset<TaskManifest> {
  return { kind: "untilManifestComplete", measure: (state) => manifestMeasure(state) };
}

/** Today's review/fix loop: drive the open-issue count to zero. */
export function untilNoIssues(): TerminationPreset<readonly unknown[]> {
  return { kind: "untilNoIssues", measure: (state) => state.length };
}

/** Confidence loop: drive `1 − confidence` to the threshold floor. */
export function untilConfident(threshold: number): TerminationPreset<ConfidenceState> {
  return { kind: "untilConfident", measure: (state) => Math.max(0, threshold - state.confidence) };
}

/** Bounded-count escape hatch: the variant is the remaining iterations; converges after `n`. */
export function times(n: number): TerminationPreset {
  const ceiling = Math.max(0, Math.floor(n));
  return {
    kind: "times",
    measure: (_state, cycle) => Math.max(0, ceiling - cycle),
    guards: { maxIterations: ceiling },
  };
}

// Opt-in fan-out / fan-in combinators (spec loop-builder; design D9; tasks 6.1-6.4). They live
// in ./fanout.ts (Effect-free, building on the engine's plain `runBoundedBranches` seam) and are
// surfaced here so the loop authoring module exposes them; omitting them leaves the single-cycle
// loop() surface above unchanged.
export * from "../fanout.ts";
