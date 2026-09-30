## MODIFIED Requirements

### Requirement: Claude backend executes autonomous conversations live
The system SHALL expose a live `LlmBackend<"claude">` accessor that launches Claude through the stream-json subprocess transport by default, maps its messages into the shared conversation stream, and returns a Claude-branded `LlmResult`. The accessor MUST NOT return an unsupported-backend error. It SHALL support model selection where the selected transport exposes it, structured output validated against a supplied schema, cancellation, bounded lifecycle, backend-branded failures, and explicit opt-in to the ACP transport without changing the public backend tag or typed authoring API.

#### Scenario: Claude autonomous run returns a branded result
- **WHEN** a flow starts an autonomous conversation with the `claude` backend without a transport override
- **THEN** the runtime uses the stream-json subprocess transport and `awaitResult()` returns a successful `LlmResult` branded for Claude

#### Scenario: Claude structured output is validated
- **WHEN** an autonomous Claude conversation requests a structured output schema and the selected transport returns matching JSON
- **THEN** the conversation returns the typed structured result, and on non-matching output returns a typed validation error carrying the raw output

#### Scenario: Claude conversation is cancelled
- **WHEN** a caller cancels an active Claude conversation
- **THEN** the selected transport is signalled and force-closed if it does not stop within the configured timeout
- **THEN** the conversation completes with a cancelled outcome

#### Scenario: Claude ACP transport is explicit
- **WHEN** the operator explicitly selects the Claude ACP transport
- **THEN** the `claude` backend drives the ACP session without changing the public backend tag or typed authoring API

#### Scenario: Claude stream-json fallback is explicit
- **WHEN** the operator explicitly selects `stream-json` through the constructor or environment
- **THEN** the `claude` backend uses stream-json, which is also the default transport
- **THEN** no failed ACP prompt is automatically replayed over stream-json

#### Scenario: Claude ACP setup failure is backend-branded
- **WHEN** Claude ACP initialization, session creation, prompt execution, or shutdown fails
- **THEN** the conversation completes with a `BackendFailed` error naming the failed Claude ACP phase

## ADDED Requirements

### Requirement: Backend failures are transport-aware and actionable
The system SHALL preserve typed backend failures while presenting a primary diagnostic that names the backend, selected transport, failed phase, user workflow location, and a safe recovery command. The primary diagnostic SHALL omit internal Bun stack frames that do not help the user repair the workflow.

#### Scenario: Backend setup fails before a turn
- **WHEN** a selected backend transport fails during initialization
- **THEN** the typed failure and primary diagnostic identify the backend, transport, initialization phase, user workflow location, and safe command that verifies or repairs that transport

#### Scenario: Backend turn fails after launch
- **WHEN** a selected backend transport fails while executing a turn
- **THEN** the typed failure and primary diagnostic identify the backend, transport, turn phase, user workflow location, and safe recovery command

#### Scenario: Internal runtime frames are secondary
- **WHEN** a backend failure includes Bun runtime stack frames and a user workflow location
- **THEN** the primary diagnostic leads with the user workflow location and actionable backend context instead of internal Bun frames

### Requirement: Claude transport verification is deterministic by default
The deterministic verification gate SHALL prove Claude transport selection and diagnostics without live credentials. Live verification of both Claude transports SHALL remain separately gated and SHALL include the installed Claude version in its evidence.

#### Scenario: Default CI verifies transport selection
- **WHEN** deterministic CI runs without backend credentials
- **THEN** fixture or fake-process checks prove stream-json is the Claude default, ACP requires explicit opt-in, and failures contain the required diagnostic context

#### Scenario: Gated live smoke verifies both transports
- **WHEN** the explicitly gated Claude live smoke runs
- **THEN** it exercises stream-json and ACP and records the installed Claude version used by each probe
