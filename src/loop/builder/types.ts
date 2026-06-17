import type { Result } from "neverthrow";

import type { AutonomousRequest, LlmBackend } from "../../backends/index.ts";
import type { FlowOverrides } from "../../flow/index.ts";
import type { BackendTag, RuntimeError, Usage } from "../../model/index.ts";
import type { TerminationContractError } from "../termination-contract.ts";

// Declarative loop() builder — the Effect-free authoring front door (spec loop-builder).
// Lowers to flow() + the generic fixLoop convergence primitive. No Effect type may appear
// here (design D2 facade gate). The single-cycle case reads like a guarded `while`: no
// graph, fan-out, Effect, queue, or conversation symbol surfaces in authored source.

/** Surfaced from the internal contract module so callers can discriminate a build failure. */
export type { TerminationContractError } from "../termination-contract.ts";

/**
 * A loop variant (design D3): a measure bounded below — floor `0` by convention — that the
 * loop drives toward zero. `.measure(fn)` supplies one directly; presets bundle one.
 */
export interface LoopVariant<S = unknown> {
  /** Current measure; the loop converges when this reaches `0`. */
  measure(state: S): Promise<number> | number;
}

export type PresetKind =
  | "untilGatesGreen"
  | "untilManifestComplete"
  | "untilNoIssues"
  | "untilConfident"
  | "times";

/**
 * A preset termination archetype (design D3). Choosing one satisfies the termination contract
 * without the author authoring variant math. The bundled `measure` is the loop variant (floor
 * `0`); `cycle` is the completed-iteration count, needed by count-based presets like `times`.
 * `guards` are sane default seatbelts the preset contributes; an explicit `.guard()` overrides.
 */
export interface TerminationPreset<S = unknown> {
  readonly kind: PresetKind;
  readonly measure: (state: S, cycle: number) => number;
  readonly guards?: LoopGuards;
}

/** Fan-in join policies — all four ship in v1 (design D9). Wired by L07 `fanIn`. */
export type JoinPolicy = "barrier" | "race" | "quorum" | "reduce";

/** Seatbelt guards layered under the variant (design D3): ceiling, wall-clock, token budget. */
export interface LoopGuards {
  readonly maxIterations?: number;
  readonly wallClockMs?: number;
  readonly tokenBudget?: number;
}

/** Discriminated stop reason; extends the fixLoop stops with `budget-exhausted`/`cancelled` (design D3). */
export type LoopStopReason =
  | "converged"
  | "unfixable"
  | "stuck"
  | "timeout"
  | "ceiling"
  | "budget-exhausted"
  | "cancelled";

/** Outcome of a completed loop run. */
export interface LoopOutcome<S = unknown> {
  readonly state: S;
  readonly stopReason: LoopStopReason;
  readonly iterations: number;
}

/**
 * Per-cycle observability report emitted after each completed cycle when `onCycle` is set. The
 * `measure` comes from the loop variant (the L05 manifest projection), so a record fed straight to
 * `WorkflowMonitor.recordCycle` stays consistent with the termination variant (spec
 * execution-observability). `usage` omitted ⇒ the backend reported none this cycle.
 */
export interface LoopCycleReport {
  readonly iteration: number;
  readonly measure: number;
  readonly usage?: Usage;
}

/** Flow setup supplied to a run; `overrides` is how tests inject fake accessors (flow-runtime spec). */
export interface LoopRunOptions {
  readonly args?: readonly string[];
  readonly overrides?: FlowOverrides;
  /** Optional observability hook; receives a {@link LoopCycleReport} after each completed cycle. */
  readonly onCycle?: (cycle: LoopCycleReport) => void;
}

/** A `.run()` fails either at build (unguarded back-edge) or at runtime (a step/reason error). */
export type LoopRunError = RuntimeError | TerminationContractError;

/**
 * Chainable loop builder. The single-cycle case reads like a guarded `while` and needs no
 * graph/fan-out/Effect knowledge. `.reason()` is the single LLM verb; `.step()` is a
 * deterministic transform; `.measure()`/`.until()` set the termination variant; `.guard()`
 * adds seatbelts. `.run()` lowers to `flow()` + generic `fixLoop()`.
 */
export interface LoopBuilder<S = unknown> {
  /** The single LLM verb. Drives a backend autonomously each cycle; hides the conversation. */
  reason<B extends BackendTag, Output = unknown>(
    backend: LlmBackend<B>,
    request: AutonomousRequest<Output, B>
  ): LoopBuilder<S>;
  /** A deterministic step that transforms the threaded loop state. */
  step(name: string, body: (state: S) => Promise<S> | S): LoopBuilder<S>;
  /** Power-user variant override (design D3); takes precedence over a preset. */
  measure(fn: (state: S) => Promise<number> | number): LoopBuilder<S>;
  /** Set the termination variant from a preset archetype or a custom variant. */
  until(termination: TerminationPreset<S> | LoopVariant<S>): LoopBuilder<S>;
  /** Layer seatbelt guards under the variant. */
  guard(opts: LoopGuards): LoopBuilder<S>;
  /** Build (enforcing the termination contract) then run; returns the outcome and a stop reason. */
  run(initial?: S, options?: LoopRunOptions): Promise<Result<LoopOutcome<S>, LoopRunError>>;
}

/** State projection read by the `untilGatesGreen` preset. */
export interface GatesState {
  /** Failing tests/gates remaining; the loop converges as this reaches `0`. */
  readonly failingGates: number;
}

/** State projection read by the `untilConfident` preset. */
export interface ConfidenceState {
  /** Confidence in `[0, 1]`; the loop converges once it reaches the threshold. */
  readonly confidence: number;
}
