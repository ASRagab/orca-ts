# Recipes — archetypes mapped to templates

Six archetypes cover the common shapes. Each maps to one bundled template under
`assets/templates/`. Every template is kept compiling by the CI gate
(`tests/skill-templates.test.ts` → `tsconfig.skill-templates.json`). To author a
workflow: pick the archetype, copy its template, fill the labelled SLOTS, run the
self-audit (`gotchas.md`), then save it to the target repo's `.orca/workflows/`.

Every template imports from `"orca-ts"`, wires the **target repo's own** test +
lint commands as a verification gate, and (where it may run on OpenCode) shuts
the managed server down in a `finally`. The trigger is always the standalone
binary — no dependency on the target repo's package manager:

```bash
orca .orca/workflows/<name>.ts --backend <tag> [-- "<task args>"]
```

| Archetype | Template | Use when |
|---|---|---|
| single-change | `single-change.ts` | one focused change, converge a gate, stop |
| persistent-multitask | `persistent-multitask.ts` | decompose an objective into tasks, persist the plan, gate each task (the **default** archetype) |
| issue-to-pr | `issue-to-pr.ts` | implement → gate → commit → push → open a PR |
| bugfix | `bugfix.ts` | reproduce-first / TDD: prove the bug red, then fix to green |
| cleanup-sweep | `cleanup-sweep.ts` | per-file edit across many files, keep-if-green / revert-if-regressed |
| multi-backend-compare | `multi-backend-compare.ts` | run one prompt across backends to compare outcome + cost |

## single-change
One autonomous turn implements `TASK_PROMPT`, then a `fixLoop` re-runs `GATE`
and asks the backend to repair until green or a stop fires (`stuck` via the
no-progress detector, `ceiling`, or `timeout`). Slots: `TASK_PROMPT`, `GATE`,
default backend. Leaves changes in place on non-convergence for inspection.

## persistent-multitask (default)
A planning turn emits a JSON task list (validated by `PlanSchema`); the plan is
written to `.orca/plan-<hash>.md` via `writePlan`. `implementTaskLoop` walks the
tasks; each task implements then converges `GATE` in its own `fixLoop`. A task
that can't converge fails the loop (returns `backendFailed`). **Each converged
task is checked off (`[x]`) in the persisted plan and re-running recovers it**
(`recoverPlan`), skipping done tasks — this is the crash-resume path
`orca-ts-flow` relies on. Slots: `OBJECTIVE`, `GATE`, default backend.

## issue-to-pr
Reads the task from `flowArgs()` (`-- "<prompt or owner/repo#n>"`), implements,
converges `GATE`, then `git add`/`commit`/`push` (via `command().run`, no
package-manager assumption) and opens a PR with `gh().createPullRequest`. The PR
body is written to a file and passed as `bodyFile`. **Safety:** auto-stashes any
pre-existing uncommitted work up front and restores it at the end (commits only
workflow-owned changes), and cuts an `orca/<slug>` feature branch when on `BASE`
so it never commits/pushes on the base branch. Slots: `GATE`, `PR_TITLE`,
`BASE`, default backend. Will not open a PR unless the gate is green.

## bugfix (reproduce-first)
Step 0: asserts `GATE` is **green** before starting — a pre-existing red baseline
would be mistaken for a repro, so it aborts. Step 1: the agent adds a failing
test reproducing the bug. Step 2: the flow asserts `GATE` is now **red** — a
repro that passes means the bug wasn't captured, so it aborts. Step 3: a
`fixLoop` fixes the cause until `GATE` (including the new test) is green, with a
prompt that forbids deleting/weakening the repro test. Slots: `GATE` (test
command must include the repro), `BUG_REPORT`, default backend.

## cleanup-sweep
Requires a **clean working tree** and a green baseline gate, lists files via
`git ls-files FILE_SELECTOR`, then per file: one edit turn scoped to that file →
re-run `GATE` → **keep if green, revert if it regressed**. The clean-baseline
guarantee means a revert only ever drops the iteration's own change, never your
work; any **off-target** edit (a file the agent touched but wasn't asked to) is
detected and the whole turn reverted. Files are independent, so one bad file
never blocks the sweep. Generalized, stack-agnostic shape of
`workflows/ai-slop-cleanup.ts`. Slots: `FILE_SELECTOR`, `GATE`, `EDIT_BRIEF`,
default backend.

## multi-backend-compare
Pins each backend directly (ignores `--backend`), runs `PROMPT` read-only on
each, and prints outcome type + wall-clock + token usage. OpenCode is shut down
in `finally`. Use it to choose a backend before standardizing a real workflow on
one. Slots: `PROMPT`, the `candidates` list. Read-only — does not mutate the repo.

## Slot-filling checklist
- Replace every `REPLACE_WITH_*` constant.
- `GATE` must contain at least one test command and one lint command, taken from
  what `orca-ts-author` detected in the target repo (never `bun`/`npm` by
  assumption). The skill refuses to emit an ungated flow.
- Set the `selectBackend({ default })` tag to the backend `orca-ts-setup` verified.
- Run the `gotchas.md` self-audit before saving.
