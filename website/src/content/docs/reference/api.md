---
title: Public API
description: Main exported modules and user-facing helpers.
---

The package root re-exports the public runtime surface:

```ts
import {
  codex,
  err,
  flow,
  flowArgs,
  llm,
  ok,
  selectBackend,
  z
} from "orca-ts";
```

Common entry points:

| Surface | Use |
| --- | --- |
| `flow()` | Create a direct-style flow context. |
| `flowArgs()` | Read task tokens passed after CLI `--`. |
| `llm()` | Start autonomous conversations through a backend. |
| `selectBackend()` | Honor `ORCA_BACKEND` and backend-specific config. |
| `claude()`, `codex()`, `opencode()`, `pi()` | Pin a backend directly. |
| `loop()` | Build repeated-work cycles. |
| `defineLoop()` | Package a loop module for discovery, run, and serve. |
| `ok`, `err`, `Result` | Build and type Result values without depending on `neverthrow`. |
| `z` | Use the same Zod export for structured-output schemas. |

Loop authoring can also import from `orca-ts/loop`, and model/testing helpers are exposed through `orca-ts/model` and `orca-ts/testing`.

Effect remains behind the loop facade and is not part of the public API.
