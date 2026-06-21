---
title: Loop Troubleshooting
description: Stop reasons, stuck loops, budgets, and deferred durable modes.
---

Read the loop stop reason before changing code:

| Stop reason | First check |
| --- | --- |
| `ceiling` | Increase `maxIterations` only if the state is making progress. |
| `timeout` | Inspect the last checkpoint and backend output. |
| `stuck` | Confirm the state transition changes the measured state. |
| `budget-exhausted` | Check whether the backend reports token usage. |
| `unfixable` | Read the failing gate or issue payload. |
| `cancelled` | Check caller or supervisor shutdown. |

If a loop keeps repeating, improve the measure, tighten the state transition, or switch to a purpose-built preset.
