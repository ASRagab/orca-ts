# ACP Performance Spike Report

## Discovery Status

Date: 2026-07-08
Host: macOS Darwin 25.5.0
Repo: `/Users/ahmad.ragab/Dev/tools/orca-ts`

## Official Docs Read

- ACP introduction and docs index: `https://agentclientprotocol.com`
- ACP TypeScript SDK client docs: `https://agentclientprotocol-typescript-sdk.mintlify.app/clients/overview`
- ACP `ClientSideConnection` docs: `https://agentclientprotocol-typescript-sdk.mintlify.app/clients/client-side-connection`
- ACP v1 initialization: `https://agentclientprotocol.com/protocol/v1/initialization.md`
- ACP v1 session setup: `https://agentclientprotocol.com/protocol/v1/session-setup.md`
- ACP v1 prompt turn: `https://agentclientprotocol.com/protocol/v1/prompt-turn.md`
- ACP v1 cancellation: `https://agentclientprotocol.com/protocol/v1/cancellation.md`
- ACP v1 transports: `https://agentclientprotocol.com/protocol/v1/transports.md`
- ACP v1 tool calls: `https://agentclientprotocol.com/protocol/v1/tool-calls.md`
- Claude ACP adapter repo: `https://github.com/agentclientprotocol/claude-agent-acp`
- Codex ACP adapter repo: `https://github.com/agentclientprotocol/codex-acp`

## Protocol Facts Used By The Spike

- ACP v1 uses newline-delimited JSON-RPC 2.0 over stdio for local agents.
- Clients must call `initialize` before creating or loading sessions.
- Sessions are created with `session/new`, including absolute `cwd` and optional MCP server definitions.
- Prompt turns use `session/prompt`; progress arrives via `session/update` notifications until a terminal prompt response returns a stop reason.
- Prompt cancellation is `session/cancel`; agents should finish the pending prompt with a cancelled stop reason.
- Request-level cancellation also exists via `$/cancel_request` with JSON-RPC error `-32800`.
- Session shutdown may use `session/close` only when advertised in `sessionCapabilities.close`.
- Tool progress is reported through `tool_call` and `tool_call_update` session updates.

## Local Prerequisites

| Surface | Result |
| --- | --- |
| `claude` | Found at `/Users/ahmad.ragab/.local/bin/claude`; version `2.1.204 (Claude Code)`. |
| `codex` | Found at `/Users/ahmad.ragab/.local/bin/codex`; version `codex-cli 0.143.0`; `codex login status` reports ChatGPT login. |
| `claude-agent-acp` | Found at `/opt/homebrew/bin/claude-agent-acp`; command produced no `--version` or `--help` output. |
| `codex-acp` | Not installed locally. `npx --prefer-offline=false --prefer-online=true -y @agentclientprotocol/codex-acp@1.1.0 --version` starts successfully and reports `@agentclientprotocol/codex-acp 1.1.0`. |

## Package Registry Findings

This environment prefers offline npm metadata, so unqualified `npm view` may show stale package lists. Use `--prefer-offline=false --prefer-online=true` for ACP package discovery and `npx` startup checks.

With online metadata enabled, `npm view --registry https://registry.npmjs.org @agentclientprotocol/sdk version` reports `1.2.0`, and `@agentclientprotocol/codex-acp@1.1.0` can be launched through `npx`. `@agentclientprotocol/claude-agent-acp@0.52.0` also starts through `npx` and reports `0.52.0`.

## SDK Decision

Do not add `@agentclientprotocol/sdk` to Orca yet.

Reasons:

- Claude and Codex ACP adapter startup can be probed through current adapter packages without adding the SDK to Orca.
- The protocol surface Orca needs for the first deterministic tests is small enough to model with JSON-RPC fixtures.
- Live adapter transcript validation should precede any shipped transport replacement or dependency addition.

## Current Blocker

None at the prerequisite stage. Live transcript capture remains the next step.

## Capture Harness

`scripts/capture-acp-transcripts.ts` records current CLI streams and ACP JSON-RPC streams into transcript directories. It requires `ORCA_ACP_CAPTURE_LIVE=1` for scenarios that can call a live model: `success`, `structured`, and `cancel`.

Example:

```bash
bun run scripts/capture-acp-transcripts.ts \
  --backend codex \
  --transport acp \
  --scenario handshake \
  --out-dir openspec/changes/spike-acp-claude-codex-backends/transcripts/codex-acp-handshake
```

## Non-Live Transcript Inventory

| Transcript | Scenario | Live | Wall time | Event count | Notes |
| --- | --- | --- | ---: | ---: | --- |
| `transcripts/codex-acp-handshake` | ACP initialize + `session/new` | No | 8734 ms | 4 | Adapter reports `@agentclientprotocol/codex-acp 1.1.0`, protocol v1, `sessionCapabilities.close`, and current model `gpt-5.5[xhigh]`. |
| `transcripts/claude-acp-handshake` | ACP initialize + `session/new` | No | 10572 ms | 5 | Local `claude-agent-acp` initializes and creates a session; its `--version` output is empty. |
| `transcripts/codex-current-failure` | Current CLI invalid flag | No | 114 ms | 5 | Deterministic current-transport startup/argument failure. |
| `transcripts/claude-current-failure` | Current CLI invalid flag | No | 467 ms | 1 | Deterministic current-transport startup/argument failure. |
| `transcripts/codex-acp-failure` | ACP prompt path, non-live failure prompt | No | 44140 ms | 78 | Exercises ACP prompt/update/failure surface without enabling live capture. |
| `transcripts/claude-acp-failure` | ACP prompt path, non-live failure prompt | No | 21329 ms | 18 | Exercises ACP prompt/update/failure surface without enabling live capture. |

## Live Transcript Inventory

These are one-off transcript-capture timings, not replacement-decision benchmark medians.

| Transcript | Scenario | Wall time | Event count | Exit code |
| --- | --- | ---: | ---: | ---: |
| `transcripts/codex-current-success` | Current CLI read-only success | 12127 ms | 10 | 0 |
| `transcripts/codex-current-structured` | Current CLI structured output | 9075 ms | 8 | 0 |
| `transcripts/codex-current-cancel` | Current CLI cancellation | 1510 ms | 4 | null |
| `transcripts/codex-acp-success` | ACP read-only success | 33937 ms | 75 | null |
| `transcripts/codex-acp-structured` | ACP structured prompt | 33426 ms | 39 | null |
| `transcripts/codex-acp-cancel` | ACP cancellation | 9540 ms | 12 | null |
| `transcripts/claude-current-success` | Current CLI read-only success | 38691 ms | 98 | 0 |
| `transcripts/claude-current-structured` | Current CLI structured output | 44458 ms | 95 | 0 |
| `transcripts/claude-current-cancel` | Current CLI cancellation | 1758 ms | 23 | 143 |
| `transcripts/claude-acp-success` | ACP read-only success | 30708 ms | 29 | 0 |
| `transcripts/claude-acp-structured` | ACP structured prompt | 23674 ms | 22 | 0 |
| `transcripts/claude-acp-cancel` | ACP cancellation | 14800 ms | 8 | 0 |

## Measurements

Full single-run direct/flow/loop matrix:

`openspec/changes/spike-acp-claude-codex-backends/benchmarks/full-matrix/results.json`

| Backend | Workload | Current | ACP | ACP delta | Decision |
| --- | --- | ---: | ---: | ---: | --- |
| Codex | Direct | 21049 ms | 33835 ms | 60.7% slower | Fail |
| Codex | Flow | 49936 ms | 63588 ms | 27.3% slower | Fail |
| Codex | Loop | 96004 ms | 111814 ms | 16.5% slower | Fail |
| Claude | Direct | 60249 ms | 38137 ms | 36.7% faster | Provisional pass |
| Claude | Flow | 91720 ms | 50622 ms | 44.8% faster | Provisional pass |
| Claude | Loop | 120803 ms | 77192 ms | 36.1% faster | Provisional pass |

All runs exited successfully or converged. Prompt counts matched workload shape:

- Direct: 1 backend prompt
- Flow: 2 backend prompts
- Loop: 3 backend prompts

Important caveat: this is a single-run matrix, not replicated medians. It is enough to reject Codex ACP for replacement in this spike as currently implemented, but not enough to ship Claude ACP as the default replacement without a repeated median run. The current prototype also records `sessionReuse: false`, so it does not yet prove the strongest version of the persistent-session performance claim.

## Replacement Decision

- Codex: ACP does not meet the replacement threshold. Keep the existing subprocess transport.
- Claude: ACP is promising and exceeds the 15% threshold in this single-run matrix, but the formal threshold requires medians. Keep the existing subprocess transport as default until replicated flow and loop medians confirm the result.
- Public API: unchanged.
- Docs/AGENTS replacement update: not needed because no default transport replacement ships in this spike step.

## Prototype Validation

The implementation now includes an internal direct JSON-RPC ACP client seam and env-gated ACP prototypes behind the existing `claude` and `codex` backend tags.

Enable with:

```bash
ORCA_EXPERIMENTAL_ACP_BACKENDS=claude
ORCA_EXPERIMENTAL_ACP_BACKENDS=codex
ORCA_EXPERIMENTAL_ACP_BACKENDS=1
```

Default behavior remains the existing subprocess transport.

Focused deterministic validation:

```bash
bun test tests/acp-client.test.ts
bun test tests/claude-backend.test.ts tests/codex-backend.test.ts tests/acp-client.test.ts
bun run typecheck
```

Live prototype smoke:

| Backend | Command | Result |
| --- | --- | --- |
| Codex ACP | `ORCA_EXPERIMENTAL_ACP_BACKENDS=codex ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts` | Passed on rerun; wall time `31818 ms`, `16` events, usage `{ input: 812, output: 224 }`. First run failed transiently, then a diagnostic direct run succeeded. |
| Claude ACP | `ORCA_EXPERIMENTAL_ACP_BACKENDS=claude ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=claude bun test tests/integration/real-backend-smoke.test.ts` | Passed after raising ACP request timeout to `600000 ms`; wall time `38990 ms`, `5` events, usage `{ input: 4, output: 111 }`. |

## Benchmark Harness

`scripts/benchmark-acp-backends.ts` compares current and ACP transports for direct, flow, and loop workloads in disposable git repositories. It refuses to run unless `ORCA_ACP_BENCHMARK_LIVE=1` is set.

Example:

```bash
ORCA_ACP_BENCHMARK_LIVE=1 bun run scripts/benchmark-acp-backends.ts \
  --backends codex,claude \
  --transports current,acp \
  --workloads direct,flow,loop \
  --out-dir openspec/changes/spike-acp-claude-codex-backends/benchmarks/manual-run
```

The harness records wall time, time to first backend event, event count, backend prompt count, process count estimate, session reuse, final status, and cleanup status.
