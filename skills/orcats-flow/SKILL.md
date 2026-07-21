---
name: orcats-flow
description: "Execute a saved (or just-authored) Orcats workflow or loop module against any git-backed repo, monitor it for real progress (not slowness), and diagnose, resolve, and where safe self-heal runtime failures — backend crash, expired/missing auth, gate failures, non-convergence, stalls, served child failures. Surfaces exit status + per-agent cost and shuts down any managed backend (OpenCode). Use to run/monitor/troubleshoot an Orcats workflow or loop. Triggers on \"run my orcats workflow\", \"orcats flow stuck\", \"orcats run failed\", \"monitor orcats\", \"orcats workflow not making progress\", \"heal orcats run\"."
compatibility: "Host-agnostic and stack-agnostic. Runs workflows and loop modules through the standalone `orcats` binary (no target-repo package manager needed). Reuses the shared backend doctor for auth/crash healing. Reads .orca/monitoring/<runId>.json, loop state, the persistent plan, and git log for progress."
metadata:
  author: "Ahmad Ragab"
---

# orcats-flow — run, monitor, and heal an Orcats workflow or loop

Authoring produces a workflow script or loop module; this skill **runs** it and
keeps it healthy. It judges real progress (not backend slowness), classifies
failures from runtime signals, and applies bounded, safety-gated recovery —
escalating anything destructive.

Flow: **run with monitoring → watch for real progress → on failure classify →
heal within bounds (or escalate) → surface outcome + cost → tear down managed
backends.**

## 1. Run the artifact

For legacy workflow scripts under `.orca/workflows/`, run through the standalone
binary with monitoring on, against the confirmed target repo. Use the wrapper
(surfaces exit + points at the monitor log):

```bash
bash skills/orcats-flow/scripts/orca-run.sh .orca/workflows/<name>.ts
# backend override at run time (selectBackend honors --backend):
bash skills/orcats-flow/scripts/orca-run.sh .orca/workflows/<name>.ts --backend codex
# task args after --, if the flow reads them:
bash skills/orcats-flow/scripts/orca-run.sh .orca/workflows/<name>.ts -- "fix the flaky test"
```

For loop modules under `.orca/loops/`, use the loop CLI:

```bash
orcats loops
ORCA_LOOP_EVENT='{}' orcats run <name-or-path>
orcats serve <name-or-path>
```

Use `orcats run` for one firing and `orcats serve` for a long-lived source. Both use
the same firing contract for event delivery, loop execution, sink emission,
diagnostics, and stop-reason exit status. `orcats loops` is discovery-only; it must
not start a source, backend, or sink.

There is **no `--monitor` CLI flag** — an artifact opts into monitoring itself. The
bundled persistent-multitask / cleanup templates use `WorkflowMonitor` (from
`@twelvehart/orcats`) to write `.orca/monitoring/<runId>.json` (per-task/file verdict,
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
  `.orca/monitoring/<runId>.json` (tail it; the workflow wrapper prints its path).
  For loops, progress records may include stop reason, token usage when reported,
  and `contextPressure` evidence such as offload count or compaction stages.
- **Loop state** — new `.orca/state-<hash>.json` files or sqlite `history`
  entries when a loop uses a `StateStore`.
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
| **gate/validation** | a verification command (test/lint) failed and the main fix-loop is iterating |
| **baseline-repair** | a generated mutating artifact is repairing red baseline gates under the default `repair` or explicit `accept-dirty` policy |
| **non-convergence** | loop execution or `fixLoop` hit a guard — stop reason / `regressedReason` such as `stuck`, `timeout`, `ceiling`, or `budget-exhausted` |
| **stall** | no flow-level progress past the watchdog window (§2) |
| **crash** | the run died mid-flow with a recoverable partial state (plan/commits present) |
| **served-child** | `orcats serve` stays alive but a child firing exits non-zero or reports a loop stop failure |

Report the classification with its evidence (the offending command, the failure
category from monitoring, the affected backend).

## 4. Heal within bounds — escalate anything destructive

Bounded, safety-gated recovery by class:

- **environment (auth/crash)** → re-verify the backend with the shared doctor,
  guide re-auth, then **resume**:
  ```bash
  bash skills/orcats-flow/scripts/orca-doctor.sh --backend <tag>
  # if unauth: codex login / opencode auth login / claude then /login / set pi token
  ```
  Re-run the workflow; the persistent-multitask archetype recovers
  `.orca/plan-*.md` and skips completed tasks, so resume is cheap.
- **non-convergence** → diagnose from the recorded failure category, retry a
  **bounded** number of times (≤2) with an adjusted prompt or a different
  `--backend`. If it still won't converge, **escalate to the user** with the
  failing gate output — do not loop forever.
- **crash** → re-run; the flow resumes from the persistent plan / committed work.
- **served-child** → inspect the child run output and rerun the same event with
  `ORCA_LOOP_EVENT='...' orcats run <name-or-path>` when possible. Do not restart
  the supervisor unless the `Source` itself failed. Treat `ORCA_LOOP_EVENT` as
  the reproduction envelope, not as an adapter API.
- **baseline-repair** → this is default workflow progress for red baseline
  gates. Let the bounded baseline repair stage run. If it exits non-converged,
  report the failing command, latest validation output, convergence guard, and
  monitor log path or dirty-baseline snapshot path when available.
- **gate/validation** → this is the workflow doing its job; let the in-flow
  fix-loop iterate. Only intervene if it converges to non-convergence (above).

If a workflow refuses to start because the worktree is dirty under `repair` or
`strict`, explain that dirty baseline acceptance is opt-in via
`--baseline=accept-dirty` or `ORCA_BASELINE_POLICY=accept-dirty`. Do not rerun
with `accept-dirty` unless the operator explicitly asks; that mode snapshots the
dirty baseline before backend repair work.

**Hard rule:** never auto-perform a destructive or irreversible repository
action during healing — no force-push, history rewrite, `reset --hard`,
`clean -fd` on the user's tree, or branch deletion. If recovery would need one,
**stop and ask the user how to proceed.**

## 5. Surface outcome and tear down

At run end, always report:

- **exit status** (the wrapper prints `orcats flow exit=<n>`), and
- **loop stop reason** when present (`converged` is zero; every other stop maps
  to a non-zero loop exit code), and
- **per-agent cost/usage** — from the monitoring log's `outcomes[].usage`
  / `tokens` and `summary`. (`bun run scripts/summarize-run.ts` summarizes a log
  by backend/stage/file/usage when Bun + the repo are available.)

**Managed backend teardown:** if the run used (or could have used) OpenCode,
ensure no `opencode serve` is left running. Well-authored flows call
`selected.shutdown?.()` in a `finally`; if a crash bypassed it, the operator can
stop the stray server. Confirm none is dangling before declaring the run done.

## Delivery-aware workflow outcomes

Workflow execution and delivery are separate. A run that has created a ready pull request is not delivered when its requested outcome is a merged pull request.

1. Preserve run report and worktree when delivery is pending or blocked.
2. Check `gh pr view <url> --json state,headRefOid,isDraft` and
   `gh pr checks <url>`; remote head must equal locked head SHA.
3. Report `deliveryStatus: "delivered"` for a merged objective only with
   `state: "MERGED"` at that locked head SHA; otherwise report separate run and
   delivery states plus blocker.

Do not force-push, rewrite history, or merge manually. The workflow owns
delivery policy; this skill observes, heals safe local failures, and escalates
remote-policy failures.

## Done when

The workflow or loop completed (or was healed to completion, or escalated with a
clear reason), the exit status + cost are reported, and no managed backend
process is left running.
