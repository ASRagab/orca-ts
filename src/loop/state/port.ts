import type { Result } from "neverthrow";
import type { RuntimeError } from "../../model/index.ts";
import type { TaskManifest } from "./manifest.ts";

// The StateStore port is the single seam for loop state (design D4). Loop code
// targets this interface; swapping the adapter (snapshot -> sqlite -> ...) never
// changes the loop definition. branch/merge/history are first-class operations:
// fan-out = branch, fan-in = merge, monitoring = history.

/** Content hash identifying a per-cycle state snapshot. */
export type StateHash = string;

/** Service-free-by-default adapters (design D4). `dbos`/`dolt` stay deferred but
 * the port shape keeps them expressible. */
export type StateAdapterId = "snapshot" | "sqlite";

/** Fan-in merge: the ONLY place branch state combines (event-sourced/reduce,
 * never shared-mutable). */
export type StateReducer<S> = (states: readonly S[]) => S;

/**
 * StateStore port — `load / checkpoint / branch / merge / history`, all
 * Result-typed over `RuntimeError`. Default state is the {@link TaskManifest}.
 */
export interface StateStore<S = TaskManifest> {
  /** Read a snapshot by hash, or the most recent checkpoint when omitted. */
  load(hash?: StateHash): Promise<Result<S, RuntimeError>>;
  /** Validate and persist a cycle's state, returning its content hash. */
  checkpoint(state: S): Promise<Result<StateHash, RuntimeError>>;
  /** Fan-out: copy a snapshot into an isolated branch handle. */
  branch(from: StateHash): Promise<Result<StateHash, RuntimeError>>;
  /** Fan-in: combine branch snapshots through the reducer (the only merge point). */
  merge(branches: readonly StateHash[], reducer: StateReducer<S>): Promise<Result<S, RuntimeError>>;
  /** Monitoring: the ordered hashes of prior cycle snapshots. */
  history(): Promise<Result<readonly StateHash[], RuntimeError>>;
}
