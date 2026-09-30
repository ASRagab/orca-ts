## ADDED Requirements

### Requirement: Monitor state records terminal run lifecycle
The machine-readable monitor summary SHALL record terminal `status` as
`succeeded` or `failed`, `endedAt`, the final `currentStage`, `failedStage` when
a stage fails, the selected `backend` and `transport`, and `terminalError` when
the run fails. The monitor SHALL persist terminal state before an ordinary
terminal failure propagates or the process exits. The terminal summary SHALL
NOT be required to act as the live progress stream.

#### Scenario: Successful run records terminal state
- **WHEN** monitored execution completes successfully
- **THEN** the final monitor state records `status: "succeeded"`, `endedAt`, the final `currentStage`, `backend`, and `transport` without a `terminalError`

#### Scenario: Failed stage records terminal state before exit
- **WHEN** a monitored stage fails and the error propagates to terminate the run
- **THEN** the final monitor state is written before exit with `status: "failed"`, `endedAt`, `currentStage`, `failedStage`, `backend`, `transport`, and the `terminalError`

#### Scenario: Failure before stage execution remains observable
- **WHEN** backend initialization fails before a workflow stage completes
- **THEN** the final monitor state records `status: "failed"`, `endedAt`, the initialization `currentStage` and `failedStage`, `backend`, `transport`, and the `terminalError`

#### Scenario: Active run uses live progress signals
- **WHEN** a monitored run is still active and has not written a terminal summary
- **THEN** consumers use process output, heartbeat or stage events, plan or loop state, and git progress without treating the missing terminal summary as failure

### Requirement: Terminal monitor errors preserve actionable backend context
When a backend failure terminates a monitored run, `terminalError` SHALL preserve the typed failure identity and the backend, transport, phase, user workflow location, and safe recovery guidance needed for machine and human diagnostics.

#### Scenario: Backend turn failure is machine-readable
- **WHEN** a backend turn failure terminates a monitored run
- **THEN** `terminalError` identifies the typed failure, backend, transport, turn phase, user workflow location, and safe recovery command

#### Scenario: Monitor state survives wrapper exit behavior
- **WHEN** a wrapper reports an ambiguous or transformed process exit code after the monitored run ends
- **THEN** the persisted terminal monitor status and error remain the authoritative machine-readable result
