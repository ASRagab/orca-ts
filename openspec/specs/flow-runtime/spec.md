## Purpose

Define the TypeScript flow runtime surface, structured output behavior, typed error boundaries, and backend-branded session identifiers.
## Requirements
### Requirement: Direct-style flow execution
The system SHALL execute user flows as direct-style asynchronous TypeScript functions through a single `flow` entry point. Runtime services SHALL be resolved from an ambient `FlowContext` and SHALL support named overrides for tests and custom runtimes.

#### Scenario: Default flow context is available inside a flow
- **WHEN** a flow is started with default runtime arguments
- **THEN** tool accessors inside the async flow resolve against the active `FlowContext`

#### Scenario: Named overrides replace default runtime services
- **WHEN** a flow is started with an override for a runtime service
- **THEN** accessors inside the flow use the override instead of the default service

### Requirement: Flow scripts preserve author-time type feedback
The system MUST typecheck flow scripts with TypeScript before execution by default. The public API SHALL allow a single import surface for common flow helpers, tools, schemas, and backend constructors.

#### Scenario: Invalid flow script is rejected before execution
- **WHEN** a flow script fails `tsc --noEmit`
- **THEN** the runner exits before starting any agent backend process

#### Scenario: Common flow helpers compile from one import
- **WHEN** a flow script imports the public API from the Orca package
- **THEN** the script compiles without requiring backend-specific or internal module imports for standard flows

### Requirement: Structured output uses Zod schemas
The system SHALL define structured result schemas with Zod. The same schema SHALL provide runtime validation, inferred TypeScript types, and JSON Schema export for backends that support schema-constrained generation.

#### Scenario: Backend returns valid structured output
- **WHEN** a backend result matches the requested Zod schema
- **THEN** the runtime returns a typed structured value and records the raw result

#### Scenario: Backend returns invalid structured output
- **WHEN** a backend result does not match the requested Zod schema
- **THEN** the runtime returns a structured validation error that includes the raw result for debugging

### Requirement: Recoverable tool failures are typed results
When a backend call throws during a cleanup attempt, the runtime SHALL restore any in-progress file edits before surfacing the failure as a typed skipped result. A thrown backend error SHALL NOT leave the working tree dirty.

#### Scenario: Flow handles a known recoverable failure
- **WHEN** a backend call throws a known recoverable error
- **THEN** any in-progress file edits are restored to their pre-attempt state
- **THEN** the flow returns a typed skipped result rather than propagating the throw
- **THEN** the working tree contains no dirty files from the failed attempt

#### Scenario: Flow opts into throwing at a boundary
- **WHEN** a backend call throws at a configured boundary
- **THEN** the throw propagates to the caller
- **THEN** any in-progress file edits are still restored before propagation

### Requirement: Backend session identifiers are branded
Session identifiers SHALL be branded by backend tag so TypeScript rejects accidental cross-backend session usage at compile time.

#### Scenario: Session identifier is used with the matching backend
- **WHEN** a Claude session identifier is passed to a Claude conversation operation
- **THEN** the TypeScript program compiles

#### Scenario: Session identifier is used with the wrong backend
- **WHEN** a Claude session identifier is passed to a Codex conversation operation
- **THEN** the TypeScript program fails typechecking

### Requirement: Runtime commands report duration
The system SHALL include command duration in verification command results returned through the runtime command tool.

#### Scenario: Command succeeds with duration
- **WHEN** a flow runs a verification command that exits successfully
- **THEN** the command result is successful
- **THEN** the result includes stdout, stderr, exit code 0, rendered command, and duration in milliseconds

#### Scenario: Command fails with duration
- **WHEN** a flow runs a verification command that exits non-zero
- **THEN** the command result is failed
- **THEN** the result includes stdout, stderr, exit code, rendered command, and duration in milliseconds

### Requirement: Runtime commands can time out
The system SHALL allow verification commands to specify a timeout and SHALL fail timed-out commands explicitly.

#### Scenario: Command exceeds timeout
- **WHEN** a verification command runs longer than its configured timeout
- **THEN** the process is killed
- **THEN** the command result is failed with null exit code, elapsed duration, and an error message naming the timeout threshold

#### Scenario: Command finishes before timeout
- **WHEN** a verification command exits before its configured timeout
- **THEN** timeout handling does not alter the success or non-zero-exit result

### Requirement: Workflow validation preserves conservative gates
The cleanup workflow SHALL keep baseline validation and final full verification as required gates while timing each command in per-file validation.

#### Scenario: Baseline validation remains full gate
- **WHEN** the cleanup workflow starts a non-dry-run cleanup
- **THEN** lint, typecheck, and test baseline commands must pass before any agent turn starts

#### Scenario: Final verification remains full gate
- **WHEN** cleanup attempts finish
- **THEN** final `bun run verify` must pass before publish is allowed

#### Scenario: Per-file validation command summaries are timed
- **WHEN** per-file targeted validation runs after an accepted agent edit
- **THEN** each validation command summary includes duration and status for monitor and PR-body reporting

### Requirement: The loop builder lowers onto the flow runtime
The system SHALL implement `loop()` by lowering it onto `flow()`, reusing the existing dependency-injected runtime accessors. The loop builder SHALL NOT introduce a parallel public runtime.

#### Scenario: Loop accessors resolve from flow context
- **WHEN** a step inside a `loop()` calls a runtime accessor (`fs`/`git`/`llm`/…)
- **THEN** it resolves from the same flow context, including any test overrides supplied to the run

### Requirement: The execution engine is Effect-powered behind an Effect-free facade
The system SHALL implement the internal loop engine (scheduling, bounded concurrency, structured cancellation) with Effect, while keeping the public API and the flow-authoring surface free of any Effect type. The boundary SHALL bridge to neverthrow `Result`/plain values. Internal dependency injection MAY use Effect `Layer`, provided the authoring accessors remain plain functions exposing no Effect type.

#### Scenario: Public call returns a Result, not an Effect
- **WHEN** a loop is invoked through the public API
- **THEN** it returns a neverthrow `Result` (or plain value), and no Effect type appears in the public signature

#### Scenario: Structured cancellation interrupts in-flight branches
- **WHEN** a loop run is cancelled while fan-out branches are in flight
- **THEN** the engine interrupts the outstanding branches via structured concurrency and returns a cancelled outcome

### Requirement: A facade gate forbids Effect types in the authoring surface
The system SHALL enforce, via a type-test/lint check in the verification gate, that no Effect type appears in public runtime signatures or flow-authoring files. The gate SHALL scan generated declarations for the root runtime export (`orca-ts`) and the explicit loop export surface, plus authored flow files used by examples/tests (`examples/**/*.ts` and `.orca/workflows/**/*.ts`). Internal engine files under `src/loop/engine/**` MAY reference Effect. Testing helpers MAY expose fakes and assertions but SHALL NOT require ordinary loop tests to import Effect.

#### Scenario: Effect leak fails verification
- **WHEN** a root runtime signature, loop export signature, example flow, or `.orca/workflows` flow references an Effect type
- **THEN** the facade gate fails the `verify` run with an error identifying the leak

#### Scenario: Clean surface passes the gate
- **WHEN** the scanned public declarations and flow files expose only `Result`/plain types
- **THEN** the facade gate passes

### Requirement: Linear runtime accessor is available inside flows
The system SHALL expose a public `linear()` runtime accessor that resolves the
active `FlowContext` Linear tool. The default flow context SHALL provide a
`LinearTool`, and tests SHALL be able to replace it with an override.

#### Scenario: Flow uses default Linear accessor
- **WHEN** a flow starts with default runtime services and calls `linear()`
- **THEN** the accessor returns the active flow context's Linear tool

#### Scenario: Flow overrides Linear accessor
- **WHEN** a flow starts with a Linear tool override
- **THEN** calls to `linear()` inside the flow use the override instead of the default Linear tool

### Requirement: Linear progress updates can occur before final sink emission
The system SHALL allow flow and loop bodies to use `linear()` for intermediate
Linear updates before a final `Sink.emit()` call. Intermediate update failures
SHALL return typed results from `LinearTool` methods so authored flows can
decide whether to continue, retry, or fail.

#### Scenario: Loop emits an early Agent Activity
- **WHEN** a loop body receives a Linear Agent Session event and calls `linear()` before convergence
- **THEN** the loop can create an early Agent Activity without waiting for final sink emission

#### Scenario: Intermediate Linear update fails
- **WHEN** an intermediate Linear update fails
- **THEN** the `LinearTool` method returns an `err(RuntimeError)` that the authored flow can handle

