---
title: Workflow Execution Troubleshooting
description: Diagnose saved workflow failures and non-convergence.
---

Classify failures from evidence:

| Class | Signal |
| --- | --- |
| Environment | Backend CLI crash, missing auth, or non-zero exit before useful agent output. |
| Baseline repair | Initial test, lint, or verify gate is red and the generated artifact is repairing it before main work. |
| Gate failure | A test, lint, or build command failed and the flow is repairing. |
| Non-convergence | A loop or fix loop hit `stuck`, `timeout`, or `ceiling`. |
| Crash | Partial state or commits exist but the process died mid-flow. |
| Served child | `orcats serve` stays alive while one child firing fails. |

Recovery steps:

1. Re-run the backend doctor for environment failures.
2. Let baseline repair and gate failures continue until they converge or hit a guard.
3. Re-run after crashes when persistent plans or state stores are present.
4. Reproduce served-child failures with `ORCA_LOOP_EVENT='...' orcats run <loop>`.

Do not retry a dirty-worktree rejection with `--baseline=accept-dirty` unless the operator explicitly asks. That mode writes a dirty baseline snapshot before backend repair work.

Stop and ask before destructive git operations.
