## Why

The loop-builder refactor shipped a large new authoring model, but the supporting
documentation is still scattered across README sections, archived design notes,
agent docs, and skill guidance. Users and coding agents need a single coherent
learning path that explains when to use loops, how to build them, how to run and
serve them, and how to migrate from legacy workflow patterns.

## What Changes

- Add a comprehensive loops guide covering tutorial, reference, recipes, and
  operational guidance for `loop()`, presets, guards, fan-out/fan-in, state
  adapters, sources/sinks, `defineLoop()`, and `orca run/serve/loops`.
- Reshape the README loops coverage into an approachable entry point that links
  to the deeper guide instead of carrying all details inline.
- Update agent-facing docs so future agents know where loop architecture belongs,
  which vocabulary to use, and how to avoid reviving deferred DBOS/Dolt/Gemini
  paths.
- Update in-repo Agent Skills and bundled reference material so authored flows
  can intentionally choose between legacy `.orca/workflows/` scripts and loop
  modules under `.orca/loops/`.
- Add or refresh examples that act as executable documentation for the core loop
  paths: minimal preset loop, gated task loop, fan-out/fan-in loop, persisted
  state, and served trigger loop.
- Keep this change documentation-only: no public runtime behavior, CLI behavior,
  backend support, or distribution behavior changes.

## Capabilities

### New Capabilities

- `loop-documentation`: User-facing and agent-facing loop documentation,
  examples, and skill guidance for building, running, serving, and maintaining
  Orca loops.

### Modified Capabilities

None. Existing loop runtime requirements do not change.

## Impact

- `README.md`
- `AGENTS.md`
- `docs/**/*.md`, with a likely new `docs/loops.md`
- `examples/**/*.ts`
- `skills/orca-ts-author/**`
- `skills/orca-ts-flow/**`
- `skills/orca-ts-setup/**` if setup/run guidance needs cross-links
- Documentation verification, example typechecking, and skill-template drift
  tests as applicable
