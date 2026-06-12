## ADDED Requirements

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
