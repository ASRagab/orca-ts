---
title: Monitoring And Recovery
description: Watch saved workflows and loops for real progress.
---

Orca's backend runtime already bounds a single autonomous turn with inactivity and wall-clock limits. Judge workflow health from progress, not slowness alone.

Useful progress signals:

| Signal | Where to look |
| --- | --- |
| Monitoring JSON | `.orca/monitoring/<runId>.json` |
| Persistent plans | `.orca/plan-<hash>.md` |
| Loop state | `.orca/state-<hash>.json` or sqlite history |
| Git progress | `git status` and `git log --oneline -5` |

The dogfood cleanup workflow can write monitoring logs and `scripts/summarize-run.ts` can summarize them by backend, stage, file, repair count, failure, and usage.

Common recovery paths:

- Backend auth or crash: run the backend doctor, re-authenticate, and re-run.
- Gate failure: let the in-flow fix loop iterate unless it reaches a guard.
- Non-convergence: inspect the stop reason, failing gate, and last state.
- Crash with persisted state: re-run the same workflow or loop; recover from the persistent plan or state store.

Never use destructive git operations as automatic recovery. Force-push, history rewrite, broad clean, and branch deletion require explicit human approval.
