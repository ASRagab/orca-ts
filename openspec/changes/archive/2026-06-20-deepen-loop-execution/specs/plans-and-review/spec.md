## MODIFIED Requirements

### Requirement: Review and fix loop is supported
The system SHALL provide review-and-fix automation that selects reviewers, runs reviewer prompts, applies fixes, and records the review/fix loop in runtime events. Review-and-fix SHALL be expressed as a strategy over loop execution and the public `fixLoop` convergence primitive, rather than as a standalone bespoke loop or as the recurrence owner for the loop builder. The existing `implementTaskLoop` and `runReviewAndFixLoop` exports SHALL remain for one release as deprecated compatibility wrappers over the new strategies. **Migration**: callers of `implementTaskLoop` move to the sequential-task `.until()` strategy; callers of `runReviewAndFixLoop` move to the review-and-fix `.until()` strategy over `fixLoop`.

#### Scenario: Reviewer roster is loaded
- **WHEN** review automation starts
- **THEN** the runtime loads the eight reviewer prompt files from the ported prompt roster

#### Scenario: Reviewer prompts are unchanged from Scala source
- **WHEN** prompt parity tests run
- **THEN** each reviewer prompt file byte-matches the corresponding Scala prompt source

#### Scenario: Review finds fixable issues
- **WHEN** reviewer output identifies fixable issues
- **THEN** the runtime starts a fix turn, records the fix-loop events, and commits the resulting changes

#### Scenario: Review-and-fix runs as a loop execution strategy
- **WHEN** review-and-fix automation executes
- **THEN** it is driven through loop execution under a review-and-fix convergence strategy, while the deprecated `runReviewAndFixLoop` wrapper delegates to that strategy for compatibility

#### Scenario: Deprecated wrappers preserve current callers
- **WHEN** existing code calls `implementTaskLoop` or `runReviewAndFixLoop`
- **THEN** the calls still compile and run through compatibility wrappers, and a deprecation warning is emitted
