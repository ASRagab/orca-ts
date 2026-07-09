## ADDED Requirements

### Requirement: Cursor backend executes autonomous conversations live
The system SHALL expose a live `LlmBackend<"cursor">` accessor that runs the installed Cursor CLI in non-interactive mode and returns a Cursor-branded `LlmResult`. The accessor MUST NOT return an unsupported-backend error. It SHALL support model selection, read-only operation, cancellation, bounded turn execution, and session resume when the Cursor CLI exposes a resumable session identifier. The system SHALL NOT install, update, vendor, or otherwise manage Cursor CLI.

#### Scenario: Cursor autonomous run returns a branded result
- **WHEN** a flow starts an autonomous conversation with the `cursor` backend and the installed Cursor CLI emits a successful non-interactive response
- **THEN** the runtime drives the transport to completion
- **THEN** `awaitResult()` returns a successful `LlmResult` branded for Cursor

#### Scenario: Cursor CLI is missing when live validation is requested
- **WHEN** Cursor live validation is explicitly enabled and the configured Cursor command is not available on `PATH`
- **THEN** the validation fails with a clear prerequisite error
- **THEN** the system does not attempt to install Cursor CLI

#### Scenario: Cursor read-only run does not request write privileges
- **WHEN** a Cursor backend conversation is created with `readOnly: true`
- **THEN** the driver invokes Cursor Agent in a read-only or ask-style mode
- **THEN** the driver does not pass flags that grant direct file modification approval

#### Scenario: Cursor conversation is cancelled
- **WHEN** a caller cancels an active Cursor conversation
- **THEN** the Cursor transport is signalled or aborted
- **THEN** the conversation completes with a cancelled outcome

#### Scenario: Cursor transport stalls
- **WHEN** the Cursor transport emits no relevant progress before the configured inactivity timeout
- **THEN** the conversation completes with a Cursor-branded backend failure
- **THEN** any child process or runtime handle owned by the backend is cleaned up

### Requirement: Cursor backend is selectable anywhere backend tags are accepted
The system SHALL include `cursor` in the shared backend tag schema, backend selector, public exports, documentation literal sets, and live-smoke backend list. Selecting `ORCA_BACKEND=cursor` SHALL construct the Cursor backend and preserve the same model override precedence used by existing backends.

#### Scenario: Runtime selector chooses Cursor
- **WHEN** `selectBackend()` receives `ORCA_BACKEND=cursor`
- **THEN** it returns a selected backend with tag `cursor`
- **THEN** the selected backend's `backend.tag` is `cursor`

#### Scenario: Cursor model override uses shared precedence
- **WHEN** Cursor has a per-backend model configured and `ORCA_BACKEND_MODEL` is set
- **THEN** `ORCA_BACKEND_MODEL` takes precedence
- **THEN** the constructed Cursor backend receives the overridden model

#### Scenario: Flow and loop authors keep backend-neutral source
- **WHEN** an existing flow or loop module uses backend-neutral runtime selection
- **THEN** changing `ORCA_BACKEND` to `cursor` is sufficient to run the Cursor backend
- **THEN** the author does not need Cursor-specific imports in the flow or loop body

### Requirement: Cursor live validation covers flow, loop, and performance parity
The system SHALL provide opt-in live validation for Cursor Agent that is excluded from default deterministic CI. The validation SHALL run a real Cursor Agent in disposable git repositories for both flow and loop patterns, record wall time and event metadata, and compare the observed runtime against existing coding-agent backends before the backend is documented as release-ready.

#### Scenario: Cursor live smoke is gated
- **WHEN** default tests or `bun run verify` execute without the live backend gate
- **THEN** no Cursor Agent process starts

#### Scenario: Cursor live smoke uses a disposable repository
- **WHEN** `ORCA_REAL_BACKEND_SMOKE=1` and `ORCA_REAL_BACKEND=cursor` are set with Cursor credentials available
- **THEN** the live smoke creates a disposable git repository
- **THEN** it runs one read-only Cursor autonomous conversation
- **THEN** it asserts a successful Cursor-branded result and removes the repository

#### Scenario: Cursor flow validation runs live
- **WHEN** the Cursor live validation suite is enabled
- **THEN** it runs at least one existing flow pattern with `ORCA_BACKEND=cursor`
- **THEN** it records success, wall time, event count, and cleanup status

#### Scenario: Cursor loop validation runs live
- **WHEN** the Cursor live validation suite is enabled
- **THEN** it runs at least one existing loop pattern with `ORCA_BACKEND=cursor`
- **THEN** it records convergence outcome, stop reason, wall time, event count, and cleanup status

#### Scenario: Cursor performance is evaluated against existing backends
- **WHEN** Cursor live validation completes
- **THEN** the validation output includes Cursor wall time and event metadata for the same prompt shape used by comparable live backend runs
- **THEN** Cursor MUST NOT be documented as a supported backend unless the measured prompts show performance on par with or better than existing coding-agent backends
