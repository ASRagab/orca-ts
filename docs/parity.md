# Parity Harness

The canonical model lives in `src/model` and exports JSON Schema fixtures under `fixtures/canonical/schemas`.

Tier 1 backend fixtures belong under `fixtures/tier1/<backend>` and compare scripted transport input to normalized conversation events and final results.

Tier 2 flow fixtures belong under `fixtures/tier2` and compare user-visible behavior: commits, persisted plan files, terminal output, and runtime events.

The Scala repository is a local oracle for fixture creation only. CI runs TypeScript checks without the JVM.
