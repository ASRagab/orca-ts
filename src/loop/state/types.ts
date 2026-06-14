import type { Result } from "neverthrow";

// Loop state is a typed manifest behind a pluggable StateStore port (design D4).
// Zod schema, measure/progress projection, and the snapshot adapter land in
// L05 (tasks 2.1-2.5). This file is the Effect-free, Result-typed type spine only.

/** Content hash identifying a per-cycle state snapshot. */
export type StateHash = string;

/** A single atomic subtask in the manifest; `passes` is the progress flag (Ralph pattern). */
export interface ManifestTask {
  readonly id: string;
  readonly passes: boolean;
}

/** Typed loop manifest — the single progress/variant/monitor spine (design D4). */
export interface TaskManifest {
  readonly tasks: readonly ManifestTask[];
}

/** Service-free-by-default adapters (design D4). `dbos`/`dolt` are deferred. */
export type StateAdapterId = "snapshot" | "sqlite";

/**
 * StateStore port — `load / checkpoint / branch / merge / history`, all Result-typed.
 * branch = fan-out copy, merge = fan-in reducer, history = monitor stream (design D4).
 * TODO(L05, tasks 2.1-2.4): finalize the error type and ship the snapshot adapter.
 */
export interface StateStore<S = TaskManifest> {
  load(hash?: StateHash): Promise<Result<S, Error>>;
  checkpoint(state: S): Promise<Result<StateHash, Error>>;
  branch(from: StateHash): Promise<Result<StateHash, Error>>;
  merge(branches: readonly StateHash[], reducer: (states: readonly S[]) => S): Promise<Result<S, Error>>;
  history(): Promise<Result<readonly StateHash[], Error>>;
}
