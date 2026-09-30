---
title: Backend Setup
description: Configure supported coding-agent backends before running live flows.
---

Every live backend needs its native CLI or server installed and authenticated before a flow runs.

| Backend | Tag | Constructor | Requirement |
| --- | --- | --- | --- |
| Claude | `claude` | `claude()` | Authenticated `claude` CLI for default `stream-json`; set `ORCA_CLAUDE_TRANSPORT=acp` for explicit ACP use |
| Codex | `codex` | `codex()` | `codex` CLI on `PATH` and authenticated |
| OpenCode | `opencode` | `opencode()` | `opencode` CLI on `PATH`; Orca manages `opencode serve` |
| Pi | `pi` | `pi()` | `pi` CLI on `PATH` and authenticated |

Use `selectBackend()` when the flow should honor `--backend`:

```ts
const selected = selectBackend({
  default: "codex",
  config: { readOnly: true },
  perBackend: {
    opencode: { model: "openai/gpt-5.5" }
  }
});
```

Resolution order:

1. `ORCA_BACKEND` chooses the backend tag; empty or unset uses `default`.
2. `config` applies to every backend.
3. `perBackend[tag]` overrides shared config for one backend.
4. `ORCA_BACKEND_MODEL` overrides `perBackend[tag].model` and `config.model`.

Presence, version, and static auth checks are evidence, but they do not prove the
selected transport can complete a turn. The setup doctor reports those checks
separately and leaves the backend `unverified` until a bounded readiness turn
succeeds. It asks for consent because the turn sends a prompt and spends tokens.

Run the opt-in integration smoke only from a configured machine:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
```

Default CI and `bun run verify` do not require backend credentials.

Claude defaults to `stream-json`. ACP remains explicit opt-in pending
compatibility proof against installed Claude and adapter versions. Orcats never
silently switches transports after a failure because the first turn may already
have caused side effects. See [Environment Variables](../../reference/environment/)
for precedence, command overrides, and live-spending gates.
