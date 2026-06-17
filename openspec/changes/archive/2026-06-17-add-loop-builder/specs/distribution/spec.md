## ADDED Requirements

### Requirement: CLI runs, serves, and lists loops
The system SHALL provide CLI verbs for loops: `orca run <loop>` (single one-shot execution), `orca serve <loop>` (long-lived host honoring the loop's `Source`), and `orca loops` (list defined loops with their source and sink). The existing `--backend` override, `--no-typecheck`, and post-`--` flow-argument behavior SHALL continue to apply. Existing `orca <flow.ts>` usage SHALL remain supported as the legacy flow-script path.

#### Scenario: Run executes a loop once
- **WHEN** a user runs `orca run <loop>`
- **THEN** the loop executes a single time and exits with a status reflecting its stop reason

#### Scenario: Legacy flow execution still works
- **WHEN** a user runs `orca <flow.ts> -- task args`
- **THEN** the CLI typechecks and imports the flow script with the same behavior as before this change, and the post-`--` tokens are still available through `flowArgs()`

#### Scenario: Loops are listable
- **WHEN** a user runs `orca loops`
- **THEN** the CLI lists each defined loop with its configured source and sink

#### Scenario: Loop discovery has no side effects
- **WHEN** `orca loops` inspects loop metadata
- **THEN** it reads registered loop definitions without firing a `Source`, invoking a backend, or emitting to a `Sink`

### Requirement: Serve is a thin supervisor spawning an ephemeral child per firing
The system SHALL implement `orca serve` as a thin long-lived supervisor that owns only the triggers (`cron`/`watch`/`webhook`/`queue`) and spawns an ephemeral child process per trigger firing to run the loop and exit. Each child SHALL be independently terminable, including OS-level kill of a runaway loop. Cross-loop coordination (e.g. a shared token budget) SHALL be mediated through the shared manifest store rather than shared process memory.

#### Scenario: Trigger firing spawns an isolated child
- **WHEN** a bound trigger fires under `orca serve`
- **THEN** the supervisor spawns a child process that runs the loop and exits, without executing the loop inside the supervisor process

#### Scenario: One loop crash does not take down others
- **WHEN** a child loop crashes
- **THEN** the supervisor survives, other loops are unaffected, and the supervisor may restart only the failed loop

#### Scenario: Runaway child is killable at the OS level
- **WHEN** a loop must be force-stopped
- **THEN** its child process can be terminated by the supervisor independently of all other loops

### Requirement: Durable DBOS mode is deferred
The system SHALL NOT expose `--durable`, `--postgres-url`, or a selectable `dbos` state adapter in this change. Multi-process DBOS durability SHALL remain a follow-up design note behind the `StateStore` port until a Bun compatibility spike is completed. With no durable mode, the system SHALL run the default `snapshot` or selected `sqlite` adapter with no external service.

#### Scenario: Default run needs no service
- **WHEN** a loop runs without `--durable`
- **THEN** it uses the service-free default adapter and requires no Postgres

#### Scenario: DBOS is not selectable yet
- **WHEN** a user tries to select `dbos` or pass `--durable`
- **THEN** the CLI fails with a clear unsupported-feature error that points to the deferred DBOS design note
