## Why

`orca serve` is documented as a thin supervisor that owns triggers and spawns an isolated child per firing, but the firing contract is currently spread across `serve()`, the CLI run path, environment serialization, loop loading, sink emission, and exit-code mapping. A deeper firing module will make supervisor and child behavior symmetric without making sources, sinks, or Linear-specific adapters special.

## What Changes

- Introduce one firing contract for parent-to-child loop execution: event envelope serialization, spawn spec construction, child event decoding, definition loading, run execution, sink emission, diagnostics, and exit mapping.
- Make `serve()` delegate child creation to that contract while remaining a thin trigger supervisor.
- Make `orca run <loop>` delegate one-shot loop firing through the same child-runner contract used by served children.
- Preserve import-only discovery: listing loops must still not start sources, run backends, or emit sinks.
- Preserve `Source` and `Sink` as the only loop-level trigger/output seams; Linear and future adapters remain ordinary sources and sinks.
- Keep existing legacy flow-script behavior unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `distribution`: loop run/serve/list behavior uses a single firing contract for child isolation, event transfer, diagnostics, and exit mapping.
- `loop-io`: sources and sinks remain the trigger/output seams under the deeper firing contract, and adapter behavior must not depend on supervisor internals.

## Impact

- Affected code: `src/loop/serve.ts`, `src/cli/main.ts`, loop definition loading helpers, distribution tests, CLI tests, docs, and examples.
- Affected APIs: no planned breaking API changes; possible additive internal/public testing types for firing envelopes or child spawners.
- Dependencies: no new runtime dependencies.
- Verification: targeted distribution and CLI tests, import-side-effect tests, typecheck, docs checks, and `bun run verify`.
