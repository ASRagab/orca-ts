# Orca TypeScript

Orca TypeScript is a source-first TypeScript port of Orca: deterministic coding-agent flows with author-time type feedback, shared conversation models, backend adapters, plan helpers, review prompts, and a Bun-powered CLI.

The project is currently version `0.0.0`. It is ready for local development and CI verification, but package publishing is not part of this productionization phase.

Canonical repository: <https://github.com/ASRagab/orca-ts>

## Prerequisites

- Bun `>=1.3.0`
- Git
- TypeScript-compatible editor support
- Codex CLI configured locally only when running the live Codex backend smoke

## Install

Clone the canonical repository and install locked dependencies:

```bash
git clone https://github.com/ASRagab/orca-ts.git
cd orca-ts
bun install --frozen-lockfile
```

Run the default verification gate before making or releasing changes:

```bash
bun run verify
```

`bun run verify` runs typecheck, unit tests, fixture validation, release metadata validation, declaration generation, and a compiled binary smoke. It does not run live backend integration checks and does not require backend credentials.

## Local Development

Useful scripts:

```bash
bun run typecheck
bun test
bun run lint
bun run validate:fixtures
bun run validate:release
bun run build:types
bun run build:binary
bun run smoke:binary
```

Build outputs are written under `dist/`. The package entry points are:

- CLI binary: `bin.orca -> ./bin/orca`
- Root authoring API: `orca`
- Model subpath: `orca/model`
- Testing helpers: `orca/testing`

The package currently exposes source files for local Bun usage and generates declaration files with `bun run build:types`.

## CLI Usage

Run a flow script from the repository:

```bash
bun ./bin/orca [--backend <name>] [--no-typecheck] <flow.ts>
```

Or build the standalone Bun binary first:

```bash
bun run build:binary
./dist/orca --help
./dist/orca examples/runnable/01-simple/index.ts
```

By default the CLI runs `tsc --noEmit` before importing the flow script. Use `--no-typecheck` only when you intentionally want to skip that pre-flight; the CLI records this as `ORCA_TYPECHECK_SKIPPED=1`.

`--backend <name>` validates the backend tag and sets `ORCA_BACKEND`, but the flow script still chooses which backend constructor it calls.

## TypeScript Authoring

Import the public helpers from the root export while working inside this repository:

```ts
import { codex, flow, llm } from "./src/index.ts";

await flow(process.argv.slice(2))(async () => {
  const conversation = llm().autonomous(codex(), {
    prompt: "Summarize the current repository status."
  });

  const outcome = await conversation.awaitResult();
  if (outcome.type !== "success") {
    throw new Error(JSON.stringify(outcome));
  }

  console.log(outcome.result.output);
});
```

The root export also re-exports `conversation`, `model`, `plan`, `review`, `runner`, `testing`, `tools`, and `z` from Zod. Common flow helpers include `flow`, `currentFlowContext`, `createDefaultFlowContext`, `flowContext`, `fs`, `git`, `gh`, `terminal`, `command`, `llm`, `plan`, and `review`.

## Backends

Backend tags are `claude`, `codex`, `opencode`, and `pi`.

Live v1 autonomous backends are `codex()`, `claude()`, `opencode()`, and `pi()`. Each drives its respective CLI (or managed server for OpenCode), so that CLI must be installed and authenticated before live backend checks can pass.

All live backends share the same `Conversation` contract, but their transports differ:

- `codex()`, `claude()`, and `pi()` run through the shared subprocess watchdog path.
- `opencode()` runs through a shared `opencode serve` manager over HTTP/SSE.
- Gemini is cut: its CLI is being deprecated by Google in favor of the Antigravity CLI (`agy`), and it never shipped a live streaming driver. Future Google support will be a new `agy` backend tag, not a revived Gemini backend.

Autonomous conversations reject human questions and live approval prompts. Explicit interactive Codex conversations can emit `user_question` events through the Orca-owned `ask_user` bridge; approval events remain a reserved compatibility seam.

Run the gated live smoke in an environment configured for the backend under test:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=claude bun test tests/integration/real-backend-smoke.test.ts
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=opencode bun test tests/integration/real-backend-smoke.test.ts
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=pi bun test tests/integration/real-backend-smoke.test.ts
```

## CI

GitHub Actions runs `.github/workflows/ci.yml` on pull requests and pushes to `main`.

The workflow checks out the repository, installs Bun, installs dependencies with `bun install --frozen-lockfile`, and runs:

```bash
bun run verify
```

The default CI workflow intentionally does not set `ORCA_REAL_BACKEND_SMOKE` and does not require Codex, Claude, OpenCode, or Pi credentials.

## Examples

Examples live under `examples/`:

- `examples/epic.ts`
- `examples/implement.ts`
- `examples/implement-enhanced.ts`
- `examples/issue-pr.ts`
- `examples/issue-pr-bugfix.ts`
- `examples/runnable/01-simple/index.ts`

Treat these as authoring references for the supported API surface. Structured examples still use `codex()` because it has the most mature structured-output and interactive coverage, not because the other live drivers are placeholders.

## Scope Cuts

This phase does not publish the npm package, enable live non-Codex process adapters, run live backend smoke checks in default CI, or implement live approval-event routing for Codex JSONL streams.

## Documentation

- [Backends](docs/backends.md)
- [Distribution](docs/distribution.md)
- [Parity harness](docs/parity.md)
- [Plans](docs/plans.md)
- [Release checks](docs/release.md)
- [Review automation](docs/review.md)

## License and Attribution

Orca TypeScript is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This is a derivative TypeScript port of Orca by VirtusLab. The original Orca project is Apache-2.0 licensed.
