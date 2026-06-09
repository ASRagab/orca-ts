## ADDED Requirements

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
Recoverable tool and runtime operations SHALL return `Promise<Result<T, E>>`, where `E` is a tagged discriminated union. The runtime SHALL provide a small helper for converting unrecovered failures into thrown errors at the flow author's chosen boundary.

#### Scenario: Flow handles a known recoverable failure
- **WHEN** a git commit operation has nothing to commit
- **THEN** the flow can branch on a typed `NothingToCommit` error without throwing

#### Scenario: Flow opts into throwing at a boundary
- **WHEN** a flow calls the throw helper on an error result
- **THEN** the helper throws an exception with the original tagged error details

### Requirement: Backend session identifiers are branded
Session identifiers SHALL be branded by backend tag so TypeScript rejects accidental cross-backend session usage at compile time.

#### Scenario: Session identifier is used with the matching backend
- **WHEN** a Claude session identifier is passed to a Claude conversation operation
- **THEN** the TypeScript program compiles

#### Scenario: Session identifier is used with the wrong backend
- **WHEN** a Claude session identifier is passed to a Codex conversation operation
- **THEN** the TypeScript program fails typechecking
