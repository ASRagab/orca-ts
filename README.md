# Orcats

Orcats is a Bun and TypeScript workflow runner for deterministic coding-agent work.

Write a direct-style TypeScript flow, choose a backend such as Claude, Codex, OpenCode, or Pi, and let Orcats provide the runtime pieces around it: a flow context, normalized conversation results, filesystem and git helpers, persistent plans, loop execution, review loops, fixtures, and a CLI runner.

Use Orcats when you want coding-agent work to be expressed as code instead of a one-off prompt.

## Status

The package is version `0.2.3`. Install the public npm package for normal project use:

```bash
npm i @twelvehart/orcats
```

The package provides the TypeScript authoring API and the Bun-backed `orcats` CLI shim. GitHub Release binaries remain available when you need a standalone executable with no project `node_modules`.

Canonical repository: <https://github.com/ASRagab/orca-ts>

Documentation website: <https://ASRagab.github.io/orca-ts/>

## Quickstart

### Requirements

- Bun `>=1.3.0` for project installs and source development
- Git
- At least one configured backend CLI when running live flows

### Install

Use this when you are writing and versioning flows in a project:

```bash
npm i @twelvehart/orcats
npm i -D typescript
bunx -p @twelvehart/orcats orcats --version
```

`typescript` is only needed for editor feedback and the CLI typecheck preflight. Bun `>=1.3.0` must be on `PATH` because the npm CLI shim runs with Bun.

Flow files import from `@twelvehart/orcats`:

```ts
import { flow, llm, selectBackend } from "@twelvehart/orcats";
```

Run a flow with:

```bash
bunx -p @twelvehart/orcats orcats --backend claude hello.ts
```

### Optional Standalone Binary

Use this when you want to run a flow on a Unix-like machine without creating a package first:

```bash
curl -fsSL https://github.com/ASRagab/orca-ts/releases/latest/download/install.sh | bash
```

Pin a version or change the install directory with environment variables:

```bash
ORCA_VERSION=0.2.3 ORCA_INSTALL_DIR="$HOME/.local/bin" \
  bash <(curl -fsSL https://github.com/ASRagab/orca-ts/releases/download/v0.2.3/install.sh)
```

The standalone binary embeds the runtime API, so it can run a flow that imports from `@twelvehart/orcats` even when the flow project has no `node_modules`. If the project has its own `@twelvehart/orcats` package dependency, that project copy wins.

### Source Checkout

Use this for contributing to Orca itself.

```bash
git clone https://github.com/ASRagab/orca-ts.git
cd orca-ts
bun install --frozen-lockfile
bun run verify
```

`bun run verify` runs typecheck, unit tests, docs site build, doc-link checking, fixture validation, release metadata validation, declaration generation, the facade gate, and a compiled binary smoke test. It does not require live backend credentials.

## Write Your First Flow

Create `hello.ts`:

```ts
import { flow, llm, selectBackend } from "@twelvehart/orcats";

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
bunx -p @twelvehart/orcats orcats --backend claude hello.ts
```

Inside this repository, examples import from `./src/index.ts`. Package consumers should import from `@twelvehart/orcats`.

## Configure Backends

Orca normalizes backend output into one `Conversation` model, but each backend still needs its native CLI or server to be installed and authenticated.

| Backend | Flow constructor | Runtime requirement |
| --- | --- | --- |
| Claude | `claude()` | `claude-agent-acp` on `PATH`, or `ORCA_CLAUDE_ACP_COMMAND` set; use `ORCA_CLAUDE_TRANSPORT=stream-json` to fall back to the authenticated `claude` CLI |
| Codex | `codex()` | `codex` CLI on `PATH` and authenticated |
| OpenCode | `opencode()` | `opencode` CLI on `PATH` and authenticated; Orca manages `opencode serve` |
| Pi | `pi()` | `pi` CLI on `PATH` and authenticated |

Autonomous conversations are intended to complete without asking the human for input. If a backend needs credentials, approvals, or login setup, configure that backend before running the flow.

### Selecting A Backend At Run Time

`selectBackend()` reads `ORCA_BACKEND` and returns the selected backend plus an optional `shutdown` hook:

```ts
const selected = selectBackend({
  default: "codex",
  perBackend: {
    codex: { approvalPolicy: "never" },
    opencode: { model: "provider/model" }
  }
});
```

Precedence:

1. `ORCA_BACKEND` overrides `default`.
2. `ORCA_BACKEND_MODEL` overrides `perBackend[tag].model` and `config.model`.
3. Flow code that calls `claude()`, `codex()`, `opencode()`, or `pi()` directly pins the backend and ignores `--backend`.

## Loops

A loop is a flow that repeats a cycle until a measurable goal is met. Use it when the work has a progress signal: failing gates, pending tasks, open issues, confidence, or a fixed cycle count.

```ts
import { codex, loop, untilManifestComplete, type TaskManifest } from "@twelvehart/orcats";

const result = await loop<TaskManifest>("ralph")
  .reason(codex(), { prompt: "Pick the next pending task and implement it." })
  .step("mark-one-task-complete", passOneTask)
  .until(untilManifestComplete())
  .guard({ maxIterations: 10 })
  .run(manifest);
```

Presets such as `untilManifestComplete()`, `untilGatesGreen()`, `untilNoIssues()`, `untilConfident(threshold)`, and `times(n)` supply the convergence measure. Add `.guard({ maxIterations, wallClockMs, tokenBudget })` for seatbelts. A loop with no preset or custom `.measure()` fails before it runs.

Loop execution owns recurrence, cycle reports, guards, token budgets, and optional context pressure. `fixLoop` remains the public generic convergence primitive over the same execution path; `executeLoop` is internal. Managed context is explicit: pass `context` to `.run()` when you want model-visible observations compacted/offloaded. Without it, raw reason/step observations are not captured.

Distributable loops live as import-safe modules under `.orca/loops/` and export `defineLoop({ name, source, sink, onTrigger })`. Use `orcats loops` to list them, `orcats run <loop>` to run one firing, and `orcats serve <loop>` to host the trigger. `orcats run` and served children share one firing contract for event decoding, `defineLoop().run`, sink emission, diagnostics, and stop-reason exit codes.

Start with the full guide: [Loops](docs/loops.md). It covers the first-loop tutorial, presets, custom measures, state stores, fan-out/fan-in, loop modules, `orcats run/serve/loops`, recipes, troubleshooting, and migration from legacy workflow scripts.

## CLI Reference

```bash
orcats [--backend <name>] [--no-typecheck] <flow.ts> [-- <task args>]
orcats run <loop>      # run a loop once; exit status reflects the stop reason
orcats serve <loop>    # host a loop's trigger, spawning a child process per firing
orcats loops           # list defined loops with their source and sink
orcats --version
```

| Command | Meaning |
| --- | --- |
| `<flow.ts>` | Legacy script path: import and run a flow file (unchanged behavior) |
| `run <loop>` | Run a loop once. `<loop>` is a loop module path or a registered loop name; exit code reflects the stop reason |
| `serve <loop>` | Run a thin supervisor that owns the loop's trigger `Source` and spawns one isolated child process per firing through the shared firing contract |
| `loops` | Discover and list loops from `.orca/loops/` without firing any trigger, backend, or sink |

| Option | Meaning |
| --- | --- |
| `--backend <name>` | Validates the tag and sets `ORCA_BACKEND`, which `selectBackend()` reads |
| `--no-typecheck` | Skips the `tsc --noEmit` pre-flight and sets `ORCA_TYPECHECK_SKIPPED=1` |
| `--version`, `-v` | Prints `orcats <version>` |
| `--help`, `-h` | Prints usage |
| `-- <task args>` | Everything after `--` is the flow/loop task input, read via `flowArgs()` |

Loop verbs and the legacy script path share one preflight: the typecheck guard, `--backend`, and the `--` task-arg channel apply to all of them. By default, the CLI typechecks the current project before importing when it can find project typecheck setup: `typescript`, `tsconfig.json`, and a local `@twelvehart/orcats` package dependency. A standalone binary flow in a zero-project directory without `tsconfig.json` skips this guard. Use `--no-typecheck` only when you intentionally want to skip it.

During a run, Orcats writes synthesized progress diagnostics to stderr from structured run-output events. Stdout stays reserved for explicit flow output and loop sink payloads.

The default state adapter needs no service. Use the sqlite store when a loop needs local crash recovery or longer-lived checkpoint history.

## Examples

The best way to learn the authoring model is to start with the examples.

| Example | What it shows |
| --- | --- |
| `examples/runnable/01-simple/index.ts` | Minimal autonomous flow that honors `--backend` through `selectBackend()` |
| `examples/implement.ts` | Plan, implement, review, and fix loop |
| `examples/implement-enhanced.ts` | Larger implementation loop shape |
| `examples/issue-pr.ts` | Issue-to-PR style workflow |
| `examples/issue-pr-bugfix.ts` | Bugfix-oriented issue workflow |
| `examples/linear-ticket-triage.ts` | Linear ticket triage loop with fake Linear and Slack IO |
| `examples/multi-backend-compare.ts` | Comparing backend behavior |
| `examples/epic.ts` | Structured output with a Zod schema and a directly pinned `codex()` backend |
| `examples/loop-single-cycle.ts` | A single-cycle preset loop (`loop()` + `untilManifestComplete()`), runnable with no real backend |
| `examples/loop-gated-task.ts` | A gate-converging loop using `untilGatesGreen()` |
| `examples/loop-fanout.ts` | A fan-out / fan-in loop: bounded-concurrency branches joined through a reducer |
| `examples/loop-persisted-state.ts` | Snapshot state store checkpoint, history, branch, and merge |
| `examples/loop-served-trigger.ts` | Import-safe `defineLoop()` module for `.orca/loops/` |
| `workflows/ai-slop-cleanup.ts` | Full dogfood workflow with monitoring support |

## Agent Skills

Installable Agent Skills under `skills/` take a coding agent from "I have an
Orcats automation idea" to a saved, self-validating workflow or loop module — in
**any** git-backed repo, not just TypeScript projects. They compose as a
pipeline:

| Skill | Purpose |
| --- | --- |
| `skills/orcats-setup` | Install or verify the `orcats` CLI and verify at least one backend (claude/codex/opencode/pi) is authenticated; re-runnable as a doctor |
| `skills/orcats-author` | Detect the target repo's real test/lint commands, interview for the workflow or loop shape, generate an artifact that typechecks, and respect the loop execution/source/sink contracts |
| `skills/orcats-flow` | Run a saved workflow or loop with monitoring, detect stalls from progress/context-pressure evidence rather than slowness, and heal backend/auth/non-convergence failures within safety bounds |

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
npx skills add ASRagab/orca-ts --skill orcats-setup --agent claude-code
```

Without `--global` the skills install into the current repo's agent directory
(project scope). Install order does not matter, but the intended flow is
`orcats-setup` → `orcats-author` → `orcats-flow`. Each skill is a
self-contained directory — its `SKILL.md` plus its own `scripts/`, `reference/`,
and flow templates — so there is no shared payload to install separately.

Before the repo is public, install from a local checkout instead:

```bash
git clone https://github.com/ASRagab/orca-ts.git
npx skills add ./orca-ts --skill '*' --global
```

### Run A Saved Workflow

Saved one-shot workflows live at the target repo's `.orca/workflows/<name>.ts`
and are triggered through the Orcats CLI:

```bash
orcats --backend <tag> .orca/workflows/<name>.ts [-- "<task args>"]
```

Reusable loop modules live under `.orca/loops/<name>.ts` and use the loop CLI:

```bash
orcats loops
orcats run <name-or-path>
orcats serve <name-or-path>
```

Detailed guidance lives in each skill's `SKILL.md`.

## Guides And Reference

| Document | Purpose |
| --- | --- |
| [Backend reference](docs/backends.md) | Backend adapter behavior and live smoke details |
| [Saved workflows](docs/workflows.md) | Generated workflow gates, baseline policy, and runbook behavior |
| [Loops](docs/loops.md) | Loop tutorial, recipes, API notes, state, distribution, and troubleshooting |
| [Plans](docs/plans.md) | Persistent plan helpers under `.orca/` |
| [Review automation](docs/review.md) | Reviewer prompts, review loops, and fix execution |
| [Parity harness](docs/parity.md) | Fixture tiers, schema exports, and backend parity checks |
| [Distribution](docs/distribution.md) | npm package, GitHub Release binaries, installer, and embedded import notes |
| [Release checks](docs/release.md) | Release runbook |
| [Project language](CONTEXT.md) | Terminology used in code, docs, and agent work |
| [Agent notes](AGENTS.md) | Contributor and agent-facing implementation context |

## Public API Surface

The root export re-exports the main authoring modules:

```ts
import {
  captureDirtyBaselineSnapshot,
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
  resolveBaselinePolicy,
  runBaselineGate,
  selectBackend,
  z
} from "@twelvehart/orcats";
```

The package metadata exposes these entry points:

| Entry point | Purpose |
| --- | --- |
| `@twelvehart/orcats` | Root flow authoring API |
| `@twelvehart/orcats/model` | Shared model types and schemas |
| `@twelvehart/orcats/testing` | Test helpers |
| `bin.orcats` | Bun CLI shim installed by the npm package and source checkouts; release installs use the compiled standalone binary |

## Development Commands

```bash
bun run typecheck
bun test
bun run docs:check
bun run lint
bun run validate:fixtures
bun run validate:release
bun run validate:package
bun run build:types
bun run build:binary
bun run build:release
bun run smoke:package
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
| `orcats` is not found after npm install | Run it through the local package bin with `bunx -p @twelvehart/orcats orcats`, or add `node_modules/.bin` to your script path |
| `orcats: missing project typecheck setup` warning | Add `typescript`, `tsconfig.json`, and a local `@twelvehart/orcats` package dependency in the flow project to restore the typecheck guard |
| Live flow cannot start a backend | Confirm the backend CLI or adapter is on `PATH`, authenticated, and usable outside Orcats |
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

Orcats is licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Scala Orca by VirtusLab was the starting point and reference for this TypeScript-native reimagining. The original Orca project is Apache-2.0 licensed.
