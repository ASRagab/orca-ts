# Backends

The v1 contract is backend-neutral: every backend maps native transport messages into the shared read-only `Conversation` interface.

Supported target backends are Claude, OpenCode, Codex, Gemini, and Pi. Backend implementations are delivered slice-by-slice behind the same SPI.

Human interaction is not implemented in v1. `UserQuestion` and `ApproveTool` remain reserved model variants, and every backend reports `canAskUser: false`.

## Codex

The Codex backend starts `codex exec --json` and maps JSONL events into the shared `Conversation` contract. Configure the local Codex CLI and credentials before running live integration checks.

The live backend smoke is gated so default tests and `bun run verify` stay deterministic:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
```

The smoke creates a disposable git repository, runs one short autonomous conversation, and fails when the gate is enabled but the backend command or credentials are unavailable.
