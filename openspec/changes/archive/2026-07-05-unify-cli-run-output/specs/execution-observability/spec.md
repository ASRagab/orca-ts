## ADDED Requirements

### Requirement: Monitor facts feed human run output
The system SHALL allow structured monitor facts to feed the shared run-output
presenter while preserving the existing monitor log schema. Human progress
output SHALL be derived from the same stage, outcome, failure, cycle, usage, and
context-pressure facts recorded for monitoring.

#### Scenario: Stage monitor fact renders progress
- **WHEN** a monitored stage starts, completes, or fails
- **THEN** the monitor log records the structured stage entry and the shared
  presenter can render the corresponding human progress line from that fact

#### Scenario: Cycle monitor fact renders progress
- **WHEN** loop execution records a per-cycle progress entry
- **THEN** the monitor log preserves the cycle record and the shared presenter
  can render iteration, measure, delta, stop status, usage, and context pressure
  from the same observation

#### Scenario: Structured log remains authoritative
- **WHEN** live human output is disabled, redirected, or rendered differently for
  TTY and CI
- **THEN** the structured monitor log still contains the durable execution
  evidence needed by summary tooling
