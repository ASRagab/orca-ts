# Recipes — archetypes mapped to templates

Six workflow archetypes cover the common one-shot shapes. Loop module recipes
cover reusable trigger-driven artifacts. Each template lives under
`assets/templates/` and is kept compiling by the CI gate
(`tests/skill-templates.test.ts` → `tsconfig.skill-templates.json`). To author a
workflow or loop: pick the artifact shape, copy its template, fill the labelled
SLOTS, run the self-audit (`gotchas.md`), then save it to `.orca/workflows/` or
`.orca/loops/`.

Every template imports from `"@twelvehart/orcats"`. Mutating templates wire the
**target repo's own** test + lint commands as a verification gate and run the
shared baseline policy before main work (`repair` by default, explicit `strict`
or `accept-dirty`), report non-success LLM outcomes with their error payloads,
and expose semantic progress through `WorkflowMonitor` stages plus a
`.orca/monitoring/<runId>.json` log. Any template that may run on OpenCode shuts
the managed server down in a `finally`. The trigger is always the standalone
binary — no dependency on the target repo's package manager:

```bash
orcats .orca/workflows/<name>.ts --backend <tag> [-- "<task args>"]
orcats .orca/workflows/<name>.ts --backend <tag> -- --baseline=strict
orcats .orca/workflows/<name>.ts --backend <tag> -- --baseline=accept-dirty
orcats loops
orcats run <name-or-path>
orcats serve <name-or-path>
```

| Archetype | Template | Use when |
|---|---|---|
| single-change | `single-change.ts` | one focused change, converge a gate, stop |
| persistent-multitask | `persistent-multitask.ts` | decompose an objective into tasks, persist the plan, gate each task (the **default** archetype) |
| issue-to-pr | `issue-to-pr.ts` | implement → gate → commit → push → open a PR |
| bugfix | `bugfix.ts` | reproduce-first / TDD: prove the bug red, then fix to green |
| cleanup-sweep | `cleanup-sweep.ts` | per-file edit across many files, keep-if-green / revert-if-regressed |
| multi-backend-compare | `multi-backend-compare.ts` | run one prompt across backends to compare outcome + cost |

| Loop module recipe | Template | Use when |
|---|---|---|
| served-trigger | `loop-served-trigger.ts` | export an import-safe `.orca/loops/<name>.ts` module with `defineLoop()`, a `Source`, a `Sink`, and one `loop()` run per trigger |

Loop modules differ from workflow scripts: they do **not** call `flow(...)` at
top level. Importing the module only registers the definition for `orcats loops`;
work starts inside `onTrigger`, when `orcats run` or an `orcats serve` child invokes
the definition. `orcats run` and served children use the same firing path for event
decode, `definition.run`, sink emission, diagnostics, and stop-reason exit codes.

## single-change
One autonomous turn implements `TASK_PROMPT`, then a `fixLoop` re-runs `GATE`
and asks the backend to repair until green or a stop fires (`stuck` via the
no-progress detector, `ceiling`, or `timeout`). Slots: `TASK_PROMPT`, `GATE`,
default backend. Leaves changes in place on non-convergence for inspection.

## persistent-multitask (default)
A planning turn emits a JSON task list (validated by `PlanSchema`); the plan is
written to `.orca/plan-<hash>.md` via `writePlan`. The template walks pending
tasks explicitly; each task implements then converges `GATE` in its own
`fixLoop`. A task that can't converge fails the run. **Each converged task is
checked off (`[x]`) in the persisted plan and re-running recovers it**
(`recoverPlan`), skipping done tasks — this is the crash-resume path
`orcats-flow` relies on. The template instantiates `WorkflowMonitor` (from
`@twelvehart/orcats`) and writes `.orca/monitoring/<runId>.json` (per-task verdict,
duration, iterations) in a `finally`, so `orcats-flow` gets real per-run
outcomes and `scripts/summarize-run.ts` can summarize them. Slots: `OBJECTIVE`,
`GATE`, default backend.

## issue-to-pr
Reads the task from `flowArgs()` after stripping any `--baseline` override,
implements,
converges `GATE`, then `git add`/`commit`/`push` (via `command().run`, no
package-manager assumption) and opens a PR with `gh().createPullRequest`. The PR
body is written to a file and passed as `bodyFile`. **Safety:** the default
baseline policy rejects dirty work; if the operator explicitly chooses
`accept-dirty`, the flow snapshots dirty work under the repo's git dir
(`git rev-parse --git-path orca-baselines`), stashes user-owned dirty work, then
runs clean baseline repair before PR implementation so commits still contain
only workflow-owned changes and never stage the snapshot. It cuts an
`orca/<slug>` feature branch when on `BASE` so it never commits/pushes on the
base branch. Slots: `GATE`, `PR_TITLE`, `BASE`, default backend. Will not open a
PR unless the gate is green.

## bugfix (reproduce-first)
Step 0: runs baseline policy first, repairing red baseline gates before the repro
turn unless the operator selected `strict`. A pre-existing red baseline would be
mistaken for a repro, so the flow reaches Step 1 only after the baseline is
green. Step 1: the agent adds a failing test reproducing the bug. Step 2: the
flow asserts `GATE` is now **red** — a repro that passes means the bug wasn't
captured, so it aborts. Step 3: a `fixLoop` fixes the cause until `GATE`
(including the new test) is green, with a prompt that forbids deleting/weakening
the repro test. Slots: `GATE` (test command must include the repro),
`BUG_REPORT`, default backend.

## cleanup-sweep
Runs baseline policy before sweeping, then lists files via `git ls-files
FILE_SELECTOR`. Per file: one edit turn scoped to that file → re-run `GATE` →
**keep if green, revert if it regressed**. The default clean-baseline guarantee
means a revert only ever drops the iteration's own change, never your work; any
**off-target** edit (a file the agent touched but wasn't asked to) is detected
and the whole turn reverted. With explicit `accept-dirty`, dirty user work is
snapshotted under the repo's git dir and stashed before clean baseline repair,
then restored after the sweep; paths changed by baseline repair are skipped and
protected from per-file edits, including untracked file and directory content
changes. Files are independent, so one bad file never blocks the sweep.
Generalized, stack-agnostic shape of `workflows/ai-slop-cleanup.ts`. Slots:
`FILE_SELECTOR`, `GATE`, `EDIT_BRIEF`, default backend.

## multi-backend-compare
Pins each backend directly (ignores `--backend`), runs `PROMPT` read-only on
each, and prints outcome type + wall-clock + token usage. OpenCode is shut down
in `finally`. Use it to choose a backend before standardizing a real workflow on
one. Slots: `PROMPT`, the `candidates` list. Read-only — does not mutate the repo.

## Variants — composable extensions

These are not separate templates; they are small, proven modifications you graft
onto an archetype during slot-filling. Apply them like any other edit, then run
the typecheck gate + self-audit as usual.

### plan-from-recent-changes (persistent-multitask)
**When:** the objective is "react to what just changed" — refresh docs against
recent merges, triage new issues, sweep code touched by the last N PRs. The
stock persistent-multitask planner decomposes a static `OBJECTIVE` only and has
no view of repo history, so the plan can't be informed by recent work.

**How:** add a deterministic context-gathering step and inject its digest into
the planning prompt (only when planning, *not* on resume — so recovered runs
stay deterministic). Gather with `command().run` over `gh`/`git`, degrade
gracefully if `gh` is absent:

```ts
async function gatherContext(prCount: number): Promise<string> {
  const parts: string[] = [];
  const prs = await command().run({
    command: "gh",
    args: ["pr", "list", "--state", "merged", "--limit", String(prCount),
           "--json", "number,title,mergedAt"],
  });
  parts.push(prs.type === "success" && prs.stdout.trim()
    ? `Merged PRs (JSON):\n${prs.stdout.trim()}`
    : "Merged PRs: unavailable (gh not authenticated); rely on commits below.");
  const log = await command().run({ command: "git", args: ["log", "-20", "--pretty=format:%h %s"] });
  if (log.type === "success" && log.stdout.trim()) parts.push(`Recent commits:\n${log.stdout.trim()}`);
  return parts.join("\n\n");
}
```

Then in `loadOrPlanTasks`, *after* the `recoverPlan` early-return, fold the
digest into the planning prompt so the task list catches up to real changes.
Keep the `gh` call optional: a repo with no `gh` auth still plans from commits.
This is the shape used to author the doc-refresh workflow and it demonstrably
biased the plan toward the latest merged work.

### emit-monitoring-json (any mutating archetype)
This is required for long-running mutating artifacts and already present in the
persistent-multitask template. For another archetype, instantiate
`new WorkflowMonitor(selected.tag)`, wrap meaningful steps with
`monitor.stage(...)`, call `recordOutcome`/`recordFailure` per unit of work, and
`await monitor.writeLog(".orca/monitoring")` in the `finally`. `orcats-flow`
reads these logs and `scripts/summarize-run.ts` summarizes them. Note
`exactOptionalPropertyTypes`: build optional fields with a conditional spread
(`...(cond ? { iterations } : {})`) rather than passing `undefined`.

## Slot-filling checklist
- Replace every `REPLACE_WITH_*` constant.
- `GATE` must contain at least one test command and one lint command, taken from
  what `orcats-author` detected in the target repo (never `bun`/`npm` by
  assumption). The skill refuses to emit ungated mutating code.
- Set the `selectBackend({ default })` tag to the backend `orcats-setup` verified.
- Keep `resolveBaselinePolicy({ args: flowArgs() })` and `runBaselineGate()`
  before any main backend turn or file edit in mutating artifacts. Document the
  default `repair` policy and `strict` / `accept-dirty` overrides in the runbook.
- For loop modules, export `defineLoop()` and keep imports side-effect-free:
  no backend turn, source start, sink emit, or repo mutation at module import.
  Custom `Source`/`Sink` adapters should not read `ORCA_LOOP_EVENT` or supervisor
  internals directly.
- Run the `gotchas.md` self-audit before saving.
