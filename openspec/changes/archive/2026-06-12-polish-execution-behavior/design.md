# Design — Polish Execution Behavior

## Context

`workflows/ai-slop-cleanup.ts` is the load-bearing dogfood workflow. It runs baseline validation, asks one backend to clean one file, runs targeted validation, optionally repairs, commits by group, runs final `bun run verify`, and optionally publishes. The workflow can already emit a monitor log, but the current log is file-level and the `WorkflowMonitor.stage()` / `recordFailure()` APIs are mostly unused.

Backend execution has uneven boundedness. OpenCode already has an inactivity watchdog and absolute wall-clock race around most of `runOpenCodeConversation`, but the default server startup path has no explicit startup timeout and `OpenCodeHttp.postJson()` cannot receive an abort signal. Claude, Codex, and Pi share `runSubprocessConversation()`, which handles cancellation and terminal-event process kill, but has no inactivity or wall-clock timeout. Runtime command execution in `src/tools/process.ts` accepts an external `AbortSignal`, but `CommandTool.run()` exposes no timeout or duration in its public result.

The safe validation shape should stay conservative until telemetry proves otherwise: CLI typecheck, workflow baseline full gate, per-file targeted validation, and final verify overlap by design. This change makes those costs measurable before any de-duplication.

## Goals / Non-Goals

**Goals:**

- Make backend turns and validation commands fail explicitly on timeout rather than hanging silently.
- Attribute wall time to named workflow stages, command runs, agent turns, validation attempts, repair attempts, commits, final verify, and publish/no-publish.
- Preserve backend-neutral conversation results while adding timeout behavior behind existing backend options and defaults.
- Produce monitor JSON that can compare backend/file/stage runs before and after implementation.
- Cover fake hang paths deterministically before running live smoke or dogfood workloads.

**Non-Goals:**

- Removing baseline or final full validation gates in the same change.
- Changing the public `Conversation` contract shape unless timeout metadata is already carried through existing failed outcomes.
- Adding external observability dependencies, daemons, or background reporters.
- Solving upstream model/tool stalls; Orca should bound, report, and abort them.

## Decisions

### D1: Use one monotonic timing helper for monitor stages and command summaries

Introduce a small local timing helper based on `performance.now()` or `Date.now()` and store integer `durationMs` in existing JSON structures. `WorkflowMonitor.stage(name, fn)` remains the wrapper for coarse stages; command-level summaries get their own duration field so slow validation is visible even inside a larger stage.

Alternative considered: emit free-form log lines only. Rejected because the existing `scripts/summarize-run.ts` already consumes structured monitor JSON and can be extended without parsing text.

### D2: Extend command results rather than adding a parallel timed-command API

`VerificationCommand` should accept an optional timeout (`timeoutMs`) and `VerificationCommandResult` should include `durationMs`; timeout returns the existing `failed` variant with `exitCode: null` and a stderr/message that names the timeout. `runQuiet()` owns timer setup and child kill so direct callers and `CommandTool.run()` share behavior.

Alternative considered: keep `runQuiet()` unchanged and time commands only in `ai-slop-cleanup.ts`. Rejected because hangs below the workflow layer would still require every caller to reinvent kill/timer/error handling.

### D3: Add bounded execution to `runSubprocessConversation()` once for Claude/Codex/Pi

Add optional `inactivityTimeoutMs` and `wallClockTimeoutMs` to `RunSubprocessOptions`, defaulted by each backend accessor. The helper races stdout-line consumption and final process exit against these timers. On timeout it kills the process, fails the conversation with `backendFailed(backend, ...)`, drains captured stderr best-effort where already available, and returns without calling `consumer.finish()`.

Alternative considered: implement watchdogs in each backend driver. Rejected because subprocess spawn, stdout splitting, stderr capture, and terminal-event process kill are intentionally centralized in `runSubprocessConversation()`.

### D4: Close OpenCode abortability gaps without replacing its existing watchdog design

Keep the existing OpenCode inactivity and wall-clock behavior. Add explicit startup-timeout handling around `defaultStartServer()` and thread `AbortSignal` through `OpenCodeHttp.postJson(path, body, signal?)` so `/session`, `/prompt_async`, and abort-related POSTs cannot continue after the conversation has failed or been cancelled. The shared server still survives a cancelled turn; only wedged startup kills the spawned `opencode serve` process.

Alternative considered: restart the shared OpenCode server after every timeout. Rejected because timeouts can be turn-local, and unconditional restart would make slow-but-valid follow-up diagnosis harder.

### D5: Monitor the dogfood workflow at semantic boundaries

Wrap these boundaries with `monitor.stage()`: clean-worktree/branch setup, baseline validation, per-file cleanup, per-file agent turn, per-file validation, repair attempt, group commit, final verify, PR-body write, push, and PR create. `recordOutcome()` receives verdict, duration, validation runs, repair iterations, touched paths, and token totals where available. `recordFailure()` is used for thrown per-file failures so monitor summary matches terminal behavior.

Alternative considered: only record one file-level outcome. Rejected because the plan needs to distinguish agent time from validation time and command hangs from backend hangs.

### D6: Keep validation de-duplication as a measured experiment, not an implementation default

The implementation should keep current full gates and add enough telemetry to compare `targeted test + typecheck + lint` against `targeted test + lint changed files` in later dogfood runs. Any de-duplication must be a follow-up change or a clearly guarded option after the monitor shows no hidden cross-file breakage.

Alternative considered: immediately remove per-file typecheck. Rejected because the existing overlap is expensive but safe, and correctness has priority over wall-time savings.

### D7: Tests model hangs with fake processes and fake transports

Use fake subprocess stdout streams that never yield, yield continuously without terminal events, and exit without settlement. Use fake OpenCode `startServer` / `postJson` promises that never resolve. Use fake command spawners for never-closing validation processes. These tests verify timeout outcome shape and child kill/abort behavior without live credentials.

Alternative considered: validate only with live backend smoke. Rejected because live hangs are slow, flaky, and cannot reliably assert exact failure messages.

## Risks / Trade-offs

- [Timeout defaults too short for legitimate slow models] → Use conservative defaults, expose backend options, and make timeout messages include the configured threshold.
- [Timer races produce double settlement] → Check conversation/consumer abort state before `fail()` / `finish()` and centralize timeout settlement in each helper.
- [Killing subprocesses can discard late stderr] → Capture stderr continuously and include what is available; timeout failure should prefer explicit timeout attribution over waiting forever.
- [Monitor schema changes break summarization] → Update `WorkflowRunLog` types, monitor tests, and `scripts/summarize-run.ts` in the same change.
- [Extra timing code obscures workflow logic] → Keep wrappers at semantic boundaries and avoid per-line/per-token telemetry in the workflow layer.

## Migration Plan

This is an internal runtime behavior change with no data migration. Defaults preserve existing command and backend APIs except for additive result fields and timeout options. Rollback is reverting the change; monitor JSON generated by the new schema may not be readable by the old summarizer, so the summarizer changes ship atomically with the schema.

## Open Questions

- Exact default timeout values for subprocess backends should be chosen during implementation after inspecting existing backend tests and expected live smoke duration.
- Token usage aggregation depends on what each backend emits in normalized events; missing usage should remain absent, not synthesized.
