---
title: State Stores
description: Snapshot and sqlite adapters for loop checkpoints, history, branch, and merge.
---

Loop state is a manifest, not a human plan file. It is the runtime state that a loop checkpoints and replays.

The `StateStore` port exposes:

- `load`
- `checkpoint`
- `branch`
- `merge`
- `history`

## Shipped adapters

| Store | Use it when | Behavior |
| --- | --- | --- |
| `createSnapshotStore({ root })` | You want the simplest default. | Writes one human-readable JSON snapshot per cycle. |
| `createSqliteStore({ path })` | You need crash recovery or longer-lived history. | Writes a local WAL database and can resume from committed history. |

`branch(from)` creates an isolated copy of a checkpoint. `merge(branches, reducer)` folds branch summaries back into one state.

DBOS and Dolt are deferred and are not selectable adapters in this release.
