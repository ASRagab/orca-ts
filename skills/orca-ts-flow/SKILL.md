---
name: orca-ts-flow
description: "Execute a saved (or just-authored) Orca TypeScript workflow against any git-backed repo, monitor it for real progress (not slowness), and diagnose, resolve, and where safe self-heal runtime failures — backend crash, expired/missing auth, gate failures, non-convergence, stalls. Surfaces exit status + per-agent cost and shuts down any managed backend (OpenCode). Use to run/monitor/troubleshoot an Orca workflow. Triggers on \"run my orca workflow\", \"orca flow stuck\", \"orca run failed\", \"monitor orca\", \"orca workflow not making progress\", \"heal orca run\"."
compatibility: "Host-agnostic and stack-agnostic. Runs flows through the standalone `orca` binary (no target-repo package manager needed). Reuses the shared backend doctor for auth/crash healing. Reads .orca/monitoring/<runId>.json, the persistent plan, and git log for progress."
metadata:
  author: "Ahmad Ragab"
---

# orca-ts-flow — run, monitor, and heal an Orca workflow

Authoring produces a flow; this skill **runs** it and keeps it healthy. It judges
real progress (not backend slowness), classifies failures from runtime signals,
and applies bounded, safety-gated recovery — escalating anything destructive.

Flow: **run with monitoring → watch for real progress → on failure classify →
heal within bounds (or escalate) → surface outcome + cost → tear down managed
backends.**

## 1. Run the workflow

Run through the standalone binary with monitoring on, against the confirmed
target repo. Use the wrapper (surfaces exit + points at the monitor log):

```bash
bash skills/orca-ts-flow/scripts/orca-run.sh .orca/workflows/<name>.ts
# backend override at run time (selectBackend honors --backend):
bash skills/orca-ts-flow/scripts/orca-run.sh .orca/workflows/<name>.ts --backend codex
# task args after --, if the flow reads them:
bash skills/orca-ts-flow/scripts/orca-run.sh .orca/workflows/<name>.ts -- "fix the flaky test"
```

There is **no `--monitor` CLI flag** — a flow opts into monitoring itself. The
bundled persistent-multitask / cleanup templates use `WorkflowMonitor` (from
`orca-ts`) to write `.orca/monitoring/<runId>.json` (per-task/file verdict,
duration, iterations, usage when the backend reports it) and print
`▶ monitor log: <path>` at the end. A flow authored without `WorkflowMonitor`
writes no JSON — monitor it via the persistent plan + git instead (§2). The
wrapper only reports a log that is **new** for this run (it snapshots the
newest `*.json` before launching), so it never points you at a stale log from a
previous run. Prefer running in the background so you can watch progress live.

## 2. Monitor for REAL progress (not slowness)

The runtime already bounds a single turn (120s inactivity watchdog, 600s
wall-clock cap). Normal agent turns run ~55–145s, so **wall-clock slowness alone
is not a stall.** Judge *flow-level* progress from three signals:

- **Monitoring JSON** — new entries in `stages`/`outcomes` in the latest
  `.orca/monitoring/<runId>.json` (tail it; the wrapper prints its path).
- **Persistent plan** — newly checked boxes in `.orca/plan-*.md` (multitask).
- **git** — new commits / changed files (`git log --oneline -5`, `git status`).

Flag a **stall** only when **none** of these advance across a window *beyond* the
120s inactivity watchdog (a tunable ~3–5 min of zero stage/task/file/commit
progress). When you flag a stall, surface what the run was last doing (the last
`stages[]` entry / last plan line). A slow-but-progressing run is healthy — leave
it alone.

## 3. Classify the failure

On a non-zero exit or a flagged stall, classify the cause from the run's signals
+ monitoring output:

| Class | Signal |
|---|---|
| **environment** | backend crashed, or auth missing/expired (CLI error, auth/login message, non-zero before any agent output) |
| **gate/validation** | a verification command (test/lint) failed and the fix-loop is iterating |
| **non-convergence** | a `fixLoop` hit its guard — `regressed` outcome with `regressedReason` `stuck`/`timeout`/`ceiling` |
| **stall** | no flow-level progress past the watchdog window (§2) |
| **crash** | the run died mid-flow with a recoverable partial state (plan/commits present) |

Report the classification with its evidence (the offending command, the failure
category from monitoring, the affected backend).

## 4. Heal within bounds — escalate anything destructive

Bounded, safety-gated recovery by class:

- **environment (auth/crash)** → re-verify the backend with the shared doctor,
  guide re-auth, then **resume**:
  ```bash
  bash skills/orca-ts-flow/scripts/orca-doctor.sh --backend <tag>
  # if unauth: codex login / opencode auth login / claude then /login / set pi token
  ```
  Re-run the workflow; the persistent-multitask archetype recovers
  `.orca/plan-*.md` and skips completed tasks, so resume is cheap.
- **non-convergence** → diagnose from the recorded failure category, retry a
  **bounded** number of times (≤2) with an adjusted prompt or a different
  `--backend`. If it still won't converge, **escalate to the user** with the
  failing gate output — do not loop forever.
- **crash** → re-run; the flow resumes from the persistent plan / committed work.
- **gate/validation** → this is the workflow doing its job; let the in-flow
  fix-loop iterate. Only intervene if it converges to non-convergence (above).

**Hard rule:** never auto-perform a destructive or irreversible repository
action during healing — no force-push, history rewrite, `reset --hard`,
`clean -fd` on the user's tree, or branch deletion. If recovery would need one,
**stop and ask the user how to proceed.**

## 5. Surface outcome and tear down

At run end, always report:

- **exit status** (the wrapper prints `orca flow exit=<n>`), and
- **per-agent cost/usage** — from the monitoring log's `outcomes[].usage`
  / `tokens` and `summary`. (`bun run scripts/summarize-run.ts` summarizes a log
  by backend/stage/file/usage when Bun + the repo are available.)

**Managed backend teardown:** if the run used (or could have used) OpenCode,
ensure no `opencode serve` is left running. Well-authored flows call
`selected.shutdown?.()` in a `finally`; if a crash bypassed it, the operator can
stop the stray server. Confirm none is dangling before declaring the run done.

## Done when

The run completed (or was healed to completion, or escalated with a clear
reason), the exit status + cost are reported, and no managed backend process is
left running.
