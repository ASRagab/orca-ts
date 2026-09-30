# Environment Variables

The canonical environment reference is the published
[Environment Variables page](https://ASRagab.github.io/orca-ts/reference/environment/).
This table mirrors its public and diagnostic names so source and both
documentation surfaces can be checked together.

| Variable | Class | Purpose |
| --- | --- | --- |
| `ORCA_BACKEND` | Public | Select `claude`, `codex`, `opencode`, or `pi`. |
| `ORCA_BACKEND_MODEL` | Public | Override the selected backend model. |
| `ORCA_BASELINE_POLICY` | Public | Select `repair`, `strict`, or `accept-dirty`. |
| `ORCA_CLAUDE_TRANSPORT` | Public | Select Claude `stream-json` (default) or explicit `acp`. |
| `ORCA_INSTALL_DIR` | Public | Set the release installer destination. |
| `ORCA_LOOP_EVENT` | Public | Supply one JSON-encoded loop firing event. |
| `ORCA_MONITOR_DIR` | Public | Set the monitoring-log directory used by packaged tools. |
| `ORCA_VERSION` | Public | Pin the release installer version. |
| `ORCA_ACP_BENCHMARK_LIVE` | Diagnostic | Explicitly allow live ACP benchmarks. |
| `ORCA_ACP_CAPTURE_LIVE` | Diagnostic | Explicitly allow live ACP transcript capture. |
| `ORCA_CLAUDE_ACP_COMMAND` | Diagnostic | Override the Claude ACP executable. |
| `ORCA_CODEX_ACP_COMMAND` | Diagnostic | Override the experimental Codex ACP executable. |
| `ORCA_EXPERIMENTAL_ACP_BACKENDS` | Diagnostic | Enable experimental ACP backend paths. |
| `ORCA_REAL_BACKEND` | Diagnostic | Select a backend for the gated live smoke. |
| `ORCA_REAL_BACKEND_SMOKE` | Diagnostic | Explicitly allow a live, token-spending readiness turn. |

Internal parent/child handshake variables are intentionally not user controls.
