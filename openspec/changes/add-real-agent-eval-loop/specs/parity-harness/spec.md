## ADDED Requirements

### Requirement: Tier 3 real-agent eval validates live backend parity
The system SHALL define a Tier 3 real-agent eval that complements Tier 1 (stream-to-event fixtures) and Tier 2 (fake-agent flow goldens) by running the cleanup flow against real backend CLIs and scoring the result against an objective gate oracle. Tier 3 SHALL be opt-in and gated: it SHALL NOT run in the default deterministic CI gate, which must not require live backend credentials. The objective oracle is behavior-preserving regression safety — every pre-existing green check stays green — not a SWE-bench-style red-to-green task. Tier 3 SHALL produce a per-backend convergence-cost matrix from runs that share one pinned base commit.

#### Scenario: Tier 3 is excluded from default CI
- **WHEN** the default deterministic verification gate runs
- **THEN** the Tier 3 real-agent eval does not run and no live backend credentials are required

#### Scenario: Tier 3 uses the objective gate oracle
- **WHEN** a Tier 3 eval run scores a backend's change to a file
- **THEN** the verdict is determined by whether the targeted gate stays green, with the change reverted if it cannot be made to pass

#### Scenario: Tier 3 runs are comparable across backends
- **WHEN** Tier 3 evaluates more than one backend
- **THEN** each backend runs from the same pinned base commit so the resulting matrix compares like with like
