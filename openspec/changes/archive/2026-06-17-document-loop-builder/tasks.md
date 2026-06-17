## 1. Inventory And Content Map

- [x] 1.1 Search current loop mentions in `README.md`, `AGENTS.md`, `docs/`,
  `examples/`, and `skills/` and record the files that need edits.
- [x] 1.2 Compare current docs against the archived `add-loop-builder` decisions
  and list missing user-facing topics.
- [x] 1.3 Decide whether the final guide remains one `docs/loops.md` file or
  splits into tutorial/reference/recipes based on the drafted length.

## 2. Canonical Loop Guide

- [x] 2.1 Create the canonical loop guide, likely `docs/loops.md`, with the loop
  mental model and "when to use loops vs flows" guidance.
- [x] 2.2 Add a first-loop tutorial with a minimal runnable preset loop and its
  `orca run` command.
- [x] 2.3 Document termination contracts: presets, custom `.measure()`, guards,
  stuck detection, token budgets, and stop reasons.
- [x] 2.4 Document state: task manifests, snapshot store, sqlite store,
  `history`, `branch`, `merge`, resume behavior, and deferred DBOS/Dolt status.
- [x] 2.5 Document fan-out/fan-in: concurrency bounds, branch isolation, join
  policies, reducers, partial failure, and summary returns.
- [x] 2.6 Document distribution: `defineLoop()`, source/sink bindings,
  import-safe modules under `.orca/loops/`, `orca loops`, `orca run`, and
  `orca serve`.
- [x] 2.7 Add recipes for minimal loop, gated task loop, fan-out/fan-in loop,
  persisted-state loop, and served trigger loop.
- [x] 2.8 Add troubleshooting for unguarded cycles, non-convergence, missing
  usage data, state-store errors, source/sink failures, and served child
  process failures.

## 3. README And Agent Docs

- [x] 3.1 Trim `README.md` loop content to a concise entry point with a compact
  example, key CLI commands, and links to the canonical guide.
- [x] 3.2 Update `README.md` guide/reference links so users can find loop docs,
  distribution docs, migration notes, and skill guidance.
- [x] 3.3 Update `AGENTS.md` documentation-placement rules for `docs/loops.md`,
  examples, loop modules, and skill loop guidance.
- [x] 3.4 Fix or refresh any stale loop-builder paths in `AGENTS.md`, including
  archived deferred-state note paths if still referenced.

## 4. Examples And Skills

- [x] 4.1 Audit `examples/loop-single-cycle.ts` and `examples/loop-fanout.ts`
  against the public loop guide and update them if the docs expose different
  copyable patterns.
- [x] 4.2 Add missing checked examples for gated task loops, persisted state, or
  served trigger loops if no existing example covers those paths.
- [x] 4.3 Update `skills/orca-ts-author/SKILL.md` to ask whether the user wants a
  legacy workflow script or an import-safe loop module when both are plausible.
- [x] 4.4 Update `skills/orca-ts-author/reference/recipes.md`, `dsl.md`,
  `gotchas.md`, and `backends.md` with loop-module guidance and constraints.
- [x] 4.5 Add loop-module templates under `skills/orca-ts-author/assets/templates/`
  if templates are needed for repeatable authoring.
- [x] 4.6 Update `skills/orca-ts-flow/SKILL.md` so running, monitoring, and
  healing covers `orca run`, `orca serve`, and `orca loops` as well as legacy
  `orca <flow.ts>`.
- [x] 4.7 Update `skills/orca-ts-setup/SKILL.md` only if setup or run command
  examples need cross-links after the loop guide lands.

## 5. Verification And Review

- [x] 5.1 Run the docs link/check command that covers README and `docs/`.
- [x] 5.2 Run the example/template typecheck path covering any changed
  `examples/**/*.ts` and `skills/**/assets/templates/**/*.ts` files.
- [x] 5.3 Run `bun test tests/skill-templates.test.ts` if any skill template or
  duplicated skill script changes.
- [x] 5.4 Run `bun run verify` before PR if examples, templates, or public docs
  changed broadly.
- [x] 5.5 Do a final reader pass from README to `docs/loops.md` to one copied
  example and one skill runbook, confirming the path is coherent end to end.
