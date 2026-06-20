## MODIFIED Requirements

### Requirement: CLI runs, serves, and lists loops
The system SHALL provide CLI verbs for loops: `orca run <loop>` (single one-shot execution), `orca serve <loop>` (long-lived host honoring the loop's `Source`), and `orca loops` (list defined loops with their source and sink). `orca run <loop>` and served child execution SHALL use the same firing contract for event decoding, definition execution, sink emission, diagnostics, and exit-code mapping. The existing `--backend` override, `--no-typecheck`, and post-`--` flow-argument behavior SHALL continue to apply. Existing `orca <flow.ts>` usage SHALL remain supported as the legacy flow-script path.

#### Scenario: Run executes a loop once
- **WHEN** a user runs `orca run <loop>`
- **THEN** the loop executes a single time through the shared firing contract and exits with a status reflecting its stop reason

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
The system SHALL implement `orca serve` as a thin long-lived supervisor that owns only the triggers (`cron`/`watch`/`webhook`/`queue`) and spawns an ephemeral child process per trigger firing to run the loop and exit. Each child SHALL be independently terminable, including OS-level kill of a runaway loop. Cross-loop coordination (e.g. a shared token budget) SHALL be mediated through the shared manifest store rather than shared process memory. Parent-to-child event transfer, spawn arguments, child one-shot execution, diagnostics, and exit-code mapping SHALL be owned by the shared firing contract rather than duplicated across supervisor and CLI code.

#### Scenario: Trigger firing spawns an isolated child
- **WHEN** a bound trigger fires under `orca serve`
- **THEN** the supervisor spawns a child process through the shared firing contract that runs the loop and exits, without executing the loop inside the supervisor process

#### Scenario: One loop crash does not take down others
- **WHEN** a child loop crashes
- **THEN** the supervisor survives, other loops are unaffected, and the supervisor may restart only the failed loop

#### Scenario: Runaway child is killable at the OS level
- **WHEN** a loop must be force-stopped
- **THEN** its child process can be terminated by the supervisor independently of all other loops

#### Scenario: Served child receives the original trigger event
- **WHEN** a `Source` fires a JSON-serializable trigger event under `orca serve`
- **THEN** the child loop receives the same event value through the shared firing contract
