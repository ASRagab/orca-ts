# linear-integration Specification

## Purpose
TBD - created by archiving change add-linear-source-sink. Update Purpose after archive.
## Requirements
### Requirement: Linear GraphQL tool authenticates requests
The system SHALL provide a `LinearTool` that performs authenticated Linear
GraphQL queries and mutations through an injectable transport. The default
transport SHALL support personal API key authentication and OAuth bearer-token
authentication without exposing token values in errors or logs.

#### Scenario: Authenticated GraphQL request succeeds
- **WHEN** a flow calls a `LinearTool` method with a valid injected transport response
- **THEN** the tool returns an `ok` result containing the requested Linear data

#### Scenario: GraphQL request returns errors
- **WHEN** Linear returns GraphQL `errors` or a non-2xx HTTP response
- **THEN** the tool returns an `err(RuntimeError)` that names Linear as the failing system
- **THEN** the error does not include the API key or OAuth access token

### Requirement: Linear webhooks are verified before delivery
The system SHALL verify Linear webhook requests using the raw request body,
`Linear-Signature` HMAC, and a bounded timestamp freshness check before invoking
any loop handler.

#### Scenario: Valid signed webhook is delivered
- **WHEN** a Linear webhook request has a valid signature and fresh timestamp
- **THEN** the Linear source delivers one normalized event to the loop handler

#### Scenario: Invalid signed webhook is rejected
- **WHEN** a Linear webhook request has a missing signature, invalid signature, or stale timestamp
- **THEN** the Linear source does not invoke the loop handler
- **THEN** the listener reports a typed source failure or HTTP rejection

### Requirement: Linear issue events are normalized and filtered
The system SHALL normalize Linear issue and comment webhook payloads into typed
events that include `issueId`, issue identifier when present, URL, action,
project/team identifiers when present, actor metadata, raw payload, and a stable
`dedupeKey`. The source SHALL filter events by configured team, project,
workflow state, label, action, and self-actor exclusion before invoking the loop
handler.

#### Scenario: Matching issue event fires a loop
- **WHEN** Linear sends an `Issue` webhook whose team and project match the source configuration
- **THEN** the source invokes the loop handler with a normalized issue event

#### Scenario: Non-matching issue event is ignored
- **WHEN** Linear sends an issue or comment webhook outside the configured filters
- **THEN** the source acknowledges or ignores the request without invoking the loop handler

### Requirement: Linear Agent Session events are normalized
The system SHALL normalize Linear Agent Session webhook payloads into typed
events for created sessions, prompted sessions, and prompt signals. Agent events
SHALL include `agentSessionId`, related issue context, prompt context when
present, activity content when present, raw payload, and a stable `dedupeKey`.

#### Scenario: Created agent session starts work
- **WHEN** Linear sends an Agent Session `created` webhook
- **THEN** the source invokes the loop handler with the session id, issue context, and prompt context

#### Scenario: Stop prompt is represented without mutation
- **WHEN** Linear sends a prompted Agent Activity containing a stop signal
- **THEN** the source emits a normalized stop event that loop code can handle without starting new code changes

### Requirement: Linear issue sink updates the originating issue
The system SHALL provide a Linear issue sink that can create an issue comment,
update supported issue fields, and record a PR URL or final summary using
`LinearTool`. Sink failures SHALL be returned as `err(RuntimeError)` rather
than thrown exceptions.

#### Scenario: Issue sink records a PR
- **WHEN** a loop output contains an issue id, final summary, and PR URL
- **THEN** the Linear issue sink writes the configured issue update through `LinearTool`
- **THEN** the sink returns `ok(undefined)`

#### Scenario: Issue sink fails
- **WHEN** the Linear update operation fails
- **THEN** the sink returns `err(RuntimeError)` and does not throw

### Requirement: Linear Agent Session sink emits terminal agent updates
The system SHALL provide a Linear Agent Session sink that emits terminal Agent
Activities and updates Agent Session external URLs or plan state through
`LinearTool`.

#### Scenario: Agent sink emits final response
- **WHEN** a loop output contains an agent session id, response body, and optional PR URL
- **THEN** the sink creates a response Agent Activity
- **THEN** the sink attaches the PR URL to the Agent Session external URLs when provided

#### Scenario: Agent sink emits final error
- **WHEN** a loop output represents a failed run for an agent session
- **THEN** the sink creates an error Agent Activity and returns the resulting typed status

