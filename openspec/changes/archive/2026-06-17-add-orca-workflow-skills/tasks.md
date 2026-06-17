## 1. Shared scaffolding and reference cookbook

- [x] 1.1 Create `skills/` with subdirs `orca-ts-setup/`, `orca-ts-author/`, `orca-ts-flow/`, each with `SKILL.md`, and a shared `skills/_shared/` (or per-skill copies — resolve the packaging question from design Open Questions) for `reference/` and `scripts/`
- [x] 1.2 Write `reference/dsl.md` — orca-ts flow verbs and types from the public API (`flow`, `llm().autonomous`, `selectBackend`, `plan`, `review`, `fixLoop`, `implementTaskLoop`, `fs`/`git`/`gh`/`terminal`/`command`, `z`), with the `await flow(process.argv.slice(2))(async () => {…})` shape and `.awaitResult()` outcome handling
- [x] 1.3 Write `reference/backends.md` — backend matrix (claude/codex/opencode/pi): CLI, readiness/auth probe, models, autonomous-only `ask_user`, OpenCode managed-process shutdown, `selectBackend()` precedence and env overrides
- [x] 1.4 Write `reference/gotchas.md` — TS codegen rules + a pre-handoff self-audit checklist (imports from `orca-ts`, outcome `.type` narrowing, `selectBackend` vs pinned backend, OpenCode shutdown, schema/`z` usage, standalone-binary typecheck-skip note)
- [x] 1.5 Write `reference/recipes.md` — the archetypes mapped to templates, each as a complete, explained example
- [x] 1.6 Author bundled TS templates under `assets/templates/` (one per archetype: single-change, persistent-multitask, issue-to-pr, bugfix, cleanup-sweep, multi-backend-compare), each parameterized for stack-agnostic verification command slots and importing from `orca-ts`
- [x] 1.7 Write the shared backend-doctor script (`scripts/orca-doctor.sh`): probe each chosen backend for CLI-on-`PATH`, non-spending readiness, and auth; classify failures (missing/unauth/misconfig/network); support an opt-in `ORCA_REAL_BACKEND_SMOKE` live check

## 2. orca-ts-setup skill

- [x] 2.1 Write `orca-ts-setup/SKILL.md` frontmatter (name, description, triggers, host/stack-agnostic compatibility note) and the install → choose-backend → verify → troubleshoot flow
- [x] 2.2 Implement/locate-or-install the `orca` binary step: prefer on-`PATH`, else run the documented installer, honor `ORCA_VERSION`/install-dir, confirm with `orca --version`
- [x] 2.3 Wire the backend selection prompt (host-agnostic) and call the shared doctor (1.7) to verify ≥1 chosen backend; fail loudly if none pass
- [x] 2.4 Implement troubleshooting branches mapping each failure class to a concrete next step (install CLI, backend-specific login, manual installer download/verify)
- [x] 2.5 Make the skill re-runnable as a doctor (re-verify without reinstall on a healthy environment)

## 3. orca-ts-author skill

- [x] 3.1 Write `orca-ts-author/SKILL.md` frontmatter and the read-repo → interview → generate → gate → save flow, referencing the shared cookbook
- [x] 3.2 Implement target-repo stack/command discovery: probe `package.json` scripts, `Makefile`/`justfile`, `pyproject.toml`/pytest, `Cargo.toml`, `go.mod`, `build.sbt`, `.pre-commit-config.yaml`, CI workflows; propose detected test/lint/format/build commands and confirm with the user
- [x] 3.3 Implement the adaptive, host-agnostic interview (archetype first → archetype-specific sub-decisions, each with a default; `AskUserQuestion` on Claude Code, one-at-a-time elsewhere; "defaults" fast-path)
- [x] 3.4 Implement template selection + slot-fill for the chosen archetype, slotting in the confirmed verification commands and backend selection
- [x] 3.5 Implement the verification-gate enforcement: wire test+lint (minimum) into the per-task loop; refuse to emit a flow with no gate
- [x] 3.6 Implement the typecheck gate with fallback: typecheck the generated flow when a TS toolchain is reachable (scratch tsconfig + embedded orca-ts shim + `tsc --noEmit`); otherwise run the self-audit and add the skipped-typecheck note to the runbook
- [x] 3.7 Implement stack-agnostic save: write `.orca/workflows/<name>.ts`, emit `<name>.run.md` runbook with the exact `orca` trigger + prerequisites, and an optional thin POSIX `<name>.sh` wrapper; confirm target directory before writing

## 4. orca-ts-flow skill

- [x] 4.1 Write `orca-ts-flow/SKILL.md` frontmatter and the run → monitor → diagnose → heal flow
- [x] 4.2 Implement workflow execution via the `orca` binary with `--monitor` enabled and optional backend override against the confirmed target repo
- [x] 4.3 Implement progress-based stall detection: tail `.orca/monitoring/<runId>.json`, persistent plan checkboxes, and `git log`; flag a stall only on no-progress beyond a tunable window past the inactivity watchdog
- [x] 4.4 Implement failure classification (backend crash, expired/missing auth, validation/gate failure, non-convergence, stall) from runtime signals + monitoring
- [x] 4.5 Implement bounded, safety-gated healing: environment → doctor + guided re-auth + resume from persistent plan; non-convergence → bounded retry with adjusted prompt/backend then escalate; crash → resume; hard-stop and escalate on any destructive/irreversible action
- [x] 4.6 Implement outcome surfacing (exit status + per-agent cost/usage summary) and managed-backend teardown (OpenCode shutdown)

## 5. CI template gate

- [x] 5.1 Add `tests/skill-templates.test.ts` (or a script) that typecheck-gates every bundled template under `assets/templates/` against the in-repo orca-ts, mirroring the Scala recipes test
- [x] 5.2 Wire the template gate into the deterministic verification path so templates cannot drift from the runtime API

## 6. Docs and discoverability

- [x] 6.1 Add a short pointer from `README.md` (and `AGENTS.md` for rationale) to the three skills; keep detailed guidance inside each `SKILL.md`
- [x] 6.2 Document the `.orca/workflows/` convention and the stack-agnostic trigger in the relevant doc (e.g. `docs/` or the authoring `SKILL.md`)

## 7. End-to-end validation

- [x] 7.1 Dry-run setup on a clean environment: install/locate `orca`, verify one backend via the doctor, exercise one troubleshooting branch
- [x] 7.2 Author a workflow against a non-TypeScript fixture repo (e.g. a Python or Go folder) and confirm verification gates are wired and the skipped-typecheck fallback path works
- [x] 7.3 Author + run a workflow against the orca-ts repo itself (TS path with full typecheck gate) and confirm the run/monitor/heal loop surfaces outcome and cost
- [x] 7.4 Run `bun run verify` (including the new template gate) and confirm the deterministic gate stays green

## 8. Review remediation (Codex review, 2026-06-12)

- [x] 8.1 Re-export `ok`/`err`/`Result` from `orca-ts` and switch all templates off the bare `neverthrow` import so standalone flows run with no target-repo deps (P1)
- [x] 8.2 Add a `--`-delimited flow-arg channel (`flowArgs()` + `extractFlowArgs`, CLI `flowArgs` + `ORCA_FLOW_ARGS` forwarding) and read task input via `flowArgs()` in templates instead of `process.argv` (P2)
- [x] 8.3 Make `orca-doctor.sh` portable: detect `timeout`/`gtimeout`, fall back to running uncapped (stock macOS has no GNU `timeout`) (P1)
- [x] 8.4 `issue-to-pr`: auto-stash pre-existing work + restore, cut an `orca/<slug>` feature branch before commit/push, stage only workflow-owned changes (P1)
- [x] 8.5 `cleanup-sweep`: require a clean baseline, revert only the iteration's own change, detect and revert off-target edits (P1 + P2)
- [x] 8.6 `bugfix`: assert a green baseline before the repro so a pre-existing red gate isn't mistaken for a repro (P2)
- [x] 8.7 `persistent-multitask`: check off converged tasks in the persisted plan and skip done tasks on resume (P2)
- [x] 8.8 Add `flowArgs`/`extractFlowArgs` unit tests; update reference cookbook (gotchas/dsl/recipes) and AGENTS.md; re-run `bun run verify` + shellcheck + non-TS runtime proof
