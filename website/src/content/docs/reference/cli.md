---
title: CLI
description: Commands, flags, and task-argument behavior.
---

```bash
orca [--backend <name>] [--no-typecheck] <flow.ts> [-- <task args>]
orca run <loop>
orca serve <loop>
orca loops
orca --version
```

| Command | Meaning |
| --- | --- |
| `<flow.ts>` | Import and run a self-executing flow script. |
| `run <loop>` | Run one loop firing; target is a module path or registered loop name. |
| `serve <loop>` | Host a loop trigger and spawn one child process per firing. |
| `loops` | Discover loops from `.orca/loops/` without firing them. |

| Option | Meaning |
| --- | --- |
| `--backend <name>` | Validates the backend tag and sets `ORCA_BACKEND`. |
| `--no-typecheck` | Skips the `tsc --noEmit` preflight and sets `ORCA_TYPECHECK_SKIPPED=1`. |
| `--version`, `-v` | Prints the embedded Orca version. |
| `--help`, `-h` | Prints usage. |
| `-- <task args>` | Passes task input to `flowArgs()`. |

Valid backend tags are `claude`, `codex`, `opencode`, and `pi`.

Durable service-backed loop flags such as `--durable`, `--postgres-url`, and `--state dbos` are parsed but rejected because DBOS is deferred.
