## Purpose

Define execution monitoring data for workflow runs and cleanup attempts.
## Requirements
### Requirement: Workflow execution is observable by stage
The system SHALL emit structured monitor data for monitored workflow runs that attributes wall time and failures to semantic execution stages.

#### Scenario: Monitored cleanup run records stages
- **WHEN** the cleanup workflow runs with monitoring enabled
- **THEN** the monitor log includes named stage entries for setup, baseline validation, per-file cleanup, agent turn, validation, repair when attempted, group commit, final verify, and publish or no-publish completion
- **THEN** each stage entry includes start time, duration in milliseconds, and completed or failed status

#### Scenario: Stage failure is retained
- **WHEN** a monitored stage throws
- **THEN** the monitor log records that stage as failed with its elapsed duration before the error propagates

### Requirement: File outcomes include execution evidence
The system SHALL record per-file cleanup outcomes with enough evidence to compare wall time, validation cost, repair behavior, touched paths, and backend usage across runs.

#### Scenario: Changed file outcome records evidence
- **WHEN** a monitored cleanup attempt accepts changes for a file
- **THEN** the file outcome includes the file path, verdict, duration, changed paths, validation command summaries, repair iteration count, and smell labels

#### Scenario: Backend usage is preserved when emitted
- **WHEN** a backend emits usage metadata during a cleanup attempt
- **THEN** the file outcome includes the emitted usage totals without inventing missing usage fields

#### Scenario: Skipped file outcome records reason
- **WHEN** a cleanup attempt is skipped or reverted by a guard
- **THEN** the file outcome includes the file path, verdict, duration, and human-readable reason

### Requirement: Monitor summaries support before-after comparison
The system SHALL summarize monitor logs by backend, file, stage, verdict, failure category, duration, repair count, and usage where available.

#### Scenario: Summarizer reports slowest stages and files
- **WHEN** monitor logs exist under `.orca/monitoring`
- **THEN** the summary command reports run totals, backend totals, slowest stages, slowest files, and failures using the structured monitor fields

#### Scenario: Missing monitor data remains absent
- **WHEN** a backend or workflow path does not emit optional usage or repair metadata
- **THEN** the monitor log omits those optional fields rather than writing placeholder values

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

