---
title: Backend Auth Troubleshooting
description: Diagnose missing CLIs, expired auth, and backend setup failures.
---

Run the backend doctor through the setup skill or directly from a checked-out skill:

```bash
bash skills/orca-ts-setup/scripts/orca-doctor.sh --backend codex
```

Status meanings:

| Status | Meaning |
| --- | --- |
| `ready` | CLI is present and auth is confirmed. |
| `unverified` | CLI works, but auth cannot be proven without a live smoke. |
| `unauth` | CLI is present but not authenticated. |
| `missing` | CLI is not on `PATH`. |
| `misconfig` | CLI is present but broken. |

Use backend-specific login tools such as `codex login`, `opencode auth login`, Claude login/setup, or Pi credentials, then rerun the doctor.

For Claude and Pi, the definitive proof is the opt-in live smoke because there is no safe non-spending auth check.
