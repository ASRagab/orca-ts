## Purpose

Define persistent plan behavior, repository mutation ownership, review automation, and deterministic terminal output.
## Requirements
### Requirement: Persistent plans are parity-gated
The system SHALL persist plans using the `.orca/plan-<hash>.md` format and SHALL support default path selection, plan recovery, and task implementation loops compatible with the Scala behavior.

#### Scenario: New plan is persisted
- **WHEN** a flow creates a plan from an autonomous backend result
- **THEN** the runtime writes the expected `.orca/plan-<hash>.md` file

#### Scenario: Existing plan is recovered
- **WHEN** a flow starts with a recoverable persisted plan
- **THEN** the runtime loads the plan and resumes from the expected task state

#### Scenario: Interactive plan mode is requested
- **WHEN** a user requests `Plan.interactive` behavior in v1
- **THEN** the runtime reports the feature as unsupported

### Requirement: Runtime owns repository changes
The system SHALL perform filesystem, git, and GitHub operations through runtime tools so generated work produces inspectable repository diffs and commits. Known recoverable failures SHALL be represented as typed errors.

#### Scenario: Backend edits are committed by the runtime
- **WHEN** an autonomous task produces file changes
- **THEN** the runtime stages and commits those changes through its git tool

#### Scenario: Commit has no changes
- **WHEN** the runtime attempts to commit with no staged or unstaged changes
- **THEN** the git tool returns a typed `NothingToCommit` error

#### Scenario: Pull request creation is requested
- **WHEN** a flow asks the runtime to create a pull request
- **THEN** the GitHub tool creates the pull request from runtime-controlled branch and commit state

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

### Requirement: Terminal event output is deterministic
The system SHALL emit deterministic terminal event logs and status bar output, including plain-mode fallbacks for unsupported terminals, CI, and `NO_COLOR`.

#### Scenario: Event log records structured runtime events
- **WHEN** a flow emits user prompts, tool usage, assistant messages, token usage, structured results, steps, or errors
- **THEN** the terminal event log renders the expected text for each event

#### Scenario: Status bar falls back to plain output
- **WHEN** the runtime detects CI, no TTY, or `NO_COLOR`
- **THEN** the terminal output uses the golden plain-mode rendering

#### Scenario: Status bar is enabled in an interactive terminal
- **WHEN** the runtime detects a supported TTY
- **THEN** the status bar renders progress without corrupting the persisted event log

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
