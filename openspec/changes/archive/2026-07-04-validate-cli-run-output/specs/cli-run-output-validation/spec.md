## ADDED Requirements

### Requirement: CLI output validation captures process streams separately

The system SHALL provide validation coverage that launches Orca CLI commands as
child processes and captures stdout and stderr independently.

#### Scenario: Run command preserves stdout payload

- **WHEN** the validation harness runs a loop with a stdout sink through
  `orca run`
- **THEN** stdout contains the loop payload and does not contain Orca progress
  diagnostics

#### Scenario: Run command emits diagnostics on stderr

- **WHEN** the validation harness runs a loop through `orca run`
- **THEN** stderr contains the preflight, run start, progress, and final summary
  diagnostics needed to monitor the run

#### Scenario: Captured evidence is available on failure

- **WHEN** a process-level validation assertion fails
- **THEN** the failure evidence includes the command, exit code, duration,
  stdout, stderr, and termination signal when present

### Requirement: Validation exercises a useful read-only repo loop

The system SHALL include a deterministic productive loop fixture that can inspect
a repository without mutating it and emit a concise health report.

#### Scenario: Repo health loop emits report payload

- **WHEN** the validation harness runs the repo health loop against a target
  repository
- **THEN** stdout contains a structured or clearly delimited health report with
  check results and no progress diagnostics

#### Scenario: Repo health loop reports progress

- **WHEN** the repo health loop performs checks such as package script discovery,
  typecheck, tests, or git status inspection
- **THEN** stderr contains concise progress output derived from shared run-output
  events for the work being performed

#### Scenario: Repo health loop is read-only

- **WHEN** the repo health loop runs against a git checkout
- **THEN** the target repository's git status after the run matches its git
  status before the run, excluding files explicitly created in a disposable test
  fixture

### Requirement: CLI output validation covers serve lifecycle

The system SHALL validate the operational lifecycle of `orca serve`, including
supervisor startup, child firing output, shutdown, and timeout handling.

#### Scenario: Serve command starts and stops cleanly

- **WHEN** the validation harness starts `orca serve` and then sends a graceful
  shutdown signal
- **THEN** the process exits within the configured timeout without requiring a
  forced kill

#### Scenario: Serve command exposes child firing output

- **WHEN** a served loop source fires a bounded event and the supervisor launches
  a child firing
- **THEN** the harness captures the child firing payload on stdout and the child
  progress diagnostics on stderr

#### Scenario: Hung process is terminated

- **WHEN** an Orca CLI process does not exit before the validation timeout
- **THEN** the harness terminates the process, records the timeout as failure
  evidence, and does not leave the child process running

### Requirement: Manual dogfood validation is documented

The system SHALL document how an operator can run the CLI output validation
against a real local repository and interpret the captured output.

#### Scenario: Operator selects target repository

- **WHEN** an operator wants to dogfood the validation against a real repo on
  disk
- **THEN** the documentation explains how to pass the target path without
  requiring a hard-coded machine-specific path in committed tests

#### Scenario: Operator interprets stream split

- **WHEN** the dogfood validation completes
- **THEN** the documentation explains which information should appear on stdout,
  which information should appear on stderr, and what lifecycle failures mean
