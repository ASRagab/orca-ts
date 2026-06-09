# Backends

The v1 contract is backend-neutral: every backend maps native transport messages into the shared read-only `Conversation` interface.

Supported target backends are Claude, OpenCode, Codex, Gemini, and Pi. Backend implementations are delivered slice-by-slice behind the same SPI.

Backend fixture collection uses the shared conversation harness so adapters keep protocol parsing local while event capture and final outcome collection stay in one module.

Autonomous human interaction is rejected. `UserQuestion` and `ApproveTool` remain explicit model variants; interactive support is only available when a backend starts an interactive session with an Orca-owned bridge.

## Codex

The Codex backend starts `codex exec --json` and maps JSONL events into the shared `Conversation` contract. Configure the local Codex CLI and credentials before running live integration checks.

The Codex child run lifecycle is internal to the backend adapter: config resolution, prompt composition, temporary schema files, the interactive `ask_user` bridge, process execution, stream consumption, stderr handling, cancellation, and cleanup are owned together.

Codex parity status:

- Backend config: model, approval policy, read-only mode, retry metadata, system prompt, self-managed git policy, and structured output are represented in the shared config model.
- Sessions/resume: TypeScript-facing session handles are backend-branded; Codex thread ids are captured from JSONL and can be requested on subsequent calls.
- Structured output: Zod schemas are converted to JSON Schema for supported live calls and validated again on return.
- `ask_user`: autonomous conversations reject `ask_user`; explicit interactive conversations use an Orca-owned MCP bridge.
- Approval events: Codex approval remains spawn-policy/config based until JSONL exposes approval request events.
- Tool events: Codex tool-call and tool-result events preserve call id, tool name, raw input, output content, and error status when the JSONL stream exposes them.

The live backend smoke is gated so default tests and `bun run verify` stay deterministic:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
```

The smoke creates a disposable git repository, runs one short autonomous conversation, and fails when the gate is enabled but the backend command or credentials are unavailable.
