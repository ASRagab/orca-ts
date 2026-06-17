---
title: Backend Matrix
description: Supported backend tags, constructors, and runtime requirements.
---

| Backend | Tag | Constructor | Runtime |
| --- | --- | --- | --- |
| Claude | `claude` | `claude()` | Subprocess stream over the `claude` CLI. |
| Codex | `codex` | `codex()` | Subprocess JSONL over `codex exec --json`. |
| OpenCode | `opencode` | `opencode()` | Managed `opencode serve` over HTTP/SSE. |
| Pi | `pi` | `pi()` | Subprocess RPC JSONL over the `pi` CLI. |

Autonomous conversations are intended to complete without asking the human for input. Configure credentials, approvals, and login state before running a live flow.

OpenCode is the only backend that owns a managed server process. When selected through `selectBackend()`, call `selected.shutdown?.()` in a `finally`.

Gemini is not a supported backend in this release. Future Google support should use a new `agy` backend tag rather than reviving the Gemini path.
