# Orca TypeScript

Orca TypeScript is a Bun and TypeScript workflow runner for deterministic coding-agent work.

Write a direct-style TypeScript flow, choose a backend such as Claude, Codex, OpenCode, or Pi, and let Orca provide the runtime pieces around it: a flow context, normalized conversation results, filesystem and git helpers, persistent plans, review loops, fixtures, and a CLI runner.

Use Orca TypeScript when you want coding-agent work to be expressed as code instead of a one-off prompt.

## Status

This repository is currently version `0.0.0`. It is usable for local development, examples, CI verification, and backend integration work. npm package publishing is not set up yet, so the normal path is to clone this repository and run flows with Bun.

Canonical repository: <https://github.com/ASRagab/orca-ts>

## Quickstart

### Requirements

- Bun `>=1.3.0`
- Git
- A TypeScript-capable editor
- At least one configured backend CLI when running live flows

### Install

```bash
git clone https://github.com/ASRagab/orca-ts.git
cd orca-ts
bun install --frozen-lockfile
```

### Verify The Repository

```bash
bun run verify
```

`bun run verify` runs typecheck, unit tests, fixture validation, release metadata validation, declaration generation, and a compiled binary smoke test. It does not require live backend credentials.

### Run The CLI

```bash
bun ./bin/orca --help
```

Run the smallest live example after installing and authenticating the Claude CLI:

```bash
bun ./bin/orca --backend claude examples/runnable/01-simple/index.ts
```

The runnable example calls `claude()` directly. The `--backend` flag validates the backend tag and sets `ORCA_BACKEND`, but your flow script still decides which backend constructor it uses.

## Write Your First Flow

Create a flow file in the repository root, for example `hello.ts`:

```ts
import { claude, flow, llm } from "./src/index.ts";

await flow()(async () => {
  const conversation = llm().autonomous(claude(), {
    prompt: "Say hello from an autonomous Orca flow."
  });

  const outcome = await conversation.awaitResult();
  if (outcome.type !== "success") {
    throw new Error(`Backend failed with outcome: ${outcome.type}`);
  }

  console.log(outcome.result.output);
});
```

Run it with the CLI:

```bash
bun ./bin/orca --backend claude hello.ts
```

Inside this repository, examples import from `./src/index.ts`. Package consumers should import from `orca` once they are using a linked or published package.

## Configure Backends

Orca normalizes backend output into one `Conversation` model, but each backend still needs its native CLI or server to be installed and authenticated.

| Backend | Flow constructor | Runtime requirement |
| --- | --- | --- |
| Claude | `claude()` | `claude` CLI on `PATH` and authenticated |
| Codex | `codex()` | `codex` CLI on `PATH` and authenticated |
| OpenCode | `opencode()` | `opencode` CLI on `PATH`; Orca manages `opencode serve` |
| Pi | `pi()` | `pi` CLI on `PATH` and authenticated |

Autonomous conversations are intended to complete without asking the human for input. If a backend needs credentials, approvals, or login setup, configure that backend before running the flow.

## CLI Reference

```bash
bun ./bin/orca [--backend <name>] [--no-typecheck] <flow.ts>
```

| Option | Meaning |
| --- | --- |
| `<flow.ts>` | TypeScript flow file to import and run |
| `--backend <name>` | Validates the backend tag and sets `ORCA_BACKEND` |
| `--no-typecheck` | Skips the `tsc --noEmit` pre-flight and sets `ORCA_TYPECHECK_SKIPPED=1` |
| `--help`, `-h` | Prints usage |

By default, the CLI typechecks the repository before importing the flow. Use `--no-typecheck` only when you intentionally want to skip that guard.

## Examples

The best way to learn the authoring model is to start with the examples.

| Example | What it shows |
| --- | --- |
| `examples/runnable/01-simple/index.ts` | Minimal autonomous flow |
| `examples/implement.ts` | Plan, implement, review, and fix loop |
| `examples/implement-enhanced.ts` | Larger implementation loop shape |
| `examples/issue-pr.ts` | Issue-to-PR style workflow |
| `examples/issue-pr-bugfix.ts` | Bugfix-oriented issue workflow |
| `examples/multi-backend-compare.ts` | Comparing backend behavior |
| `workflows/ai-slop-cleanup.ts` | Full dogfood workflow with monitoring support |

## Guides And Reference

| Document | Purpose |
| --- | --- |
| [Backend reference](docs/backends.md) | Backend adapter behavior and live smoke details |
| [Plans](docs/plans.md) | Persistent plan helpers under `.orca/` |
| [Review automation](docs/review.md) | Reviewer prompts, review loops, and fix execution |
| [Parity harness](docs/parity.md) | Fixture tiers, schema exports, and backend parity checks |
| [Distribution](docs/distribution.md) | Bun binary and package distribution notes |
| [Release checks](docs/release.md) | Release verification checklist |
| [Project language](CONTEXT.md) | Terminology used in code, docs, and agent work |
| [Agent notes](AGENTS.md) | Contributor and agent-facing implementation context |

## Public API Surface

The root export re-exports the main authoring modules:

```ts
import {
  claude,
  codex,
  currentFlowContext,
  flow,
  llm,
  opencode,
  pi,
  plan,
  review,
  z
} from "orca";
```

The package metadata currently exposes these entry points:

| Entry point | Purpose |
| --- | --- |
| `orca` | Root flow authoring API |
| `orca/model` | Shared model types and schemas |
| `orca/testing` | Test helpers |
| `bin.orca` | CLI entry point at `./bin/orca` |

Declaration files are generated with:

```bash
bun run build:types
```

Build the standalone Bun binary with:

```bash
bun run build:binary
./dist/orca --help
```

## Development Commands

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

Run the full deterministic gate before opening a pull request:

```bash
bun run verify
```

Run a live backend smoke only in an environment configured for that backend:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=claude bun test tests/integration/real-backend-smoke.test.ts
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=opencode bun test tests/integration/real-backend-smoke.test.ts
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=pi bun test tests/integration/real-backend-smoke.test.ts
```

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `bun` is missing or too old | Install Bun `>=1.3.0` and rerun `bun install --frozen-lockfile` |
| CLI prints typecheck errors | Run `bun run typecheck`, fix the TypeScript errors, then rerun the flow |
| Live flow cannot start a backend | Confirm the backend CLI is on `PATH`, authenticated, and usable outside Orca |
| `--backend` seems to do nothing | Check the flow file; the script still chooses which backend constructor it calls |
| Live backend smoke is skipped | Set `ORCA_REAL_BACKEND_SMOKE=1` and choose `ORCA_REAL_BACKEND` |
| OpenCode process keeps running | Own the backend instance and call `opencode().shutdown()` when your program is done |

## Contributing

Keep README content focused on users first: what Orca is, how to run it, how to write flows, and where to find reference material.

Implementation history, parity notes, and agent-specific guidance belong in `AGENTS.md`, `CONTEXT.md`, `docs/`, or archived OpenSpec changes rather than in the quickstart path.

Before submitting changes, run:

```bash
bun run verify
```

## License And Attribution

Orca TypeScript is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This is a derivative TypeScript port of Orca by VirtusLab. The original Orca project is Apache-2.0 licensed.
