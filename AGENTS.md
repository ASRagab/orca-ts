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

## Parity And History

- The Scala Orca repository was the local oracle for fixture creation and prompt parity.
- CI runs TypeScript checks without the JVM.
- Reviewer prompts are copied from the Scala oracle and tested for byte parity.
- Runtime parity is tracked through fixtures and `fixtures/adr/matrix.json`.
- Tier 3 real-agent evals are opt-in and excluded from the default verification gate.

## Verification

- Use `bun run verify` as the deterministic pre-PR gate.
- `bun run verify` covers typecheck, tests, fixture validation, release metadata validation, declaration generation, and a compiled-binary smoke that runs a real flow importing `orca-ts` outside the repo.
- Run live backend smoke only with explicit environment gates, for example `ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts`.

## Documentation Placement

- Keep `README.md` organized for human users: overview, quickstart, configuration, guides, reference, troubleshooting.
- Keep detailed backend adapter behavior in `docs/backends.md`.
- Keep plan behavior in `docs/plans.md`.
- Keep review-loop behavior in `docs/review.md`.
- Keep fixture and parity details in `docs/parity.md`.
- Keep distribution and release mechanics in `docs/distribution.md` and `docs/release.md`.
