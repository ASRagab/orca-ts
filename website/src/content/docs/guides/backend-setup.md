---
title: Backend Setup
description: Configure supported coding-agent backends before running live flows.
---

Every live backend needs its native CLI or server installed and authenticated before a flow runs.

| Backend | Tag | Constructor | Requirement |
| --- | --- | --- | --- |
| Claude | `claude` | `claude()` | `claude` CLI on `PATH` and authenticated |
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

Run the opt-in live smoke only from a configured machine:

```bash
ORCA_REAL_BACKEND_SMOKE=1 ORCA_REAL_BACKEND=codex bun test tests/integration/real-backend-smoke.test.ts
```

Default CI and `bun run verify` do not require backend credentials.
