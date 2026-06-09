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
The system SHALL provide review-and-fix automation that selects reviewers, runs reviewer prompts, applies fixes, and records the review/fix loop in runtime events.

#### Scenario: Reviewer roster is loaded
- **WHEN** review automation starts
- **THEN** the runtime loads the eight reviewer prompt files from the ported prompt roster

#### Scenario: Reviewer prompts are unchanged from Scala source
- **WHEN** prompt parity tests run
- **THEN** each reviewer prompt file byte-matches the corresponding Scala prompt source

#### Scenario: Review finds fixable issues
- **WHEN** reviewer output identifies fixable issues
- **THEN** the runtime starts a fix turn, records the fix-loop events, and commits the resulting changes

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

