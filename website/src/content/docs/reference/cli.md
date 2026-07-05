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

`orca run` and served child execution share the same firing contract: event decoding, `defineLoop().run(event)`, sink emission, diagnostics, and stop-reason exit-code mapping. `ORCA_LOOP_EVENT` is the CLI/supervisor envelope for reproducing one firing; custom Source and Sink adapters should not read it directly.

| Option | Meaning |
| --- | --- |
| `--backend <name>` | Validates the backend tag and sets `ORCA_BACKEND`. |
| `--no-typecheck` | Skips the `tsc --noEmit` preflight and sets `ORCA_TYPECHECK_SKIPPED=1`. |
| `--version`, `-v` | Prints the embedded Orca version. |
| `--help`, `-h` | Prints usage. |
| `-- <task args>` | Passes task input to `flowArgs()`. |

## Run output

`orca <flow.ts>` and `orca run <loop>` render concise progress on stderr from structured run-output events: preflight status, stage progress, loop cycle progress, artifacts, and the final outcome. Non-TTY and CI output is plain line-oriented text; TTY output may use color when `NO_COLOR` is not set.

Stdout is reserved for explicit flow output and loop sink payloads. A `stdout()` sink or `console.log()` in a flow should not be mixed with progress diagnostics.

Valid backend tags are `claude`, `codex`, `opencode`, and `pi`.

## Loop exit codes

`orca run` and `orca serve` map each loop stop reason to a process exit code via `exitCodeForStop(reason)`, exported from the loop surface. A build or runtime error that prevents the loop from running exits `70`.

| Stop reason | Exit code | Meaning |
| --- | --- | --- |
| `converged` | `0` | Termination condition met. |
| `unfixable` | `1` | The loop concluded the issue cannot be fixed. |
| `stuck` | `2` | No progress across cycles. |
| `timeout` | `3` | Wall-clock guard expired. |
| `ceiling` | `4` | Iteration ceiling reached without convergence. |
| `budget-exhausted` | `5` | Token budget guard exhausted. |
| `cancelled` | `6` | Cancelled via signal or `cancel()`. |
| (build/runtime error) | `70` | The loop failed to run at all. |
