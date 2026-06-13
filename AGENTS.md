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

## Agent Skills

- Three host-agnostic, stack-agnostic Agent Skills live in-repo under `skills/`: `orca-ts-setup` (install + backend verify/doctor), `orca-ts-author` (read repo → interview → generate gated flow → save), `orca-ts-flow` (run → monitor → heal). They are co-located with the runtime so the bundled flow templates can be typecheck-gated against the in-repo API and cannot drift.
- Each skill is a **self-contained directory** so it installs cleanly via the `skills` CLI (`npx skills add ASRagab/orca-ts`), which copies each `skills/<name>/` independently and ignores any non-skill sibling (there is intentionally no `skills/_shared/`). Bundled resources live per-skill: `orca-ts-author` carries the reference cookbook (`reference/`) and the flow templates (`assets/templates/`); each skill carries the scripts it invokes under `scripts/`. The two scripts used by more than one skill (`orca-run.sh`, `orca-doctor.sh`) are duplicated into each skill and kept byte-identical by a drift test. Scripts (`orca-setup.sh`, `orca-doctor.sh`, `orca-run.sh`, `orca-typecheck-flow.sh`) locate every CLI at runtime; never hardcode a path. SKILL.md references bundled files as `skills/<skill-name>/...`.
- The backend doctor's auth probes are: definitive for `codex` (`codex login status`) and `opencode` (`opencode auth list`); presence/version only for `claude`/`pi` (no safe non-spending auth check), with the opt-in live smoke (`ORCA_REAL_BACKEND_SMOKE=1` / `--smoke`) as the definitive proof.
- Saved workflows are stack-agnostic: they live at the target repo's `.orca/workflows/<name>.ts`, are triggered through the standalone `orca` binary (which skips the typecheck guard in a repo with no `tsconfig.json`), and must never depend on the target repo's package manager. Verification gates are the target repo's own detected test/lint commands; the author skill refuses to emit an ungated flow. Templates import `ok`/`err`/`flowArgs` from `"orca-ts"` (never `neverthrow`/`process.argv`) so they run under the embedded shim with no target-repo deps.
- Repo-mutating templates protect the user's tree: `issue-to-pr` auto-stashes pre-existing work and cuts an `orca/<slug>` branch before commit/push; `cleanup-sweep` requires a clean baseline, reverts only the iteration's own change, and detects/reverts off-target edits; `bugfix` requires a green baseline before the repro; `persistent-multitask` checks off completed tasks in the persisted plan for true crash-resume. Destructive git ops (force-push, history rewrite, `reset --hard`, broad `clean -fd`) are never auto-performed.
- `tests/skill-templates.test.ts` typecheck-gates every bundled template via `tsconfig.skill-templates.json` (extends the base tsconfig, `rootDir: "."`, `skills/**/assets/templates/**/*.ts` glob, `orca-ts` resolved by package self-reference) and asserts the duplicated `orca-run.sh`/`orca-doctor.sh` copies stay byte-identical. Templates are eslint-ignored (they carry intentional `REPLACE_WITH_*` slots and are typecheck-gated separately).
