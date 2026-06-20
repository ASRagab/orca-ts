# loop-builder Specification

## Purpose
TBD - created by archiving change add-loop-builder. Update Purpose after archive.
## Requirements
### Requirement: Declarative loop builder lowers to the existing engine
The system SHALL provide a declarative `loop()` builder as the authoring front door that lowers to `flow()` plus the loop execution module. Loop execution SHALL own recurrence, cycle body execution, guards, stop evaluation, and per-cycle progress. `fixLoop` SHALL remain a public generic convergence primitive with the existing issue-list overload preserved for current callers, but the builder SHALL NOT depend on the review module as its recurrence root. A single-cycle loop SHALL be authorable without graph, fan-out, or Effect knowledge.

#### Scenario: Minimal loop is authorable and runs
- **WHEN** an author writes `loop(name).reason(backend, request).until(pred).guard(opts)` and runs it
- **THEN** the builder produces a `flow()` invocation whose convergence is driven by loop execution, and the run returns a `Result` value with a stop reason

#### Scenario: Existing fixLoop callers keep working
- **WHEN** existing review or plan code calls `fixLoop(evaluateIssues, fixIssues, options)`
- **THEN** the call compiles and preserves the previous issue-list behavior and stop reasons, except for additive stop values

#### Scenario: Builder output is readable without engine internals
- **WHEN** a reader inspects a flow file authored with `loop()`
- **THEN** no Effect type, queue, or conversation-machinery symbol appears in the authored source

### Requirement: Loops are cyclic graphs with termination by construction
The system SHALL model a loop as a directed graph of nodes (deterministic steps and a single `.reason()` LLM verb) with forward edges and back-edges. Every back-edge MUST carry a termination contract — a loop variant with a floor plus guards. A loop containing a back-edge with no variant SHALL fail at build/lint time.

#### Scenario: Back-edge without a variant is rejected
- **WHEN** a loop defines a back-edge but supplies neither a preset archetype nor `.measure()`
- **THEN** the build/lint step fails with an error naming the unguarded cycle

#### Scenario: Intentional back-edges are distinguished from accidental cycles
- **WHEN** the graph is analyzed
- **THEN** declared loop back-edges are recorded as first-class data, distinct from any unintended cycle, which is reported

### Requirement: Preset termination archetypes satisfy the variant without manual authoring
The system SHALL provide preset archetypes that bundle a measure and sane guards — at minimum `untilGatesGreen()`, `untilManifestComplete()`, `untilNoIssues()`, `untilConfident(threshold)`, and `times(n)` — and SHALL provide `.measure(fn)` as a power-user override. Choosing a preset SHALL satisfy the termination contract.

#### Scenario: Preset supplies the variant
- **WHEN** a loop uses `untilManifestComplete()`
- **THEN** the variant is derived from the manifest's pending-task count with no author-supplied measure, and the build passes

#### Scenario: Custom measure overrides a preset
- **WHEN** an author supplies `.measure(fn)`
- **THEN** the custom variant is used and the loop builds

### Requirement: Bounded fan-out and join-policy fan-in are opt-in combinators
The system SHALL provide opt-in `fanOut` (with a concurrency bound) and `fanIn` (with a join policy of `barrier | race | quorum | reduce`, a merge reducer, and a partial-failure policy). Omitting them SHALL leave the single-cycle authoring surface unchanged.

#### Scenario: Fan-out is concurrency-bounded
- **WHEN** a loop fans out N branches with `maxConcurrency = k`
- **THEN** at most `k` branches execute concurrently

#### Scenario: Fan-in applies the declared join policy
- **WHEN** branches complete under a `quorum` policy of `k`
- **THEN** the loop proceeds once `k` branches agree and the reducer merges their results into one state
