## Context

Loop distribution already has the right high-level model: `defineLoop()` packages a loop with a `Source`, `Sink`, and one-shot runner; `orca serve` owns triggers and spawns one child process per firing; `orca run` executes one loop once. The contract that connects those pieces is spread across `src/loop/serve.ts` and `src/cli/main.ts`: event serialization, child spawn args, `ORCA_LOOP_EVENT`, definition loading, sink emission, diagnostics, and exit-code mapping.

This change deepens the firing contract into one module so the supervisor and child agree on the same envelope and outcome rules. It does not change loop authoring, source/sink adapter semantics, or legacy flow-script execution.

## Goals / Non-Goals

**Goals:**

- Centralize loop firing event transfer, child spawn specs, child execution, diagnostics, and exit-code mapping.
- Keep `serve()` as a thin trigger supervisor that does not execute loop bodies in the supervisor process.
- Make `orca run <loop>` and served child execution use the same one-shot firing runner.
- Preserve import-only discovery and source/sink seams.
- Keep Linear and future integrations as ordinary `Source` and `Sink` adapters.

**Non-Goals:**

- No change to loop execution recurrence, state branching, or context compaction; those belong to `deepen-loop-execution`.
- No new hosted supervisor, queue daemon, or distributed execution mode.
- No automatic webhook registration or adapter-specific serve behavior.
- No breaking change to legacy `orca <flow.ts>` behavior.

## Decisions

### D1: Introduce a firing envelope module

Add a loop firing module that owns the parent-to-child contract: encode event, decode event, construct child spawn environment/args, run a loaded definition once, emit diagnostics, and map the result to an exit code.

The envelope should remain internal-first. Public testing types may be added only if they materially simplify deterministic tests.

Alternatives considered:

- Keep logic split between CLI and `serve()`: minimal change but keeps the contract implicit and easier to drift.
- Move all run/serve logic into CLI: couples library `serve()` behavior to CLI details and weakens testing for embedded use.

### D2: `serve()` delegates child creation but owns triggers

`serve()` continues to start the definition's `Source`, receive trigger events, track child handles, and kill children on stop. It delegates child spawn spec construction to the firing module and does not know how events are serialized.

This preserves D8: crash isolation comes from child processes, while the supervisor stays small and stable.

### D3: CLI loop run delegates one-shot firing

`orca run <loop>` loads the loop definition and calls the same one-shot firing runner used by served children. Direct user-invoked runs still support an absent event, matching current `undefined` event behavior.

Legacy `orca <flow.ts>` remains a separate flow-script path.

### D4: Preserve environment compatibility while making parsing explicit

The existing `ORCA_LOOP_EVENT` environment path can remain as the transport, but decoding moves into the firing module. JSON parse failures should retain current compatibility behavior unless tests and docs justify a stricter typed error.

### D5: Import-only discovery stays protected

Definition loading for listing must remain separate from firing. The firing module may load and run a target definition for `run`, but discovery for `loops` must import definitions without starting sources, invoking backends, or emitting sinks.

## Risks / Trade-offs

- Central module can become CLI-shaped -> keep legacy flow-script execution outside it and keep `serve()` source ownership in `serve.ts`.
- Tightening event decoding can break existing child runs -> preserve current raw-string fallback unless a later breaking change removes it.
- Tests can overfit implementation names -> assert behavioral symmetry: same event reaches the loop, same sink failures map to exit codes, and discovery remains side-effect-free.

## Migration Plan

1. Add firing envelope tests around encode/decode, spawn spec construction, child run success, loop failure, sink failure, and missing event.
2. Introduce the firing module behind existing CLI and `serve()` behavior.
3. Refactor `serve()` to delegate spawn specification while preserving child tracking and kill behavior.
4. Refactor `orca run <loop>` to delegate to the one-shot firing runner.
5. Update docs and examples if any user-facing behavior needs clearer wording.

Rollback is local: `serve()` and `cli/main.ts` can be restored to their current direct event handling because public loop definitions and source/sink adapters remain unchanged.

## Open Questions

- Should the firing envelope stay completely internal, or should a small testing surface be exported from `orca-ts/testing`?
- Should a future breaking change reject malformed `ORCA_LOOP_EVENT` JSON instead of preserving raw-string fallback?
