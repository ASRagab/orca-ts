## ADDED Requirements

### Requirement: Context is compacted automatically by token pressure
The system SHALL compact loop context automatically as token pressure rises, with aggressive default thresholds and a small working-memory window, requiring no author opt-in. Compaction SHALL be staged — observation masking, then pruning of stale observations, then summarization — escalating with pressure. Authors MAY tune thresholds but SHALL receive aggressive defaults by default.

#### Scenario: Compaction escalates with pressure
- **WHEN** context utilization crosses successive default thresholds
- **THEN** the engine applies masking, then pruning, then summarization in order, keeping the working window within the configured small bound

#### Scenario: Defaults are aggressive without configuration
- **WHEN** a loop runs with no context configuration
- **THEN** the aggressive default thresholds and small working window are in effect

### Requirement: Large outputs are offloaded out of context
The system SHALL intercept tool/step outputs exceeding a configured size, write the full payload to a scratch location, and inject a short reference pointer into context in its place.

#### Scenario: Oversized output is offloaded
- **WHEN** a step produces output larger than the offload threshold
- **THEN** the full payload is written to a scratch file and only a pointer reference is injected into context

#### Scenario: Offloaded payload remains retrievable
- **WHEN** a later step needs the offloaded content
- **THEN** it can resolve the pointer to the full payload from scratch
