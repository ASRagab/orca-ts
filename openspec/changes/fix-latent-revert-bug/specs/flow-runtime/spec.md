## MODIFIED Requirements

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
