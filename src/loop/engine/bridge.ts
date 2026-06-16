// Boundary bridge (design D2). Effect lives only inside src/loop/engine/**; everything that
// crosses to the public API or the flow-authoring surface is a neverthrow `Result` or a plain
// value. This module is the only seam between the two worlds:
//   - inward   : Result  -> Effect            via result.match(Effect.succeed, Effect.fail)
//   - outward  : Effect   -> Effect<Result>   via Effect.either + Either.match
//   - boundary : Effect   -> Promise<Result>  (the single place an engine Effect is *run*)
// The facade gate (scripts/check-facade-gate.ts) skips src/loop/engine/**, so the Effect
// types named here never reach a scanned declaration.
import { Cause, Effect, Either, Exit } from "effect";
import { err, ok, type Result } from "neverthrow";

/** Inward bridge: lift a neverthrow `Result` into the Effect world. */
export function fromResult<A, E>(result: Result<A, E>): Effect.Effect<A, E> {
  return result.match(
    (value): Effect.Effect<A, E> => Effect.succeed(value),
    (error): Effect.Effect<A, E> => Effect.fail(error),
  );
}

/** Outward bridge: collapse an Effect's typed failure channel into a `Result`, still inside Effect. */
export function toResult<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Result<A, E>> {
  return Effect.either(effect).pipe(
    Effect.map((either) => Either.match(either, { onLeft: (e) => err(e), onRight: (a) => ok(a) })),
  );
}

export interface RunOptions {
  /** When provided, aborting the signal interrupts the run; the resulting interruption becomes `err`. */
  readonly signal?: AbortSignal;
}

/**
 * Boundary runner — the single place an engine Effect is executed. Returns a `Result` and never
 * throws an Effect, `Cause`, or interruption: typed failures become `err`, and interruption /
 * defects are squashed into `err`, so no Effect type or `Cause` escapes the facade.
 *
 * Note on cancellation: engine work that wants a graceful `cancelled` outcome wires its own
 * `AbortSignal` through `runCancellable` (which converts cancellation into a success value).
 * The `signal` here is the blunt alternative — hard interruption surfaced as `err`.
 */
export async function runToResult<A, E>(
  effect: Effect.Effect<A, E>,
  options: RunOptions = {},
): Promise<Result<A, E | Error>> {
  const exit = await Effect.runPromiseExit(effect, options.signal ? { signal: options.signal } : undefined);
  return Exit.match(exit, {
    onSuccess: (value): Result<A, E | Error> => ok(value),
    onFailure: (cause): Result<A, E | Error> => {
      const failure = Cause.failureOption(cause);
      return failure._tag === "Some" ? err(failure.value) : err(causeToError(cause));
    },
  });
}

function causeToError(cause: Cause.Cause<unknown>): Error {
  if (Cause.isInterruptedOnly(cause)) {
    return new Error("loop engine run was interrupted");
  }
  const squashed = Cause.squash(cause);
  return squashed instanceof Error ? squashed : new Error(String(squashed));
}
