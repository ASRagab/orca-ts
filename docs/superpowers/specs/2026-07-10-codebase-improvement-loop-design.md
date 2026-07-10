# Codebase Improvement Loop Design

## Context

Orcats needs a repeatable self-improvement run that proves its own workflow
contract against this repository. The run must isolate work, choose one small
evidence-backed improvement, implement it, verify it, review it, open a pull
request, wait for remote checks, and squash-merge it.

The previous `.orca/workflows/feature-fix-loop.ts` is not a suitable base:

- its only recorded feature run lasted 15 minutes 12 seconds and failed when
  the implementation turn hit the 600-second backend limit;
- it imports the retired `@twelvehart/orca-ts` package and invokes `orca`;
- it works in the caller's checkout instead of a fresh worktree;
- it has no per-stage instruction contract;
- it does not open, watch, or merge a pull request;
- it runs the full verification gate repeatedly, conflicting with the simple
  task target.

Current `origin/main` starts green: `bun test` reports 444 passing tests and one
opt-in live smoke skipped; `bun run lint` exits zero. Codex 0.144.1 is logged in,
Orcats 0.2.3 is installed, GitHub CLI is authenticated, and main has no branch
protection. Recent CI completes in about 70 seconds and Docs in about 20 seconds.

## Goals

1. Finish one simple improvement end to end in at most 10 minutes; faster is
   acceptable.
2. Make stage-specific skill and prompt instructions explicit inputs.
3. Expose live progress and preserve a machine-readable final run log.
4. Prove the selected change with test-first work, targeted repair gates,
   independent review, full verification, and remote checks.
5. Open and squash-merge the pull request without modifying the user's main
   checkout or deleting recovery evidence.
6. Record every workflow or runtime failure for the next iteration.

## Non-goals

- No new Orcats runtime or DSL API.
- No long-lived trigger service.
- No dependency, release, publishing, secret, security, or public-API work.
- No task larger than three changed files.
- No force-push, history rewrite, hard reset, broad clean, branch deletion, or
  worktree deletion.

## Chosen Shape

Use a self-executing workflow based on the issue-to-PR archetype, with a launcher
that owns worktree creation. A `defineLoop()` module is not used because the
current firing path is optimized for trigger-to-output loops, while this task
needs flow-context command, Git, GitHub, monitoring, and baseline tools.

Local artifacts:

- `.orca/workflows/codebase-improvement.ts`: staged Orcats workflow;
- `.orca/workflows/codebase-improvement.config.json`: validated directives;
- `.orca/workflows/codebase-improvement.sh`: worktree launcher;
- `.orca/workflows/codebase-improvement.run.md`: operator runbook;
- `.orca/improvement-loop/issues.jsonl`: append-only run issue ledger.

The artifacts remain under the gitignored `.orca/` directory. The codebase
improvement produced by the workflow is the only content eligible for its pull
request.

## Stage Directive Contract

The configuration has one directive per agent stage:

```json
{
  "stages": {
    "scout": {
      "prompt": "Prefer a low-risk behavioral defect with a focused regression test."
    },
    "reproduce": {
      "skill": "tdd",
      "prompt": "Add only the failing regression test; do not change production code."
    },
    "implement": {
      "skill": "tdd",
      "prompt": "Fix the cause without changing or weakening the captured regression test."
    },
    "repair": {
      "skill": "debug-like-expert"
    },
    "review": {
      "prompt": "Report only concrete correctness, regression, safety, or test-quality blockers."
    }
  }
}
```

Each directive is validated as `{ skill?: non-empty string, prompt?: non-empty
string }`, with at least one field present. `renderDirective()` converts it to a
per-call `systemPrompt`. A skill directive states that the child agent must
invoke `$<skill>` before stage work. A prompt directive is copied verbatim after
the skill requirement. The workflow records the stage name and non-secret
directive fields in its run evidence.

The first live run proves both forms: `reproduce` and `implement` use `$tdd`;
`review` uses a specific blocking-review prompt.

## Launcher

The launcher performs deterministic isolation before Orcats starts:

1. Resolve the repository root and reject a non-git directory.
2. Fetch `origin/main`.
3. Generate a unique run ID and branch `orca/improve-<run-id>`.
4. Create a linked worktree from `origin/main` under the system temporary
   directory.
5. Run `bun install --frozen-lockfile` in that worktree.
6. Copy the workflow and configuration into its ignored `.orca/` directory.
7. Export the launch timestamp so the workflow's deadline includes setup time.
8. Run the copied artifact through the standalone Orcats binary with Codex.
9. Copy the monitor, report, and issue ledger back to the source checkout's
   ignored `.orca/improvement-loop/runs/<run-id>/` directory.
10. Print the worktree path, branch, elapsed time, exit code, monitor log, issue
   ledger, and pull-request URL when available.

The launcher never removes the worktree or branch. A failed run therefore keeps
all evidence available for diagnosis and bounded reruns.

## Workflow Lifecycle

### 1. Preflight

- Parse the baseline policy, defaulting to `repair`.
- Require the fresh worktree to be clean.
- Run `bun test` and `bun run lint`.
- Confirm the branch starts at `origin/main`.
- Confirm Codex and GitHub authentication without spending a backend turn.
- Start `WorkflowMonitor` and derive the 10-minute deadline from the launch
  timestamp supplied by the launcher.

### 2. Scout

Run one read-only structured Codex turn. It returns exactly three candidates:

```text
id, title, problem, evidence[], allowedPaths[], testPath,
targetedTestArgs[], expectedFailurePattern, implementationBrief,
expectedMinutes, risk
```

Candidates must have `risk = "low"`, `expectedMinutes` from 5 through 10, two
through three allowed paths, a test path among those paths, at least one
distinct production path, and a targeted Bun test whose first argument is
`test`. Candidates involving excluded scope are rejected before selection.

### 3. Select and Plan

Choose deterministically by lowest expected minutes, then fewest paths, then ID.
Persist the selected contract to `.orca/improvement-loop/plan.json`. This is a
deterministic stage rather than another model turn, avoiding the previous
planning latency while retaining explicit plan evidence.

### 4. Reproduce

Run one write-enabled Codex turn with the reproduction directive. It may change
only `testPath`. Run the targeted test and require a non-zero result containing
`expectedFailurePattern`. Save the exact test diff as the immutable red-state
artifact.

### 5. Implement

Run one write-enabled Codex turn with the implementation directive. The prompt
contains the selected problem, evidence, allowed production paths, immutable
test diff, and implementation brief. It forbids commit, push, pull-request,
merge, dependency, and off-target edits. After the turn, the workflow confirms
the test diff is byte-identical to the saved red state.

### 6. Targeted Repair Loop

Evaluate the selected targeted test and `bun run lint`. A `fixLoop` invokes the
repair directive only when a gate fails. It allows at most one targeted repair,
stops repeated failure signatures as `stuck`, and stops when the 10-minute run
deadline cannot accommodate delivery. After every repair, the workflow confirms
the saved red-state test diff remains byte-identical.

### 7. Independent Review

Run one read-only structured Codex review against the diff. Findings include
severity, evidence, recommendation, and `fixable`. High or critical findings
enter one bounded repair turn, followed by targeted test, lint, and one repeated
review. Any remaining blocker prevents delivery.

Review repair is subject to the same immutable-test check. The workflow repeats
that check immediately before final verification and immediately before commit.

### 8. Final Verification

Run `bun run verify` once. Then enforce:

- one through three changed paths;
- every changed path is in `allowedPaths`;
- the selected test path changed;
- no lockfile, dependency manifest, release file, workflow artifact, or secret
  path changed;
- the worktree contains no untracked off-target path.

### 9. Delivery

Stage only validated changed paths. Commit with a conventional message derived
from the selected title. Push the branch. Write the pull-request body to a file
and pass it to `gh pr create --body-file`. Open a ready-for-review pull request
against `main`.

Poll the pull request's check rollup until the expected `Verify` check from the
`CI` workflow is present and every reported check succeeds, a check fails, or
the delivery budget expires. Zero reported checks never authorizes merge.
Resolve the head SHA immediately before merge. Squash-merge with
`--match-head-commit <sha>`. Confirm the pull request reports `MERGED` and print
its URL.

## Progress and Evidence

`WorkflowMonitor` owns these stages:

```text
preflight
scout
select-plan
reproduce
red-gate
implement
targeted-repair
review
review-repair
verify
commit-push
pull-request
remote-checks
merge
```

Each stage prints start, completion, and elapsed time through Orcats run output.
The final monitoring JSON records stage duration, outcomes, repair iterations,
validation evidence, and token usage when reported. A separate run report JSON
records the selected candidate, directive names, red-state artifact, pull
request URL, merge state, total duration, and SLA verdict.

The main agent runs the artifact through `orcats-flow`, polls real output rather
than wall-clock alone, and reports each significant stage transition to the
user. No-progress beyond the runtime watchdog is classified from monitor,
worktree, plan, and Git evidence.

## Timing

The simple-run acceptance ceiling is 10 minutes, measured from launcher start
through confirmed merge; 5 through 10 minutes is the expected range, but a
faster correct run passes. The hard allocations total 560 seconds, leaving 40
seconds for launcher and reporting overhead:

| Stage | Limit |
|---|---:|
| setup and preflight | 45 seconds |
| scout | 70 seconds |
| reproduce | 50 seconds |
| implement | 110 seconds |
| all repair turns | 70 seconds |
| review | 50 seconds |
| full verify | 75 seconds |
| remote checks and merge | 90 seconds |

The workflow checks the shared 10-minute deadline before every new stage. A
stage conversation is cancelled at its own limit. Crossing the shared deadline
is a failed acceptance run even if local code is correct; the workflow records
an `sla-overrun` issue and does not merge.

## Failure Handling

Every failure writes one JSON line containing run ID, timestamp, stage,
classification, elapsed time, command or backend, normalized error, worktree,
branch, monitor path, and pull-request URL when one exists.

The ledger begins with the prior `feature-implementation-timeout` run as the
first issue. The new staged workflow is its corrective iteration. Any new issue
found by authoring or running this workflow must receive a linked correction
entry and another bounded run before completion; a first-pass success does not
invent a synthetic failure merely to force another run.

Classifications are `environment`, `baseline`, `backend`, `gate`, `review`,
`scope`, `remote-check`, `merge`, and `sla-overrun`. Recovery is bounded to the
repair loops above. A failed or timed-out remote check does not trigger a merge.
No recovery path performs a destructive Git operation.

## Verification Strategy

Before the first live run:

1. Run the Orcats author typecheck script against the generated workflow.
2. Run a static self-audit for imports, flow envelope, outcome narrowing,
   backend shutdown, baseline policy, monitor use, gate coverage, stage
   directives, and forbidden Git operations.
3. Run the launcher preflight through worktree creation without a model turn.

For the live acceptance run:

1. Observe each stage transition through `orcats-flow`.
2. Confirm a regression test failed before production code changed.
3. Confirm targeted test and lint passed.
4. Confirm independent review returned no blocker.
5. Confirm `bun run verify` exited zero.
6. Confirm remote checks succeeded.
7. Confirm the pull request merged.
8. Confirm total elapsed time is at most 10 minutes.
9. Summarize monitoring usage and verify no managed OpenCode process remains.

## Acceptance Criteria

The design is complete only when one current-state run proves all of the
following:

- a fresh worktree was created from current `origin/main`;
- the scout selected one low-risk, testable, three-file-or-smaller improvement;
- both a named skill directive and a stage prompt directive were applied;
- exploration, plan, implementation, test, verification, review, pull request,
  remote checks, and merge are individually observable;
- the selected regression test demonstrates red then green behavior;
- local targeted gates and `bun run verify` pass;
- the ready pull request is squash-merged with an unchanged head SHA;
- elapsed time is at most 10 minutes;
- monitoring reports progress, outcome, stop reason, and usage;
- the prior timeout issue is linked to this corrective run, and every new
  workflow/runtime issue has a correction entry plus a later proving run;
- main's pre-existing untracked `package-lock.json` remains untouched.
