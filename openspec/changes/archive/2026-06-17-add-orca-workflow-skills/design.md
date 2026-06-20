## Context

Orca TypeScript ships a runtime (flow DSL, four backends, persistent plans,
review loops, `WorkflowMonitor` observability) and a standalone `orca` binary that can
run a `.ts` flow even in a repository that has no `node_modules` or
`tsconfig.json`. What it lacks is a guided, agent-facing path from intent to a
saved, self-validating workflow.

The proven precedent is the Scala `orca-flow` skill
(`~/Dev/tools/personal-skills/skills/orca-flow`): interview → generate →
compile-gate → run, with a bundled preflight script, archetype templates, and a
reference cookbook kept green by CI. This change ports that pattern to orca-ts
and decomposes it into three skills, while adding two things orca-flow does not
do: explicit, enforced verification gates ("vibes → productized") and a
run/monitor/heal loop.

Hard constraint from the user: the skills target **any git-backed repository**,
not only TypeScript projects. Flow files are TypeScript (that is what Orca
runs), but the repository under operation can be any stack, so the skills detect
the *target* repo's toolchain and never assume a Node/TS layout.

## Goals / Non-Goals

**Goals:**
- Three installable, host-agnostic skills under `skills/`, composing into
  setup → author → run: `orca-ts-setup`, `orca-ts-author`, `orca-ts-flow`.
- A coding agent in an arbitrary repo can install Orca, prove a backend works,
  author a verification-gated workflow, save it, and re-run/monitor/heal it.
- Generated artifacts typecheck on the first try (template + cookbook + gate).
- Saved workflows are re-runnable with no dependency on the target repo's stack.
- Verification gates (minimum: the target repo's tests and linters) are
  mandatory in every authored workflow.

**Non-Goals:**
- No change to the runtime's public API, backend SPI, or the deterministic
  `bun run verify` contract (beyond an additive template-gate test).
- Not reviving Gemini or adding `agy` (tracked elsewhere).
- No semantic correctness oracle for what the agent produces — verification is
  the repo's own gates (tests/lint/build), not a judge of intent.
- No auto-execution of destructive or irreversible actions during healing
  (force-push, history rewrite, destructive resets) — those escalate to the user.
- Not publishing to npm or syncing to the personal-skills marketplace in this
  change (the user chose in-repo authoring; sync is a later option).

## Decisions

### D1: Three skills, not one — split by lifecycle phase
`orca-ts-setup` (install + backend verify/troubleshoot), `orca-ts-author`
(read repo → interview → generate + gate → save), `orca-ts-flow` (run + monitor
+ heal). Rationale: each phase is independently invocable (re-verify a backend
without re-authoring; re-run a saved flow without re-interviewing), has a
distinct behavioral contract, and maps to one spec file. The Scala orca-flow
proved a single skill works, but it does not own a run/monitor/heal loop; that
loop is substantial enough to be its own skill. *Alternative considered*: one
mega-skill — rejected because the run/heal surface and the setup/doctor surface
have very different trigger conditions and would bloat a single `SKILL.md`.

### D2: Skills live in this repo under `skills/`, CI-gated
Versioned with the runtime so they track the API they target, and so the
bundled templates can be typecheck-gated by CI exactly like orca-flow's recipes
test keeps its `.sc` templates green. *Alternative*: personal-skills repo —
rejected for this change because the skills must not drift from the runtime;
co-location plus a CI gate is the anti-drift mechanism. Distribution/sync out is
left open.

### D3: Stack-agnostic save + trigger via the standalone binary
Flows are TypeScript but operate on any repo. Saved flows live at the target
repo's `.orca/workflows/<name>.ts` (Orca's existing namespace, alongside
`.orca/plan-*.md` and `.orca/monitoring/`). Triggering uses the standalone
`orca` binary, which embeds the API through a temporary `node_modules/orca-ts`
shim and **skips the project typecheck guard in a repo with no `tsconfig.json`**
(emitting a warning). Each saved flow ships a `<name>.run.md` runbook and an
optional thin POSIX shell wrapper (`<name>.sh`) that pins the backend and flags.
*Alternative*: a `package.json` script alias — rejected because it assumes a
Node/TS target repo, violating stack independence.

### D4: Verification gates are the target repo's own commands, detected then enforced
The author skill detects the target stack's real commands by probing for the
usual markers (`package.json` scripts, `Makefile`/`justfile` targets,
`pyproject.toml`/`pytest`, `Cargo.toml`, `go.mod`, `build.sbt`,
`.pre-commit-config.yaml`, CI workflow files) and confirms them with the user.
The authored flow wires these as gates inside the per-task fix-loop (mirroring
`workflows/ai-slop-cleanup.ts`: per-file validation + final verify). A workflow
MUST carry at least a test gate and a lint gate; if none can be detected, the
skill prompts the user to supply commands and refuses to emit an ungated flow.
This is the "vibes → productized" mechanism.

### D5: Typecheck-gate generated artifacts when a TS toolchain is reachable; otherwise rely on CI-gated templates + self-audit
In a TS-capable environment the author skill validates the generated artifact in a
scratch context (temp `tsconfig.json` + `typescript` + the binary's embedded
orca-ts shim, then `tsc --noEmit`). In a non-TS repo with no reachable TS
toolchain, it falls back to: (a) the bundled templates are correct-by-
construction because CI typecheck-gates them, and (b) a codegen self-audit
checklist (ported from orca-flow's gotchas). It then emits a runbook note that
the runtime typecheck guard will be skipped. *Rationale*: the CI template gate
is what makes slot-filled output high-confidence even without a local gate.

### D6: Backend doctor, used by setup (preflight) and flow (runtime healing)
Byte-identical per-skill script copies probe each backend cheaply: CLI on
`PATH`, a non-spending readiness probe (version/auth-status per CLI), and an
optional opt-in live smoke (`ORCA_REAL_BACKEND_SMOKE=1`). `orca-ts-setup` runs
its copy to enable ≥1 backend; `orca-ts-flow` runs its copy when a run fails with
a backend/auth error, to diagnose and guide re-auth before resuming.

### D7: Stall detection is progress-based and tuned to runtime watchdogs
The runtime already bounds a single turn (120s inactivity watchdog, 600s
wall-clock cap). Dogfood data shows normal agent turns run 55–143s, so naive
wall-clock thresholds would false-positive. `orca-ts-flow` instead judges
*flow-level* progress: it tails `.orca/monitoring/<runId>.json`, the persistent
plan's checkbox state, and `git log`, and flags a stall only when no
stage/file/task/commit progress occurs across a tunable window beyond the
inactivity watchdog — not on slowness alone.

### D8: Healing is bounded and safety-gated
Three healing classes: (1) **environment** — backend crash/expired auth →
doctor + guided re-auth → resume via persistent plan; (2) **non-convergence** —
a fix-loop hits its convergence guard/ceiling (`regressed`/`stuck` verdict) →
diagnose from the monitor failure category, retry with adjusted prompt/backend a
bounded number of times, else escalate; (3) **crash** — re-run resumes from the
persistent plan. Destructive/irreversible repo actions are never auto-performed.

### D9: Host-agnostic adaptive interview
Ported from orca-flow: ask the archetype first, then only that archetype's
sub-decisions, offering a default for every question. On Claude Code use
structured prompts (`AskUserQuestion`); on other hosts ask one question at a
time with the default shown. A "defaults" answer fast-paths to the canonical
persistent-plan archetype with detected verification gates slotted in.

## Risks / Trade-offs

- **Template drift from the runtime API** → CI test typecheck-gates every
  bundled template against the in-repo orca-ts on each change.
- **Cannot runtime-typecheck generated artifacts in a non-TS repo** → rely on
  CI-gated templates + self-audit; warn in the runbook (D5). Residual risk:
  hand-edited slot fills can still break; mitigated by keeping templates
  parameterized and slots small.
- **Backend readiness probes differ per CLI and can't fully prove auth without
  spending tokens** → cheap non-spending probe by default, opt-in live smoke for
  certainty; document the limit. The exact probe per CLI is an apply-time unknown
  (see Open Questions).
- **Stall false-positives on slow-but-working backends** → progress-based
  detection tuned above the 120s watchdog (D7), never on slowness alone.
- **Self-healing overreach** → bounded retries + hard rule that destructive
  actions escalate to the user (D8).
- **OpenCode leaves a managed `opencode serve` process** → runner must own
  shutdown (`opencode().shutdown()`); the runbook and templates make this explicit.
- **Three skills increase install/maintenance surface** → mitigated by
  self-contained skill directories and drift tests for duplicated scripts;
  `orca-ts-author` owns the reference cookbook and templates, while each skill
  carries the scripts it invokes.

## Migration Plan

Purely additive. New files under `skills/` and one new CI test. No runtime
behavior changes, no data migration, no rollback complexity — reverting the
change is deleting the new files. Target repos gain an `.orca/workflows/`
directory only when a user saves a workflow there.

## Open Questions

- ~~Exact non-spending readiness probe per backend CLI.~~ **Resolved at apply**
  (empirically): `codex login status` and `opencode auth list` give definitive
  non-spending auth proof; `claude` and `pi` have no safe non-interactive
  auth-status check, so the doctor verifies presence + `--version` and reports
  `unverified` (credentials-file/token-env best-effort), with the opt-in live
  smoke (`--smoke` / `ORCA_REAL_BACKEND_SMOKE=1`) as the definitive proof.
- ~~Shared vs per-skill `reference/`.~~ **Resolved at apply**: each skill is a
  self-contained install directory because the `skills` CLI copies each
  `skills/<name>/` independently and ignores non-skill siblings. There is no
  `skills/_shared/`; `orca-ts-author` carries `reference/` and
  `assets/templates/`, and duplicated `orca-run.sh` / `orca-doctor.sh` copies are
  kept byte-identical by `tests/skill-templates.test.ts`.
- Whether to later sync the canonical in-repo skills out to personal-skills via
  the `npx skills` CLI (deferred; not in this change).

## Apply notes

- Template typecheck gate mechanism: `tsconfig.skill-templates.json` extends the
  base tsconfig with `rootDir: "."` and globs `skills/**/assets/templates/**`;
  `orca-ts` resolves by package self-reference. `tests/skill-templates.test.ts`
  runs `tsc --noEmit` against it inside `bun test` (so `bun run verify` covers
  it). Templates are eslint-ignored (intentional `REPLACE_WITH_*` slots).
- Author-time flow typecheck (`scripts/orca-typecheck-flow.sh`) is "available"
  exactly when the flow's repo has a `tsconfig.json` and resolves `orca-ts`; it
  extends that repo's own tsconfig to inherit working lib/types, and reports
  `SKIPPED` otherwise (the non-TS fallback).

## Review remediation notes (Codex review, 2026-06-12)

The first cut shipped templates that typechecked but were not correct for the
binary-only/stack-agnostic contract. The fixes (task group 8) surfaced two
public-API gaps in the runtime, both additive:

- **`neverthrow` leaked into standalone flows.** Templates imported `ok`/`err`
  from `"neverthrow"`, which the binary does not embed — so a flow would crash on
  import in a target repo without `node_modules/neverthrow`. Resolved by
  re-exporting `ok`/`err`/`Result` from the package root; the embedded shim
  spreads all of `index.ts`, so standalone flows get them with no target-repo
  dep. Templates now import these from `"orca-ts"`.
- **No flow-arg channel.** The CLI imported the flow in-process with the binary's
  untouched `process.argv` and discarded everything after the script positional,
  so task args (and the flow path + flags) polluted any flow that read
  `process.argv`. Resolved with a `--`-delimited channel: the CLI captures
  post-`--` tokens into `CliArgs.flowArgs`, forwards them via `ORCA_FLOW_ARGS`,
  and the new public `flowArgs()` accessor returns them (falling back to argv
  parsing for direct `bun flow.ts -- …` runs).

The remaining fixes are template/script safety, not API: mutating templates now
guard the user's tree (clean-baseline/auto-stash, feature branch before
commit/push, iteration-scoped revert, off-target detection, green-baseline repro
check, persisted plan check-off), and `orca-doctor.sh` no longer hard-depends on
GNU `timeout` (absent on stock macOS). These are codified as codegen rule 12 in
`gotchas.md`.
