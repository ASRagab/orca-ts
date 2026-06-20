// INTERNAL loop engine — Effect lives here and ONLY here (design D2 facade gate).
//
// Public/authoring code never imports this module: src/loop/index.ts does NOT re-export it,
// and the facade gate (scripts/check-facade-gate.ts) skips src/loop/engine/**. Everything
// that crosses back out goes through ./bridge.ts as a neverthrow `Result`/plain value.
//
// This provides the three primitives the builder (L06) and fan-out / fan-in (L07) lower onto:
//   1. recurrence with variant-stop    — runRecurrence  (variant floor ∩ ceiling)
//   2. bounded structured concurrency  — runBranches    (Effect.all { concurrency })
//   3. structured cancellation         — runCancellable (raceFirst → interrupt in-flight work)
// plus internal Layer-based DI that resolves the plain FlowContext snapshot captured at the
// boundary, without exposing any Effect type to the authoring accessors (design D2).
import { Context, Effect, Layer } from "effect";
import type { LoopStopReason } from "../builder/types.ts";
import type { Result } from "neverthrow";
import { currentFlowContext, type FlowContext } from "../../flow/context.ts";
import { runToResult } from "./bridge.ts";

export * from "./bridge.ts";

/** Engine-internal outcome; the builder (L06) maps this to the public Effect-free `LoopOutcome`. */
export interface EngineOutcome<S> {
  readonly state: S;
  readonly stopReason: LoopStopReason;
  readonly iterations: number;
  readonly measure: number;
}

/** One loop iteration as an internal Effect; the builder bridges plain step bodies inward via `fromResult`. */
export type IterationStep<S, R = never> = (state: S, iteration: number) => Effect.Effect<S, Error, R>;

export interface RecurrenceSpec<S, R = never> {
  readonly initial: S;
  readonly iterate: IterationStep<S, R>;
  /** Loop variant (design D3): a measure bounded below that the loop drives toward `floor`. */
  readonly measure: (state: S) => number;
  /** Convergence floor; default 0. */
  readonly floor?: number;
  /** Iteration-ceiling seatbelt; default unbounded (termination then rests on the variant). */
  readonly maxIterations?: number;
}

/**
 * Drive a stateful loop to convergence. The body runs at least once; the variant measure is
 * checked after each iteration against the convergence floor and iteration ceiling, so whichever
 * limit trips first stops the loop — `converged` when the measure won, `ceiling` otherwise.
 */
export function runRecurrence<S, R = never>(spec: RecurrenceSpec<S, R>): Effect.Effect<EngineOutcome<S>, Error, R> {
  const floor = spec.floor ?? 0;
  const maxIterations =
    spec.maxIterations === undefined || !Number.isFinite(spec.maxIterations)
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(spec.maxIterations));

  const recur = (state: S, iterations: number): Effect.Effect<EngineOutcome<S>, Error, R> =>
    Effect.suspend(() => {
      const measure = spec.measure(state);
      if (iterations > 0 && measure <= floor) {
        return Effect.succeed({ state, stopReason: "converged", iterations, measure });
      }
      if (iterations > 0 && iterations >= maxIterations) {
        return Effect.succeed({ state, stopReason: "ceiling", iterations, measure });
      }
      return spec.iterate(state, iterations).pipe(Effect.flatMap((next) => recur(next, iterations + 1)));
    });

  return recur(spec.initial, 0);
}

export interface BranchesSpec<A> {
  readonly branches: readonly Effect.Effect<A, Error>[];
  /** Bounded fan-out width (design D2/D8: in-process, ~3-10). */
  readonly concurrency: number;
}

/**
 * Run branches with bounded structured concurrency. This is the single concurrency primitive
 * L07's `fanOut`/`fanIn` build on: interrupting the parent fiber interrupts every in-flight
 * branch automatically (Effect structured concurrency), which is what `runCancellable` exploits.
 */
export function runBranches<A>(spec: BranchesSpec<A>): Effect.Effect<readonly A[], Error> {
  return Effect.all(spec.branches, { concurrency: spec.concurrency });
}

/**
 * Plain-boundary bounded fan-out — the Effect-free seam L07's `fanOut` builds on (design D2). Each
 * thunk is a self-contained unit of branch work that resolves to its own outcome value and MUST
 * NOT reject: the caller captures branch success/failure AS DATA so a partial-failure policy can
 * weigh it, and a thunk that throws anyway is squashed into the outer `err`. Branches run with the
 * given concurrency cap (`runBranches` ⇒ `Effect.all { concurrency }`); an aborted `signal` hard-
 * interrupts every in-flight branch via structured concurrency and surfaces as `err`. Returning a
 * `Result` here means `src/loop/fanout.ts` never names an Effect type — Effect stays in the engine.
 */
export async function runBoundedBranches<A>(
  thunks: readonly (() => Promise<A>)[],
  concurrency: number,
  signal?: AbortSignal,
): Promise<Result<readonly A[], Error>> {
  const branches = thunks.map((thunk) =>
    Effect.tryPromise({
      try: () => thunk(),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }),
  );
  return runToResult(runBranches({ branches, concurrency }), signal === undefined ? {} : { signal });
}

/**
 * Make a unit of engine work cancellable by an `AbortSignal`. When the signal fires, the cancel
 * branch wins the race and the `work` fiber — together with any in-flight fan-out children under
 * it — is interrupted via structured concurrency; `onCancel()` then produces a `cancelled`
 * outcome (it is a thunk so the caller can fold in last-known/partial state). With no signal the
 * work runs unchanged.
 */
export function runCancellable<S>(
  work: Effect.Effect<EngineOutcome<S>, Error>,
  onCancel: () => EngineOutcome<S>,
  signal?: AbortSignal,
): Effect.Effect<EngineOutcome<S>, Error> {
  if (signal === undefined) {
    return work;
  }
  const cancelled = abortEffect(signal).pipe(Effect.map(onCancel));
  return Effect.raceFirst(work, cancelled);
}

function abortEffect(signal: AbortSignal): Effect.Effect<undefined> {
  return Effect.async<undefined>((resume) => {
    if (signal.aborted) {
      resume(Effect.succeed(undefined));
      return;
    }
    const onAbort = (): void => {
      resume(Effect.succeed(undefined));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

// --- Internal Layer-based DI (design D2): Layer DI inside the engine, plain accessors outside. ---

/** Engine-internal DI tag carrying the plain `FlowContext` snapshot. */
export const FlowContextTag = Context.GenericTag<FlowContext>("orca/loop/FlowContext");

/** Build a Layer providing a captured `FlowContext` snapshot to engine effects. */
export function flowContextLayer(context: FlowContext): Layer.Layer<FlowContext> {
  return Layer.succeed(FlowContextTag, context);
}

/**
 * Provide the ambient flow context to an engine effect. The snapshot is read with the plain,
 * Effect-free `currentFlowContext()` accessor at the boundary and handed to the engine as a
 * Layer — so DI is Effect `Layer` internally while the authoring accessors stay plain.
 */
export function withAmbientFlowContext<A, E>(effect: Effect.Effect<A, E, FlowContext>): Effect.Effect<A, E> {
  return Effect.provide(effect, flowContextLayer(currentFlowContext()));
}

// In-engine equivalents of the plain fs()/git()/llm() authoring accessors, resolved from the
// Layer. The public accessors stay Effect-free; these never leave src/loop/engine/**.
export const engineFs = Effect.map(FlowContextTag, (context) => context.fs);
export const engineGit = Effect.map(FlowContextTag, (context) => context.git);
export const engineLlm = Effect.map(FlowContextTag, (context) => context.llm);
