## ADDED Requirements

### Requirement: Loops emit a per-cycle progress stream
The system SHALL extend the workflow run log with a per-cycle progress record containing at least `iteration`, `measure`, `delta` (change in measure from the prior cycle), `stopReasonSoFar`, per-branch status for fan-out cycles, and cumulative token usage when reported. Missing backend usage SHALL be represented as `unknown`, not as zero. The stream SHALL be derivable from the manifest projection so it stays consistent with the termination variant.

#### Scenario: Each cycle records progress
- **WHEN** a loop completes a cycle
- **THEN** the run log appends a progress record with the current `iteration`, `measure`, and `delta`

#### Scenario: Fan-out cycles record per-branch status
- **WHEN** a cycle fans out to multiple branches
- **THEN** the progress record includes each branch's id, status, and reported token usage or `unknown`

#### Scenario: Runaway is observable from the stream
- **WHEN** `measure` stops decreasing while cumulative reported token usage rises across cycles
- **THEN** the progress stream reflects a flat `delta` with rising token usage, surfacing an incipient runaway before a guard fires
