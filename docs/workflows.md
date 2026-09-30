# Saved Workflows

Saved one-shot workflows live under `.orca/workflows/<name>.ts`; reusable loop
modules live under `.orca/loops/<name>.ts`. The `orcats-author` skill generates
mutating artifacts from checked templates and wires them to the target repo's
confirmed test and lint commands.

Before handoff, authoring runs `orcats check <artifact.ts>`. The check is
self-contained and offline, so a missing target `tsconfig.json`, TypeScript
installation, or Orcats dependency is never a reason to skip it.

## Baseline Policy

Generated mutating artifacts default to `repair`:

- `repair`: require a clean worktree, run the baseline gates, and repair failing
  gates before the main workflow stage starts.
- `strict`: require a clean worktree and green baseline gates; fail immediately
  on a red gate.
- `accept-dirty`: allow a dirty worktree, write a baseline snapshot, then repair
  failing gates before the main workflow stage starts.

Override the policy with a workflow arg or environment variable:

```bash
orcats .orca/workflows/name.ts --backend codex -- --baseline=strict
orcats .orca/workflows/name.ts --backend codex -- --baseline=accept-dirty
ORCA_BASELINE_POLICY=strict orcats .orca/workflows/name.ts --backend codex
```

`--baseline=...` takes precedence over `ORCA_BASELINE_POLICY`. If neither is set,
the policy is `repair`.

Dirty baseline acceptance is explicit because uncommitted files may be user-owned
work. In `accept-dirty`, the generated artifact writes a snapshot before any
backend repair turn. The shared helper defaults to `.orca/baselines/`; templates
that commit or sweep files may write under the repo's git dir (`git rev-parse
--git-path orca-baselines`) so the snapshot cannot make the subsequent clean
baseline gate fail or get staged into a PR. The snapshot records
`git status --porcelain=v1`, staged and unstaged diffs, untracked files, and the
initial gate output.

## Gate Repair

Baseline repair uses the same confirmed verification commands the artifact uses
later; it must not weaken test, lint, docs, release, smoke, or verify coverage.
The repair loop is bounded by iteration and wall-clock guards. If it does not
converge, the workflow fails before planning, editing, committing, publishing, or
running its main stage.

When a `WorkflowMonitor` is attached, baseline outcomes record validation logs,
repair iterations, usage when the backend reports it, convergence reason on
failure, and `snapshotPath` when a dirty baseline snapshot exists.

While a run is active, follow stderr/heartbeat, persistent plan, loop state,
and Git progress. Terminal monitoring JSON is written as the durable final
summary: its `status`, stage, backend, transport, and `terminalError` override
ambiguous wrapper exit text. Missing terminal JSON during an active run is not
failure evidence.

Create `WorkflowMonitor` before backend initialization with the intended backend
tag and `{ transport }`. Wrap meaningful work in `monitor.stage(...)`, then call
`monitor.finalize(logDir, { status: "succeeded" })` or
`monitor.finalize(logDir, { status: "failed", error })` after backend shutdown.
Preserve the primary failure if shutdown also fails. Finalization writes
atomically and repeated calls share its first result; `writeLog(logDir)` writes
an interim snapshot without ending the run.

Runtime monitoring, plan, state, and snapshot files belong in the repository's
local exclude file from `git rev-parse --git-path info/exclude`, not a tracked
`.gitignore`. Saved `.orca/workflows/` and `.orca/loops/` source remains
committable.
