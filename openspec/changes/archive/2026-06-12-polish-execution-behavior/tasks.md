## 1. Command execution timing and timeout support

- [x] 1.1 Extend `QuietProcOptions`, `VerificationCommand`, and `VerificationCommandResult` with timeout and `durationMs` fields
- [x] 1.2 Implement `runQuiet()` timeout handling with child kill, null exit code, captured output, and timeout-specific failure text
- [x] 1.3 Thread command duration and timeout results through `createCommandTool()` without changing success/failure variants
- [x] 1.4 Update workflow `CommandRunSummary`, PR-body rendering, and affected tests for command `durationMs`

## 2. Subprocess backend watchdogs

- [x] 2.1 Add `inactivityTimeoutMs` and `wallClockTimeoutMs` options to `RunSubprocessOptions`
- [x] 2.2 Implement shared inactivity timeout in `runSubprocessConversation()` that fails the conversation and kills the process
- [x] 2.3 Implement shared wall-clock timeout in `runSubprocessConversation()` that cannot be reset by continuous non-terminal output
- [x] 2.4 Thread conservative default timeout values through Codex, Claude, and Pi backend constructors
- [x] 2.5 Add focused fake-process tests for silent stdout stall, continuous stdout, normal terminal completion, and timeout kill behavior

## 3. OpenCode startup and POST abortability

- [x] 3.1 Add `startupTimeoutMs` to `OpenCodeBackendOptions` and enforce it in `defaultStartServer()`
- [x] 3.2 Kill the spawned `opencode serve` process when startup times out before a listening URL is observed
- [x] 3.3 Extend `OpenCodeHttp.postJson()` to accept an optional `AbortSignal`
- [x] 3.4 Thread the conversation/turn abort signal through OpenCode session creation, prompt submission, and abort POST calls
- [x] 3.5 Add fake OpenCode tests for never-resolving `startServer`, never-resolving POST, cancellation, and existing successful-turn behavior

## 4. Workflow monitor instrumentation

- [x] 4.1 Extend `WorkflowRunLog`, `OutcomeLog`, `FailureLog`, and related exported types with changed paths, validation runs, failure category, repair count, and optional usage fields
- [x] 4.2 Wrap cleanup workflow setup, baseline validation, per-file cleanup, group commit, final verify, PR-body write, push, and PR create in `monitor.stage()`
- [x] 4.3 Time agent turns, targeted validation, and repair attempts inside per-file cleanup and return those measurements to the caller
- [x] 4.4 Record monitor outcomes for changed, skipped, no-op, guard-reject, regressed, repaired, and precondition-skip paths with accurate durations and reasons
- [x] 4.5 Record thrown per-file failures with `recordFailure()` before propagating or continuing according to existing workflow behavior
- [x] 4.6 Update `scripts/summarize-run.ts` to report backend totals, slowest stages, slowest files, failure categories, repair counts, and usage when present

## 5. Validation harness updates

- [x] 5.1 Add deterministic monitor schema tests for stages, outcomes, failures, summary counts, optional usage, and summarizer output
- [x] 5.2 Update backend tests for timeout result shape and no double-settlement on success/failure/cancel races
- [x] 5.3 Update `tests/tools.test.ts` for successful command duration, non-zero duration, and timed-out command behavior
- [x] 5.4 Update live backend smoke to capture wall time, outcome type, event count, session identifier presence, and emitted usage metadata
- [x] 5.5 Run the focused narrow gate: backend tests, tools tests, and workflow harness tests named by `.orca/execution-polish-validation-plan.md`
- [x] 5.6 Run `bun run typecheck`, `bun test`, and `bun run verify`

## 6. Dogfood evidence and cleanup

- [x] 6.1 Refresh CodeGraph index before implementation if it still reports stale or missing files
- [x] 6.2 Run opt-in real backend smoke for each locally configured backend and record wall time plus outcome metadata
- [x] 6.3 Run monitored no-publish dogfood for Codex and OpenCode with `--max-files=1`
- [x] 6.4 Compare monitor logs against the baseline plan and document whether validation de-duplication is safe to pursue later
- [x] 6.5 Update README/backend docs so supported live drivers, monitor usage, and validation ladder match implemented behavior
