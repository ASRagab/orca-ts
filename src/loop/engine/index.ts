// INTERNAL loop engine — Effect lives here and ONLY here (design D2 facade gate).
//
// Public/authoring code never imports this module: src/loop/index.ts does NOT re-export it,
// and the facade gate (scripts/check-facade-gate.ts) skips src/loop/engine/**. Everything
// that crosses back out goes through ./bridge.ts as a neverthrow `Result`/plain value.
//
// This provides the three primitives the builder (L06) and fan-out / fan-in (L07) lower onto:
//   1. recurrence with variant-stop    — runRecurrence  (Schedule: recurUntil ∩ ceiling)
//   2. bounded structured concurrency  — runBranches    (Effect.all { concurrency })
//   3. structured cancellation         — runCancellable (raceFirst → interrupt in-flight work)
// plus internal Layer-based DI that resolves the plain FlowContext snapshot captured at the
// boundary, without exposing any Effect type to the authoring accessors (design D2).
import { Context, Effect, Layer, Ref, Schedule } from "effect";
import type { LoopStopReason } from "../builder/types.ts";
import { currentFlowContext, type FlowContext } from "../../flow/context.ts";

export * from "./bridge.ts";

/** Engine-internal outcome; the builder (L06) maps this to the public Effect-free `LoopOutcome`. */
export interface EngineOutcome<S> {
  readonly state: S;
  readonly stopReason: LoopStopReason;
  readonly iterations: number;
  readonly measure: number;
}

/** One loop iteration as an internal Effect; the builder bridges plain step bodies inward via `fromResult`. */
export type IterationStep<S> = (state: S, iteration: number) => Effect.Effect<S, Error>;

export interface RecurrenceSpec<S> {
  readonly initial: S;
  readonly iterate: IterationStep<S>;
  /** Loop variant (design D3): a measure bounded below that the loop drives toward `floor`. */
  readonly measure: (state: S) => number;
  /** Convergence floor; default 0. */
  readonly floor?: number;
  /** Iteration-ceiling seatbelt; default unbounded (termination then rests on the variant). */
  readonly maxIterations?: number;
}

/**
 * Drive a stateful loop to convergence. The body runs at least once; the variant measure is
 * fed to a `Schedule` that recurs until the measure reaches its floor, intersected with the
 * iteration ceiling. `Schedule.intersect` continues only while BOTH sub-schedules continue, so
 * whichever limit trips first stops the loop — `converged` when the measure won, `ceiling` otherwise.
 */
export function runRecurrence<S>(spec: RecurrenceSpec<S>): Effect.Effect<EngineOutcome<S>, Error> {
  const floor = spec.floor ?? 0;
  const maxIterations = spec.maxIterations;
  return Effect.gen(function* () {
    const stateRef = yield* Ref.make(spec.initial);
    const iterRef = yield* Ref.make(0);

    const step = Effect.gen(function* () {
      const iteration = yield* Ref.get(iterRef);
      const current = yield* Ref.get(stateRef);
      const next = yield* spec.iterate(current, iteration);
      yield* Ref.set(stateRef, next);
      yield* Ref.update(iterRef, (n) => n + 1);
      return spec.measure(next);
    });

    // The effect runs once before the schedule is consulted, so N iterations == N-1 recurrences.
    const ceiling =
      maxIterations !== undefined && Number.isFinite(maxIterations)
        ? Schedule.recurs(Math.max(0, Math.floor(maxIterations) - 1))
        : Schedule.forever;
    const schedule = Schedule.recurUntil<number>((measure) => measure <= floor).pipe(
      Schedule.intersect(ceiling),
    );

    yield* Effect.repeat(step, schedule);

    const state = yield* Ref.get(stateRef);
    const iterations = yield* Ref.get(iterRef);
    const measure = spec.measure(state);
    const stopReason: LoopStopReason = measure <= floor ? "converged" : "ceiling";
    return { state, stopReason, iterations, measure };
  });
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
export const engineContext: Effect.Effect<FlowContext, never, FlowContext> = FlowContextTag;
export const engineFs = Effect.map(FlowContextTag, (context) => context.fs);
export const engineGit = Effect.map(FlowContextTag, (context) => context.git);
export const engineLlm = Effect.map(FlowContextTag, (context) => context.llm);
