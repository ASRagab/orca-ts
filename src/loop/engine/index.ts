// INTERNAL loop engine — Effect lives here and ONLY here (design D2 facade gate).
// Scheduling (`Schedule`), bounded structured concurrency (`Effect.all({concurrency})`,
// `Fiber`/`Scope`), and structured cancellation land in L04 (tasks 3.1-3.5).
//
// This module is intentionally NOT re-exported by ../index.ts and is explicitly EXEMPT
// from the facade gate (scripts/check-facade-gate.ts skips src/loop/engine/**). Importing
// Effect here also confirms the dependency resolves and typechecks under Bun.
import { Effect } from "effect";

/** Internal engine effect alias — bridged to a neverthrow `Result` at the public boundary. */
export type EngineEffect<A> = Effect.Effect<A, Error>;

/** Placeholder until the real Effect engine lands (L04, task 3.1). */
export function notImplemented(): EngineEffect<never> {
  return Effect.fail(new Error("loop engine not implemented (L04)"));
}
