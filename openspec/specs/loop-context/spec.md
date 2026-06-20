# loop-context Specification

## Purpose
TBD - created by archiving change add-loop-builder. Update Purpose after archive.
## Requirements
### Requirement: Context is compacted automatically by token pressure
The system SHALL compact explicitly managed model-visible loop context automatically during cycle execution as token pressure rises, with aggressive default thresholds and a small working-memory window. Compaction SHALL be staged -- observation masking, then pruning of stale observations, then summarization -- escalating with pressure. Authors MAY tune thresholds when enabling managed context. Durable loop state snapshots SHALL NOT be compacted.

#### Scenario: Compaction escalates with pressure
- **WHEN** cycle context utilization crosses successive default thresholds
- **THEN** execution applies masking, then pruning, then summarization in order, keeping the model-visible working window within the configured small bound

#### Scenario: Defaults are aggressive once context is enabled
- **WHEN** a loop enables managed context without custom thresholds
- **THEN** the aggressive default thresholds and small working window are in effect

#### Scenario: Direct execution does not capture raw observations by default
- **WHEN** direct loop execution runs without managed context options
- **THEN** reason or step observations are not captured, compacted, or offloaded into scratch

#### Scenario: Durable state is not compacted
- **WHEN** context compaction runs for a cycle
- **THEN** durable state checkpoints remain exact and replayable while only model-visible observations are masked, pruned, or summarized

### Requirement: Large outputs are offloaded out of context
The system SHALL intercept reason and step outputs exceeding a configured size during managed context cycle execution, write the full payload to a scratch location with restrictive file permissions, and inject a short reference pointer into model-visible context in its place. The injected reference SHALL NOT expose an absolute local path.

#### Scenario: Oversized output is offloaded
- **WHEN** a reason or step produces output larger than the offload threshold
- **THEN** the full payload is written to a scratch file and only a non-absolute pointer reference is injected into context

#### Scenario: Offloaded payload remains retrievable
- **WHEN** a later step needs the offloaded content
- **THEN** it can resolve the pointer to the full payload from scratch
