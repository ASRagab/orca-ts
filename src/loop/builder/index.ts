import type { JoinPolicy, LoopBuilder, TerminationPreset } from "./types.ts";

export * from "./types.ts";

// Foundation scaffold: the authoring verbs exist as the public, Effect-free surface but
// throw until L06/L07 implement the lowering to flow() + fixLoop(). No logic yet.
const NOT_IMPLEMENTED = "loop builder not implemented yet (foundation scaffold — see L06/L07)";

/** Entry point for the declarative loop builder. TODO(L06, task 5.1). */
export function loop<S = unknown>(name: string): LoopBuilder<S> {
  void name;
  throw new Error(NOT_IMPLEMENTED);
}

// Preset termination archetypes (design D3 / task 5.2). TODO(L06): real measures + guards.
export function untilGatesGreen(): TerminationPreset {
  throw new Error(NOT_IMPLEMENTED);
}
export function untilManifestComplete(): TerminationPreset {
  throw new Error(NOT_IMPLEMENTED);
}
export function untilNoIssues(): TerminationPreset {
  throw new Error(NOT_IMPLEMENTED);
}
export function untilConfident(threshold: number): TerminationPreset {
  void threshold;
  throw new Error(NOT_IMPLEMENTED);
}
export function times(n: number): TerminationPreset {
  void n;
  throw new Error(NOT_IMPLEMENTED);
}

// Opt-in fan-out / fan-in combinators (design D9 / tasks 6.1-6.2). TODO(L07).
export function fanOut(): never {
  throw new Error(NOT_IMPLEMENTED);
}
export function fanIn(policy: JoinPolicy): never {
  void policy;
  throw new Error(NOT_IMPLEMENTED);
}
