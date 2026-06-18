# Agent Notes

This file preserves implementation context that is useful for coding agents and contributors but too detailed for the user-facing README.

Use `CONTEXT.md` for project vocabulary. In particular, prefer `flow`, `flow context`, `conversation`, `backend adapter`, `conversation harness`, `Codex child run`, `review module`, and `persistent plan`.

## Current Scope

- The package is version `0.1.0`.
- Local development, examples, CI verification, fixture validation, live backend adapter work, and distribution are in scope.
- npm publishing is deferred. If restored, it should use npm Trusted Publishing to a private `@twelvehart` package.
- Releases are tag-driven through `.github/workflows/release.yml` and publish GitHub Release binaries only.
- Default CI should stay deterministic and should not require live backend credentials.

## Backend Decisions

- Supported live autonomous backend constructors are `claude()`, `codex()`, `opencode()`, and `pi()`.
- Backend tags are `claude`, `codex`, `opencode`, and `pi`.
- Gemini is intentionally cut. Google's Gemini CLI is being deprecated in favor of the Antigravity CLI (`agy`), and the Gemini path never shipped a live streaming driver.
- Future Google support should use a new `agy` backend tag rather than reviving a Gemini backend.
- Codex, Claude, and Pi share the subprocess backend path.
- OpenCode uses a managed `opencode serve` process over HTTP/SSE and requires explicit shutdown by the backend owner.

## Runtime Decisions

- The v1 flow model is autonomous by default.
- Autonomous conversations reject human questions and live approval prompts.
- Explicit interactive Codex conversations can use the Orca-owned `ask_user` bridge.
- Approval events remain a reserved compatibility seam.
- `Plan.interactive` is intentionally unsupported because live answers cannot be replayed after crash recovery.
- Persistent plan helpers write deterministic `.orca/plan-<hash>.md` files.

- `selectBackend()` is the public runtime backend selector: `ORCA_BACKEND` overrides its required `default`, and `ORCA_BACKEND_MODEL` overrides config/per-backend models.
- Standalone binaries prefer a project-local `orca-ts` package; when none resolves, the CLI provides the embedded API through a temporary `node_modules/orca-ts` shim next to the flow.
- `flowArgs()` is the public flow-argument channel: it returns the user's task tokens (everything after `--`). The CLI captures them and forwards them via the `ORCA_FLOW_ARGS` env var; a flow run directly (`bun flow.ts -- foo`) parses them from argv. Flows must read task input via `flowArgs()` — never `process.argv`, which also holds the flow path and CLI flags.
- `ok`, `err`, and the `Result` type are re-exported from the package root so flows (including standalone runs that only see the embedded `orca-ts` surface) can build/unwrap `Result`s without a `neverthrow` dependency in the target repo.

## Loop Builder Decisions

- `loop()` is the Effect-free authoring front door (design D1). It lowers onto `flow()` plus the generic `fixLoop` convergence primitive; the single-cycle case reads like a guarded `while` and surfaces no engine, queue, or conversation symbol. User-facing authoring lives in `docs/loops.md`; `README.md` stays a concise entry point.
- **Effect lives behind a facade (D2).** The engine under `src/loop/engine/**` uses Effect for recurrence (`Schedule`), bounded structured concurrency, and cancellation, but Effect must never reach the public surface. `scripts/check-facade-gate.ts` is a verify-blocking gate that scans the generated declarations (`dist/index.d.ts`, `dist/loop/index.d.ts`), `examples/**/*.ts`, and `.orca/workflows/**/*.ts` for any `effect` import or `Effect.`/`Effect<` reference and fails the run on a hit. It runs after `build:types` so the declaration targets exist, and has no disable switch — it is the single load-bearing safeguard of D2.
- **Termination by construction (D3).** A loop is a cyclic graph with one declared back-edge; a back-edge with no preset and no `.measure()` is rejected at build time, naming the cycle, before anything runs. Presets bundle a variant (a measure with floor `0`) so the author writes no measure math; `.guard()` values override a preset's default seatbelts.
- **StateStore port + adapters (D4).** Loop state targets one port — `load / checkpoint / branch / merge / history`, all `Result`-typed — so swapping the adapter never changes a loop definition. `branch`/`merge` are first-class (fan-out = branch, fan-in = merge through the reducer, the only recombination point). Shipped adapters: `createSnapshotStore` (zero-config default; one JSON file per cycle) and `createSqliteStore` (`bun:sqlite`, per-step WAL checkpoint, advisory lease-based crash recovery, `history` table for time-travel). `createSqliteStore` returns a `Result` because it opens a file.
- **DBOS / Dolt deferred (D5).** Neither is selectable in this change; the port shape keeps both expressible later without touching a loop. DBOS needs a Postgres system DB (the TS runtime's SQLite system DB is Python-only) and is `bun run`-only (not bundleable into the smoke binary), so it violates the no-service / single-binary default; `sqlite` already covers single-process resume-after-crash. Dolt is not embeddable in Bun (Go-only driver; otherwise a ~103 MB `dolt sql-server` daemon or per-op CLI subprocess) and its branch/merge is tuned for human-scale persistent branches, not high-churn per-cycle branching. Full spike verdicts and promotion criteria: `openspec/changes/archive/2026-06-17-add-loop-builder/notes-deferred-durable-state.md`. The CLI parses `--durable` / `--postgres-url` / `--state dbos` only to reject them with a pointer to this rationale.
- **Distribution (D8).** `defineLoop({ name, source, sink, onTrigger })` binds a loop's trigger `Source` and output `Sink` to a one-shot runner. Discovery is import-only: a loop module under `.orca/loops/` exports the definition, and importing it registers without firing a trigger, running a backend, or emitting to a sink — so `orca loops` is side-effect-free. This is distinct from `.orca/workflows/` (self-executing legacy flow scripts). `orca serve` is a thin supervisor that owns the trigger and spawns an ephemeral child process per firing with OS-level kill isolation, so one firing's crash cannot take down the supervisor or sibling firings.
- **Legacy loop collapse (D7).** `implementTaskLoop` and `runReviewAndFixLoop` are now thin, deprecated wrappers over `fixLoop` `.until()` strategies (`sequentialTaskStrategy`, `reviewAndFixStrategy`). The wrappers stay for one release and emit a `DeprecationWarning` (code `ORCA_DEP_LOOP_COLLAPSE`) on every call; removal is a later breaking change. Migration: `docs/migration-loop-strategies.md`.

## Parity And History

- The Scala Orca repository was the local oracle for fixture creation and prompt parity.
- CI runs TypeScript checks without the JVM.
- Reviewer prompts are copied from the Scala oracle and tested for byte parity.
- Runtime parity is tracked through fixtures and `fixtures/adr/matrix.json`.
- Tier 3 real-agent evals are opt-in and excluded from the default verification gate.

## Verification

- Use `bun run verify` as the deterministic pre-PR gate.
- `bun run verify` covers typecheck, tests, doc-link checking, fixture validation, release metadata validation, declaration generation, and a compiled-binary smoke that runs a real flow importing `orca-ts` outside the repo.
- Run live backend smoke only with explicit environment gates, for example `ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts`.

## Documentation Placement

- Keep `README.md` organized for human users: overview, quickstart, configuration, guides, reference, troubleshooting.
- Keep detailed backend adapter behavior in `docs/backends.md`.
- Keep plan behavior in `docs/plans.md`.
- Keep review-loop behavior in `docs/review.md`.
- Keep fixture and parity details in `docs/parity.md`.
- Keep distribution and release mechanics in `docs/distribution.md` and `docs/release.md`.
- Keep detailed Agent Skill guidance inside each `skills/*/SKILL.md`; the README only points to them.
- Keep user-facing loop authoring (`loop()`, presets, custom measures, guards, fan-out/fan-in, state adapters, sources/sinks, `defineLoop()`, and `orca run/serve/loops`) in `docs/loops.md`; keep `README.md` as the concise entry point. Keep loop architecture decisions here and the wrapper migration in `docs/migration-loop-strategies.md`.
- Keep checked loop examples under `examples/` and import-safe loop module guidance under `.orca/loops/` examples or skill references. Loop examples and generated loop modules must use the public Effect-free surface, supported backend tags only, and no selectable DBOS or Dolt adapter.
- **Two surfaces, kept in sync.** `docs/` is the in-repo deep reference (GitHub-rendered); `website/src/content/docs/` is the canonical published reference. When a public symbol, CLI behavior, env var, or enum/union variant changes in `src/`, update **both** surfaces. The website reference pages are the source of truth for type signatures and literal sets; `docs/` carries the deeper guides the README links to. `bun run docs:check` verifies internal links; `bun run docs:symbols` mechanically verifies that documented literal sets (RuntimeError tags, Outcome verdicts, stop reasons, exit codes, source/sink kinds, FlowContext accessors, backend tags, reviewer IDs, env vars) match `src/` — run both before declaring docs done. A symbol-divergence check between `docs/` and the website reference pages is a tracked follow-up, not yet wired.

## Agent Skills

- Three host-agnostic, stack-agnostic Agent Skills live in-repo under `skills/`: `orca-ts-setup` (install + backend verify/doctor), `orca-ts-author` (read repo → interview → generate gated flow → save), `orca-ts-flow` (run → monitor → heal). They are co-located with the runtime so the bundled flow templates can be typecheck-gated against the in-repo API and cannot drift.
- Each skill is a **self-contained directory** so it installs cleanly via the `skills` CLI (`npx skills add ASRagab/orca-ts`), which copies each `skills/<name>/` independently and ignores any non-skill sibling (there is intentionally no `skills/_shared/`). Bundled resources live per-skill: `orca-ts-author` carries the reference cookbook (`reference/`) and the flow templates (`assets/templates/`); each skill carries the scripts it invokes under `scripts/`. The two scripts used by more than one skill (`orca-run.sh`, `orca-doctor.sh`) are duplicated into each skill and kept byte-identical by a drift test. Scripts (`orca-setup.sh`, `orca-doctor.sh`, `orca-run.sh`, `orca-typecheck-flow.sh`) locate every CLI at runtime; never hardcode a path. SKILL.md references bundled files as `skills/<skill-name>/...`.
- The backend doctor's auth probes are: definitive for `codex` (`codex login status`) and `opencode` (`opencode auth list`); presence/version only for `claude`/`pi` (no safe non-spending auth check), with the opt-in live smoke (`ORCA_REAL_BACKEND_SMOKE=1` / `--smoke`) as the definitive proof.
- Saved workflows are stack-agnostic: legacy one-shot scripts live at the target repo's `.orca/workflows/<name>.ts`; reusable loop modules live at `.orca/loops/<name>.ts` and export `defineLoop()` without firing triggers at import time. Both are triggered through the standalone `orca` binary (which skips the typecheck guard in a repo with no `tsconfig.json`) and must never depend on the target repo's package manager. Verification gates are the target repo's own detected test/lint commands; the author skill refuses to emit an ungated mutating workflow. Templates import `ok`/`err`/`flowArgs` from `"orca-ts"` (never `neverthrow`/`process.argv`) so they run under the embedded shim with no target-repo deps.
- Repo-mutating templates protect the user's tree: `issue-to-pr` auto-stashes pre-existing work and cuts an `orca/<slug>` branch before commit/push; `cleanup-sweep` requires a clean baseline, reverts only the iteration's own change, and detects/reverts off-target edits; `bugfix` requires a green baseline before the repro; `persistent-multitask` checks off completed tasks in the persisted plan for true crash-resume. Destructive git ops (force-push, history rewrite, `reset --hard`, broad `clean -fd`) are never auto-performed.
- `tests/skill-templates.test.ts` typecheck-gates every bundled template via `tsconfig.skill-templates.json` (extends the base tsconfig, `rootDir: "."`, `skills/**/assets/templates/**/*.ts` glob, `orca-ts` resolved by package self-reference) and asserts the duplicated `orca-run.sh`/`orca-doctor.sh` copies stay byte-identical. Templates are eslint-ignored (they carry intentional `REPLACE_WITH_*` slots and are typecheck-gated separately).
