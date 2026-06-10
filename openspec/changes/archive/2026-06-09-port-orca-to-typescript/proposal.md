## Why

The existing Scala `orca` implementation proves the workflow model, but its contributor pool, runtime distribution, and ecosystem fit are narrower than the intended audience. A TypeScript port preserves the "script-like with types" thesis while making the tool easier to author and ship for TypeScript-heavy agent workflows.

## What Changes

- Introduce a standalone TypeScript implementation of the Orca runtime, published from this repository rather than co-located with the Scala codebase.
- Port the core flow DSL, backend SPI, structured output model, stream convergence engine, terminal output, git/GitHub/filesystem tools, persistent plans, review loop, and reviewer prompt roster.
- Add a drift-minimizing parity harness that freezes the shared event/result model and gates each backend/flow slice against JSON golden fixtures.
- Ship a Bun-compiled standalone CLI binary plus an npm package for authoring, editor types, and `bunx` usage.
- Remove the existing interactive `ask_user`, human approval, and `Plan.interactive` implementation from v1 while reserving explicit event-model seams for a future deterministic design.
- Defer Claude Agent SDK and Effect-based internals behind stable runtime seams rather than making either the v1 foundation.
- **BREAKING**: This is a new TypeScript runtime, not a Scala-compatible binary or source-compatible Scala API.

## Capabilities

### New Capabilities

- `flow-runtime`: Direct-style TypeScript flow execution with ambient runtime context, typed structured output, branded backend session identifiers, and recoverable typed errors.
- `conversation-backends`: A pluggable backend SPI that converges Claude, OpenCode, Codex, Gemini, and Pi transports into one read-only conversation contract.
- `parity-harness`: Frozen JSON contracts and parity tests that minimize drift from the Scala oracle while keeping CI TypeScript-only.
- `plans-and-review`: Persistent plan execution, review/fix automation, reviewer prompt selection, terminal event output, and runtime-owned git/GitHub operations.
- `distribution`: Bun-compiled CLI distribution, npm authoring package, mandatory typecheck pre-flight, documentation, and ported non-interactive examples.

### Modified Capabilities

None.

## Impact

- Creates the initial `orca-ts` project structure, source packages, tests, fixtures, prompts, examples, documentation, OpenSpec specs, and release configuration.
- Adds runtime dependencies on `zod` and `neverthrow`, plus Bun/TypeScript toolchain dependencies for build, typecheck, and test execution.
- Requires a sibling Scala `orca` checkout only for local oracle comparison during implementation; generated fixtures and TypeScript tests are the CI contract.
- Establishes Apache 2.0 derivative-work attribution with `NOTICE` and VirtusLab credit.
