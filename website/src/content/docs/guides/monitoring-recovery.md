---
title: Monitoring And Recovery
description: Watch saved workflows and loops for real progress — the monitoring JSON schema, outcome verdicts, and recovery paths.
---

Orca's backend runtime already bounds a single autonomous turn with inactivity and wall-clock limits. Judge workflow health from progress, not slowness alone.

## Progress signals

| Signal | Where to look |
| --- | --- |
| Process progress | stderr and heartbeat/stage events |
| Persistent plans | `.orca/plan-<hash>.md` |
| Loop state | `.orca/state-<hash>.json` or sqlite history |
| Git progress | `git status` and `git log --oneline -5` |
| Terminal summary | `.orca/monitoring/<runId>.json` after termination |

The dogfood cleanup workflow can write monitoring logs and `scripts/summarize-run.ts` can summarize them by backend, stage, file, repair count, failure, and usage.

When a `WorkflowMonitor` is attached, stage, outcome, failure, cycle, and
heartbeat facts feed stderr. During an active run, progress in any live signal
means the run is alive; missing terminal JSON is not a stall or failure. After
termination, JSON is the durable authoritative result. Its final `status` and
`terminalError` win over ambiguous wrapper exit or echo text.

## Monitoring JSON schema

`WorkflowMonitor` (in `src/monitor/index.ts`) records a `WorkflowRunLog`.
`finalize(logDir, finalization)` writes terminal state atomically to
`<logDir>/<runId>.json`; repeated calls share the first finalization.
`.orca/monitoring/` is the caller convention. `writeLog(logDir)` writes an
interim snapshot and leaves the run `running`. The schema:

```ts
interface WorkflowRunLog {
  readonly runId: string;
  readonly startedAt: string;
  readonly backend: string;
  readonly transport?: string;
  readonly status?: "running" | "succeeded" | "failed";
  readonly endedAt?: string;
  readonly currentStage?: string;
  readonly finalStage?: string;
  readonly failedStage?: string;
  readonly terminalError?: TerminalErrorLog;
  readonly stages: readonly StageLog[];
  readonly outcomes: readonly OutcomeLog[];
  readonly failures: readonly FailureLog[];
  readonly summary: WorkflowRunSummary;
  readonly progress: readonly CycleProgress[];
}

interface TerminalErrorLog {
  readonly message: string;
  readonly _tag?: string;
  readonly backend?: string;
  readonly transport?: string;
  readonly phase?: string;
  readonly artifactPath?: string;
  readonly recovery?: string;
}

interface StageLog {
  readonly name: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: "completed" | "failed";
}

interface OutcomeLog {
  readonly file: string;
  readonly verdict: OutcomeVerdict;
  readonly durationMs: number;
  readonly smellsRemoved: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly validation?: readonly CommandLog[]; // gate command results
  readonly reason?: string;
  readonly iterations?: number; // 0 for clean, K for repaired
  readonly regressedReason?: "stuck" | "timeout" | "ceiling"; // only when verdict === "regressed"
  readonly tokens?: number;
  readonly usage?: Usage;
  readonly snapshotPath?: string; // dirty baseline snapshot, when available
}

interface CommandLog {
  readonly command: string;
  readonly exitCode: number;
  readonly status: "passed" | "failed";
}

interface FailureLog {
  readonly file: string;
  readonly error: unknown;
  readonly durationMs: number;
  readonly category?: string;
}

interface WorkflowRunSummary {
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
  readonly preconditionSkip: number;
  readonly durationMs: number;
}

interface CycleProgress {
  readonly iteration: number;
  readonly measure: number;
  readonly delta: number;
  readonly stopReasonSoFar: CycleStopStatus; // LoopStopReason | "running"
  readonly branches?: readonly BranchProgress[];
  readonly cumulativeUsage: TokenUsageSummary;
  readonly contextPressure?: LoopContextPressure;
}
```

`contextPressure` records loop-execution evidence for context management: offload count,
compaction stages, token count before/after compaction, and observation count. Missing
backend usage is still reported as `unknown`, not zero.

Terminal fields are optional only so older logs remain readable. A normally
finalized current run records `status: "succeeded"` or `"failed"`, `endedAt`,
its final stage, backend, and transport. Failure also records `failedStage` and
`terminalError`; backend errors preserve the typed tag, phase, artifact path,
and safe recovery command.

Create the monitor before backend initialization with the intended backend tag
and selected transport. Wrap initialization and meaningful work in
`monitor.stage(...)`; before any stage executes, the stage is `initialize`.
Retain typed backend failures rather than wrapping them in a new `Error`.
After backend shutdown, finalize exactly once in `finally` on success or
failure. Preserve the primary failure if shutdown also fails. Capture a
`WorkflowFinalization` object before cleanup, so even
`throw undefined` is recorded as failed:

```ts
let finalization: WorkflowFinalization = { status: "succeeded" };
try {
  await monitor.stage("implement", async () => { /* work */ });
} catch (error) {
  finalization = { status: "failed", error };
  throw error;
} finally {
  await monitor.finalize(logDir, finalization);
}
```

### Outcome verdicts

`OutcomeVerdict` is a discriminated cleanup verdict. The six values and how they roll up into `WorkflowRunSummary`:

| Verdict | Bucket | Meaning |
| --- | --- | --- |
| `clean` | `pass` | No smells; nothing to change. |
| `repaired` | `pass` | Smells removed; the change now passes the gate. |
| `regressed` | `fail` | The change could not be made to pass; reverted. `regressedReason` says why (`stuck`/`timeout`/`ceiling`). |
| `guard-reject` | `fail` | A guard rejected the change; reverted. |
| `declined` | `skip` | Neutral no-op; the run chose not to act. |
| `precondition-skip` | `preconditionSkip` | Excluded from the pass-rate denominator. |

`pass` = `clean` + `repaired`. `fail` = `regressed` + `guard-reject` + thrown failures. `skip` = `declined`. The pass-rate denominator is `pass + fail + skip` — `preconditionSkip` is reported separately and not counted against the rate.

## Recovery paths

- Backend auth or crash: run the doctor for the recorded backend and transport,
  re-authenticate, prove that same transport ready, and re-run. Never switch
  transports silently.
- Gate failure: let the in-flow fix loop iterate unless it reaches a guard.
- Baseline repair: let the pre-main-work baseline stage iterate unless it reaches
  a guard; report `snapshotPath` when dirty baseline mode was used.
- Non-convergence: inspect the stop reason, failing gate, and last state.
- Crash with persisted state: re-run the same workflow or loop; recover from the persistent plan or state store.

Never use destructive git operations as automatic recovery. Force-push, history rewrite, broad clean, and branch deletion require explicit human approval.
