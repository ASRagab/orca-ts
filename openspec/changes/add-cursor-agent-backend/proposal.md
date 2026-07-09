## Why

Cursor Agent now has documented non-interactive automation surfaces, so Orca can add it as another first-class coding-agent backend instead of forcing users to choose between Orca orchestration and Cursor's agent runtime.

This is timely because Orca already treats backend choice as a runtime concern, and adding Cursor should validate whether that abstraction holds for both flow scripts and loop modules.

## What Changes

- Add `cursor` as a supported backend tag.
- Add a Cursor Agent backend constructor that supports autonomous conversations through the installed Cursor CLI's non-interactive mode.
- Map Cursor output, progress, tool events where exposed, usage where exposed, failures, cancellation, and session identity into Orca's shared `Conversation` and `LlmResult` contracts.
- Add `selectBackend()` support so `ORCA_BACKEND=cursor` can run existing flows and loops without author code changes.
- Add deterministic parser/adapter tests plus gated live validation that runs a real Cursor Agent against disposable repositories.
- Extend documentation, setup guidance, and symbol checks so Cursor appears anywhere backend tags are enumerated.
- Add performance validation that compares Cursor wall time, event delivery, timeout behavior, and resource cleanup against existing live backends before treating it as release-ready.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `conversation-backends`: Cursor Agent becomes a supported live autonomous backend and must satisfy the same backend-neutral conversation contract as Claude, Codex, OpenCode, and Pi.

## Impact

- Affected source: `src/model/schemas.ts`, `src/model/backend-config.ts`, `src/backends/**`, `src/index.ts`, and backend selection code.
- Affected tests: backend parser tests, `selectBackend()` tests, real backend smoke tests, flow tests, loop tests, and package/binary smoke where backend tags are surfaced.
- Affected docs: `README.md`, `docs/backends.md`, website backend/setup/reference pages, troubleshooting pages, and backend tag symbol checks.
- External runtime dependency: the operator must have Cursor CLI installed and authenticated; Orca will not install or vendor Cursor.
- Operational prerequisites: Cursor CLI on `PATH`, credentials via existing Cursor auth or `CURSOR_API_KEY`, a non-interactive trusted workspace path, and explicit live-test gates so default CI remains deterministic.
