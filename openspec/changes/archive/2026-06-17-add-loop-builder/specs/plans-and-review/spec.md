## MODIFIED Requirements

### Requirement: Review and fix loop is supported
The system SHALL provide review-and-fix automation that selects reviewers, runs reviewer prompts, applies fixes, and records the review/fix loop in runtime events. Review-and-fix SHALL be expressed as a strategy over the single generic convergence orchestrator `fixLoop` (a `.until()` policy), rather than as a standalone bespoke loop. The existing `implementTaskLoop` and `runReviewAndFixLoop` exports SHALL remain for one release as deprecated compatibility wrappers over the new strategies. **Migration**: callers of `implementTaskLoop` move to the sequential-task `.until()` strategy; callers of `runReviewAndFixLoop` move to the review-and-fix `.until()` strategy over `fixLoop`.

#### Scenario: Reviewer roster is loaded
- **WHEN** review automation starts
- **THEN** the runtime loads the eight reviewer prompt files from the ported prompt roster

#### Scenario: Reviewer prompts are unchanged from Scala source
- **WHEN** prompt parity tests run
- **THEN** each reviewer prompt file byte-matches the corresponding Scala prompt source

#### Scenario: Review finds fixable issues
- **WHEN** reviewer output identifies fixable issues
- **THEN** the runtime starts a fix turn, records the fix-loop events, and commits the resulting changes

#### Scenario: Review-and-fix runs as a fixLoop strategy
- **WHEN** review-and-fix automation executes
- **THEN** it is driven by `fixLoop` under a review-and-fix `.until()` strategy, while the deprecated `runReviewAndFixLoop` wrapper delegates to that strategy for compatibility

#### Scenario: Deprecated wrappers preserve current callers
- **WHEN** existing code calls `implementTaskLoop` or `runReviewAndFixLoop`
- **THEN** the calls still compile and run through compatibility wrappers, and a deprecation warning is emitted

## ADDED Requirements

### Requirement: Loop termination guards include token budget and unified stuck detection
The system SHALL extend generic `fixLoop` termination with a token-budget guard and SHALL add `budget-exhausted` to the stop union. The guard SHALL sum reported `Usage` token totals across loop cycles. If usage is unavailable for a backend or step, progress records SHALL mark token usage as `unknown` and the token-budget guard SHALL NOT fire from that missing data. The system SHALL detect non-progress through a single generic fingerprint primitive — a hash of (action identity + inputs) over a sliding window that halts on N repeats (catching immediate repeats and oscillations). The existing failed-command + failing-test-ID signature SHALL be a configured projection of this one primitive, not a separate mechanism.

#### Scenario: Token budget halts a runaway loop
- **WHEN** cumulative reported token usage exceeds the configured budget before convergence
- **THEN** `fixLoop` stops with a budget-exhausted stop reason

#### Scenario: Missing usage does not create fake budget data
- **WHEN** a backend or step reports no token usage
- **THEN** the progress stream records unknown token usage for that cycle and the token-budget guard does not fire because of the missing value

#### Scenario: Repeated action fingerprint is detected as stuck
- **WHEN** the same (action + inputs) fingerprint recurs N times within the sliding window
- **THEN** `fixLoop` stops with the `stuck` stop reason

#### Scenario: Oscillation is detected as stuck
- **WHEN** state fingerprints cycle (e.g. A→B→A) within the window
- **THEN** the no-progress detector reports `stuck`
