---
title: Workflow Execution Troubleshooting
description: Diagnose saved workflow failures and non-convergence.
---

Classify failures from evidence:

| Class | Signal |
| --- | --- |
| Environment | Backend CLI crash, missing auth, or non-zero exit before useful agent output. |
| Gate failure | A test, lint, or build command failed and the flow is repairing. |
| Non-convergence | A loop or fix loop hit `stuck`, `timeout`, or `ceiling`. |
| Crash | Partial state or commits exist but the process died mid-flow. |
| Served child | `orca serve` stays alive while one child firing fails. |

Recovery steps:

1. Re-run the backend doctor for environment failures.
2. Let gate failures continue until they converge or hit a guard.
3. Re-run after crashes when persistent plans or state stores are present.
4. Reproduce served-child failures with `ORCA_LOOP_EVENT='...' orca run <loop>`.

Stop and ask before destructive git operations.
