---
title: State Stores
description: The StateStore port — load, checkpoint, branch, merge, history — with snapshot and sqlite adapters, all Result-typed over RuntimeError.
---

Loop state is a manifest, not a human plan file. It is the runtime state that a loop checkpoints and replays. Stores implement the `StateStore<S>` port (defined in `src/loop/state/port.ts`); every method is `Result`-typed over `RuntimeError` (see [Runtime Errors](../runtime-errors/)). Signatures are transcribed from `src/loop/state/` and verified by `bun run docs:symbols`.

## `StateStore<S>` port

```ts
type StateHash = string;
type StateReducer<S> = (states: readonly S[]) => S;

interface StateStore<S = TaskManifest> {
  load(hash?: StateHash): Promise<Result<S, RuntimeError>>;
  checkpoint(state: S): Promise<Result<StateHash, RuntimeError>>;
  branch(from: StateHash): Promise<Result<StateHash, RuntimeError>>;
  merge(branches: readonly StateHash[], reducer: StateReducer<S>): Promise<Result<S, RuntimeError>>;
  history(): Promise<Result<readonly StateHash[], RuntimeError>>;
}

interface BranchWritableStateStore<S = TaskManifest> extends StateStore<S> {
  saveBranch(branch: StateHash, state: S): Promise<Result<StateHash, RuntimeError>>;
}
```

| Method | Returns | Behavior / errors |
| --- | --- | --- |
| `load(hash?)` | `Result<S, RuntimeError>` | Loads state at `hash`, or the latest checkpoint when omitted. `FileSystemError` when no checkpoint exists or the file is unreadable. |
| `checkpoint(state)` | `Result<StateHash, RuntimeError>` | Persists `state`, returns its content hash. `FileSystemError` on write failure. |
| `branch(from)` | `Result<StateHash, RuntimeError>` | Creates an isolated copy of the checkpoint at `from`; returns the new hash. |
| `merge(branches, reducer)` | `Result<S, RuntimeError>` | Loads each branch state and folds them with `reducer` into one `S`. |
| `history()` | `Result<readonly StateHash[], RuntimeError>` | Returns the committed hash lineage. |

`StateHash` is a content-addressed string (a truncated hash of the state). `StateReducer<S>` folds multiple branch states into one during a merge. `BranchWritableStateStore<S>` is the additional capability used by store-backed fan-out when branch results must be persisted without appending to cycle history.

## Shipped adapters

| Store | Signature | Use it when | Behavior |
| --- | --- | --- | --- |
| `createSnapshotStore` | `(options: SnapshotStoreOptions) => BranchWritableStateStore` | You want the simplest default. | Writes one human-readable JSON snapshot per cycle. |
| `createSqliteStore` | `(options: SqliteStoreOptions) => Result<SqliteStore, RuntimeError>` | You need crash recovery or longer-lived history. | Writes a local WAL database and can resume from committed history. |

**`createSqliteStore` returns `Result`, not a bare `SqliteStore`.** Construction can fail — it returns `Err(RuntimeError)` on file/lease problems rather than throwing. Always handle the `Result` before using the store:

```ts
import { createSqliteStore } from "@twelvehart/orca-ts";

const made = createSqliteStore({ path: ".orca/state.db" });
if (made.isErr()) {
  // made.error is a RuntimeError (e.g. FileSystemError, IoFailed)
  console.error(made.error._tag);
  process.exit(1);
}
const store = made.value;
const loaded = await store.load();
```

`branch(from)` creates an isolated copy of a checkpoint. `BranchWritableStateStore.saveBranch(branch, state)` writes a branch result by hash without changing `history()` or the default `load()` head. `merge(branches, reducer)` folds branch snapshots back into one state. Store-backed loop fan-out starts from a checkpoint hash, calls `branch()` once per branch, saves successful branch states, then calls `merge()` exactly once at fan-in through the selected reducer. Pure `fanOut`/`fanIn` remains available when only bounded summaries need to stay in memory.
