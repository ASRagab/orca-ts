# Orca TypeScript

Orca TypeScript is a Bun and TypeScript workflow runner for deterministic coding-agent work.

Write a direct-style TypeScript flow, choose a backend such as Claude, Codex, OpenCode, or Pi, and let Orca provide the runtime pieces around it: a flow context, normalized conversation results, filesystem and git helpers, persistent plans, review loops, fixtures, and a CLI runner.

Use Orca TypeScript when you want coding-agent work to be expressed as code instead of a one-off prompt.

## Status

The package is version `0.1.0`. The canonical install path is the standalone `orca` binary from GitHub Releases. npm publishing is deferred.

Canonical repository: <https://github.com/ASRagab/orca-ts>

## Quickstart

### Requirements

- Bun `>=1.3.0` for project installs and source development
- Git
- At least one configured backend CLI when running live flows

### Install Option 1: Standalone Binary

Use this when you want to run a flow on a unix-y machine without creating a package first.

```bash
curl -fsSL https://raw.githubusercontent.com/ASRagab/orca-ts/main/install.sh | bash
```

Pin a version or change the install directory with environment variables:

```bash
ORCA_VERSION=0.1.0 ORCA_INSTALL_DIR="$HOME/.local/bin" \
  bash <(curl -fsSL https://raw.githubusercontent.com/ASRagab/orca-ts/main/install.sh)
```

The binary can run a flow that imports from `orca-ts` even when the flow project has no `node_modules`. If the project has its own `orca-ts` Git/source dependency, that project copy wins. In a zero-project directory with no `tsconfig.json`, the standalone binary skips the typecheck guard and emits a warning before running. Project typechecking needs a local `typescript` dependency, a `tsconfig.json`, and a local `orca-ts` Git/source dependency.

### Install Option 2: Typed Project Authoring

Use this when you are writing and versioning flows in a project. Until npm publishing is restored, install the library from Git and run flows with the standalone `orca` binary.

```bash
bun add -d git+https://github.com/ASRagab/orca-ts.git typescript
orca --version
```

Flow files import from `orca-ts`:

```ts
import { flow, llm, selectBackend } from "orca-ts";
```

Run a flow with:

```bash
orca --backend claude hello.ts
```

### Install Option 3: Source Checkout

Use this for contributing to Orca itself.

```bash
git clone https://github.com/ASRagab/orca-ts.git
cd orca-ts
bun install --frozen-lockfile
bun run verify
```

`bun run verify` runs typecheck, unit tests, doc-link checking, fixture validation, release metadata validation, declaration generation, and a compiled binary smoke test. It does not require live backend credentials.

## Write Your First Flow

Create `hello.ts`:

```ts
import { flow, llm, selectBackend } from "orca-ts";

await flow()(async () => {
  const selected = selectBackend({ default: "claude" });
  try {
    const conversation = llm().autonomous(selected.backend, {
      prompt: "Say hello from an autonomous Orca flow."
    });

    const outcome = await conversation.awaitResult();
    if (outcome.type !== "success") {
      throw new Error(`Backend failed with outcome: ${outcome.type}`);
    }

    console.log(outcome.result.output);
  } finally {
    await selected.shutdown?.();
  }
});
```

Run it with the CLI:

```bash
orca --backend claude hello.ts
```

Inside this repository, examples import from `./src/index.ts`. Package consumers should import from `orca-ts`.

## Configure Backends

Orca normalizes backend output into one `Conversation` model, but each backend still needs its native CLI or server to be installed and authenticated.

| Backend | Flow constructor | Runtime requirement |
| --- | --- | --- |
| Claude | `claude()` | `claude` CLI on `PATH` and authenticated |
| Codex | `codex()` | `codex` CLI on `PATH` and authenticated |
| OpenCode | `opencode()` | `opencode` CLI on `PATH`; Orca manages `opencode serve` |
| Pi | `pi()` | `pi` CLI on `PATH` and authenticated |

Autonomous conversations are intended to complete without asking the human for input. If a backend needs credentials, approvals, or login setup, configure that backend before running the flow.

### Selecting A Backend At Run Time

`selectBackend()` reads `ORCA_BACKEND` and returns the selected backend plus an optional `shutdown` hook:

```ts
const selected = selectBackend({
  default: "codex",
  perBackend: {
    codex: { approvalPolicy: "never" },
    opencode: { model: "openai/gpt-5.5" }
  }
});
```

Precedence:

1. `ORCA_BACKEND` overrides `default`.
2. `ORCA_BACKEND_MODEL` overrides `perBackend[tag].model` and `config.model`.
3. Flow code that calls `claude()`, `codex()`, `opencode()`, or `pi()` directly pins the backend and ignores `--backend`.

## Loops

A loop is a flow that repeats a cycle until a measurable goal is met. `loop()` reads like a guarded `while`: declare the per-cycle work, declare the measure that must reach zero, and `.run()` lowers it onto `flow()` plus the generic convergence primitive. The single-cycle case names no engine, queue, or `Effect` symbol.

```ts
import { codex, loop, untilManifestComplete, type TaskManifest } from "orca-ts";

const result = await loop<TaskManifest>("ralph")
  .reason(codex(), { prompt: "Pick the next pending task and implement it." })
  .step("mark-one-task-complete", passOneTask)
  .until(untilManifestComplete())
  .guard({ maxIterations: 10 })
  .run(manifest);
```

| Method | Purpose |
| --- | --- |
| `.reason(backend, request)` | The single LLM verb; drives a backend autonomously for one cycle |
| `.step(name, fn)` | A deterministic transform over the threaded loop state |
| `.until(variant)` | The termination variant — a preset (below) or a custom `{ measure }` |
| `.measure(fn)` | Power-user variant override; takes precedence over a preset |
| `.guard({ maxIterations, wallClockMs, tokenBudget })` | Seatbelt guards layered under the variant |
| `.run(initial, options?)` | Build (enforcing termination by construction) then run; returns `Result<LoopOutcome, LoopRunError>` |

A back-edge with no variant fails at build time, not at run time: a loop must declare what converges. Full runnable version: [`examples/loop-single-cycle.ts`](examples/loop-single-cycle.ts).

### Preset Archetypes

A preset bundles a loop variant (a measure with floor `0`) so the author writes no measure math:

| Preset | Converges when |
| --- | --- |
| `untilGatesGreen()` | failing tests/gates reach `0` |
| `untilManifestComplete()` | the task manifest has no pending task |
| `untilNoIssues()` | the open-issue list is empty |
| `untilConfident(threshold)` | confidence reaches the threshold |
| `times(n)` | `n` cycles have run (also contributes a `maxIterations` ceiling) |

### Fan-out / Fan-in

Bounded fan-out and join-policy fan-in are opt-in combinators; a plain loop never needs them. `fanOut` runs each branch over an isolated `structuredClone` of the state under a concurrency cap; `fanIn` applies a join policy (`barrier`, `race`, `quorum`, `reduce`) then a reducer — the only point where branch state recombines. See [`examples/loop-fanout.ts`](examples/loop-fanout.ts).

### State Adapters

Loop state targets the `StateStore` port (`load` / `checkpoint` / `branch` / `merge` / `history`); swapping the adapter never changes the loop definition.

| Adapter | Factory | Use |
| --- | --- | --- |
| Snapshot (default) | `createSnapshotStore({ root })` | Zero-config; one JSON file per cycle at `.orca/state-<hash>.json` |
| SQLite | `createSqliteStore({ path })` | Durable mid-loop resume: per-step WAL checkpoint, lease-based crash recovery, `history` table |

`createSqliteStore` runs on `bun:sqlite` and returns a `Result` because it touches the filesystem on open. Durable service-backed modes (DBOS, Dolt) are deferred — see [Agent notes](AGENTS.md). The Effect-powered engine that drives cycles, recurrence, and bounded concurrency never reaches this authoring surface; a verify-blocking facade gate enforces it.

### Distributing A Loop

`defineLoop({ name, source, sink, onTrigger })` packages a loop with its trigger `Source` and output `Sink`. A loop module exports the definition; importing it only registers it (no trigger fires, no backend runs), so `orca loops` discovery is side-effect-free. Place loop modules under `.orca/loops/`. `orca run <loop>` runs one firing; `orca serve <loop>` hosts the trigger and spawns an isolated child per firing.

## CLI Reference

```bash
orca [--backend <name>] [--no-typecheck] <flow.ts> [-- <task args>]
orca run <loop>      # run a loop once; exit status reflects the stop reason
orca serve <loop>    # host a loop's trigger, spawning a child process per firing
orca loops           # list defined loops with their source and sink
orca --version
```

| Command | Meaning |
| --- | --- |
| `<flow.ts>` | Legacy script path: import and run a flow file (unchanged behavior) |
| `run <loop>` | Run a loop once. `<loop>` is a loop module path or a registered loop name; exit code reflects the stop reason |
| `serve <loop>` | Run a thin supervisor that owns the loop's trigger `Source` and spawns one isolated child process per firing |
| `loops` | Discover and list loops from `.orca/loops/` without firing any trigger, backend, or sink |

| Option | Meaning |
| --- | --- |
| `--backend <name>` | Validates the tag and sets `ORCA_BACKEND`, which `selectBackend()` reads |
| `--no-typecheck` | Skips the `tsc --noEmit` pre-flight and sets `ORCA_TYPECHECK_SKIPPED=1` |
| `--version`, `-v` | Prints `orca <version>` |
| `--help`, `-h` | Prints usage |
| `-- <task args>` | Everything after `--` is the flow/loop task input, read via `flowArgs()` |

Loop verbs and the legacy script path share one preflight: the typecheck guard, `--backend`, and the `--` task-arg channel apply to all of them. By default, the CLI typechecks the current project before importing when it can find project typecheck setup: `typescript`, `tsconfig.json`, and a local `orca-ts` Git/source dependency. A zero-project standalone binary flow without `tsconfig.json` skips this guard. Use `--no-typecheck` only when you intentionally want to skip it.

Durable, service-backed loop modes (`--durable`, `--postgres-url`, `--state dbos`) are parsed but rejected with a pointer to the deferral rationale — see [Agent notes](AGENTS.md). The default state adapter needs no service.

## Examples

The best way to learn the authoring model is to start with the examples.

| Example | What it shows |
| --- | --- |
| `examples/runnable/01-simple/index.ts` | Minimal autonomous flow that honors `--backend` through `selectBackend()` |
| `examples/implement.ts` | Plan, implement, review, and fix loop |
| `examples/implement-enhanced.ts` | Larger implementation loop shape |
| `examples/issue-pr.ts` | Issue-to-PR style workflow |
| `examples/issue-pr-bugfix.ts` | Bugfix-oriented issue workflow |
| `examples/multi-backend-compare.ts` | Comparing backend behavior |
| `examples/epic.ts` | Structured output with a Zod schema and a directly pinned `codex()` backend |
| `examples/loop-single-cycle.ts` | A single-cycle preset loop (`loop()` + `untilManifestComplete()`), runnable with no real backend |
| `examples/loop-fanout.ts` | A fan-out / fan-in loop: bounded-concurrency branches joined through a reducer |
| `workflows/ai-slop-cleanup.ts` | Full dogfood workflow with monitoring support |

## Agent Skills

Installable Agent Skills under `skills/` take a coding agent from "I have a
workflow idea" to a saved, self-validating workflow — in **any** git-backed repo,
not just TypeScript projects. They compose as a pipeline:

| Skill | Purpose |
| --- | --- |
| `skills/orca-ts-setup` | Install the `orca` binary and verify at least one backend (claude/codex/opencode/pi) is authenticated; re-runnable as a doctor |
| `skills/orca-ts-author` | Detect the target repo's real test/lint commands, interview for the workflow shape, generate a flow that typechecks, and enforce verification gates |
| `skills/orca-ts-flow` | Run a saved workflow with monitoring, detect stalls (by progress, not slowness), and heal backend/auth/non-convergence failures within safety bounds |

### Install The Skills

The skills install with the [`skills` CLI](https://github.com/vercel-labs/skills)
(`npx skills`), which reads the `skills/<name>/` directories in this repo and
copies each into your coding agent's skills directory:

```bash
# See which skills the repo provides
npx skills add ASRagab/orca-ts --list

# Install all three, user-level (works for every detected agent)
npx skills add ASRagab/orca-ts --skill '*' --global

# Or install one skill to one agent (e.g. Claude Code)
npx skills add ASRagab/orca-ts --skill orca-ts-setup --agent claude-code
```

Without `--global` the skills install into the current repo's agent directory
(project scope). Install order does not matter, but the intended flow is
`orca-ts-setup` → `orca-ts-author` → `orca-ts-flow`. Each skill is a
self-contained directory — its `SKILL.md` plus its own `scripts/`, `reference/`,
and flow templates — so there is no shared payload to install separately.

Before the repo is public, install from a local checkout instead:

```bash
git clone https://github.com/ASRagab/orca-ts.git
npx skills add ./orca-ts --skill '*' --global
```

### Run A Saved Workflow

Saved workflows live at the target repo's `.orca/workflows/<name>.ts` and are
triggered through the standalone `orca` binary — no dependency on the target
repo's package manager:

```bash
orca .orca/workflows/<name>.ts --backend <tag> [-- "<task args>"]
```

Detailed guidance lives in each skill's `SKILL.md`.

## Guides And Reference

| Document | Purpose |
| --- | --- |
| [Backend reference](docs/backends.md) | Backend adapter behavior and live smoke details |
| [Plans](docs/plans.md) | Persistent plan helpers under `.orca/` |
| [Review automation](docs/review.md) | Reviewer prompts, review loops, and fix execution |
| [Parity harness](docs/parity.md) | Fixture tiers, schema exports, and backend parity checks |
| [Distribution](docs/distribution.md) | GitHub Release binaries, installer, and embedded import notes |
| [Release checks](docs/release.md) | Release runbook |
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
  loop,
  opencode,
  pi,
  plan,
  review,
  selectBackend,
  z
} from "orca-ts";
```

The package metadata exposes these entry points:

| Entry point | Purpose |
| --- | --- |
| `orca-ts` | Root flow authoring API |
| `orca-ts/model` | Shared model types and schemas |
| `orca-ts/testing` | Test helpers |
| `bin.orca` | CLI entry point at `./bin/orca` |

## Development Commands

```bash
bun run typecheck
bun test
bun run docs:check
bun run lint
bun run validate:fixtures
bun run validate:release
bun run build:types
bun run build:binary
bun run build:release
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
| `bun` is missing or too old | Install Bun `>=1.3.0` for source/project workflows; standalone binaries do not need Bun |
| CLI prints typecheck errors | Run `bun run typecheck`, fix the TypeScript errors, then rerun the flow |
| `orca: missing project typecheck setup` warning | Add `typescript`, `tsconfig.json`, and a local `orca-ts` Git/source dependency in the flow project to restore the typecheck guard |
| Live flow cannot start a backend | Confirm the backend CLI is on `PATH`, authenticated, and usable outside Orca |
| `--backend` seems to do nothing | The flow must call `selectBackend()`; direct `claude()`/`codex()` calls pin the backend |
| Installer fails on checksum | Re-run; if persistent, download the tarball and `SHA256SUMS.txt` from the release page manually |
| Live backend smoke is skipped | Set `ORCA_REAL_BACKEND_SMOKE=1` and choose `ORCA_REAL_BACKEND` |
| OpenCode process keeps running | Own the backend instance and call `opencode().shutdown()` when your program is done |

## Contributing

Keep README content focused on users first: what Orca is, how to install it, how to run it, how to write flows, and where to find reference material.

Implementation history, parity notes, and agent-specific guidance belong in `AGENTS.md`, `CONTEXT.md`, `docs/`, or archived OpenSpec changes rather than in the quickstart path.

Before submitting changes, run:

```bash
bun run verify
```

## License And Attribution

Orca TypeScript is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

This is a derivative TypeScript port of Orca by VirtusLab. The original Orca project is Apache-2.0 licensed.
