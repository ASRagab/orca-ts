---
title: Environment Variables
description: Canonical reference for supported ORCA_* operator settings.
---

This is the canonical reference for supported operator-facing `ORCA_*`
variables. Public variables configure normal use. Diagnostic variables opt into
advanced or live verification paths. Internal process handshakes are omitted
because operators must not set them.

## Public settings

| Variable | Purpose | Values or format | Default and precedence | Security or spending |
| --- | --- | --- | --- | --- |
| `ORCA_BACKEND` | Select the backend used by `selectBackend()`. | `claude`, `codex`, `opencode`, or `pi` | `--backend` sets it; otherwise it overrides `selectBackend({ default })`. | A live run may spend against the selected backend account. |
| `ORCA_BACKEND_MODEL` | Override the selected backend model. | Backend model identifier | Overrides `perBackend[tag].model` and shared `config.model`; unset keeps code configuration. | Model choice can change cost and data handling. |
| `ORCA_BASELINE_POLICY` | Choose generated-workflow baseline behavior. | `repair`, `strict`, or `accept-dirty` | Defaults to `repair`; `--baseline` wins. | `accept-dirty` permits user-owned changes, so use it only deliberately. |
| `ORCA_CLAUDE_TRANSPORT` | Choose Claude transport. | `stream-json` or `acp` | `stream-json` by default; `claude({ transport })` wins over the environment. | Both paths use Claude credentials and may spend tokens. ACP is explicit opt-in pending compatibility proof. |
| `ORCA_INSTALL_DIR` | Set release installer destination. | Writable directory | `$HOME/.local/bin` | The installer writes executables here; use a trusted directory on `PATH`. |
| `ORCA_LOOP_EVENT` | Supply one loop firing event. | JSON text; invalid JSON is delivered as a raw string | Unset means no event. `orcats serve` sets it for child firings. | Treat event data as untrusted input and avoid putting secrets in shell history. |
| `ORCA_MONITOR_DIR` | Set the monitoring-log directory used by packaged run and summary tools. | Directory path | `<current-directory>/.orca/monitoring` | Logs can contain paths, failures, usage, and cost data; protect them accordingly. |
| `ORCA_VERSION` | Pin release installation. | Version with or without a leading `v` | Unset downloads latest release. | Installer still verifies the release checksum. |

## Diagnostic and live gates

| Variable | Purpose | Values or format | Default and precedence | Security or spending |
| --- | --- | --- | --- | --- |
| `ORCA_CLAUDE_ACP_COMMAND` | Override the executable used by explicit Claude ACP transport. | Executable name or path | `claude-agent-acp` | Executes the selected program with your Claude access; trust the path. |
| `ORCA_CODEX_ACP_COMMAND` | Override the experimental Codex ACP executable. | Executable name or path | Version-pinned adapter through `npx` | Executes the selected program with your Codex access; trust the path. |
| `ORCA_EXPERIMENTAL_ACP_BACKENDS` | Enable experimental ACP paths. | `1` or comma-separated `claude,codex` | Disabled | Diagnostic only; may start credentialed backend processes. Prefer `ORCA_CLAUDE_TRANSPORT=acp` for Claude. |
| `ORCA_REAL_BACKEND` | Select the backend for the gated integration smoke. | `claude`, `codex`, `opencode`, or `pi` | `codex` | Has no effect unless the live-smoke gate is enabled. |
| `ORCA_REAL_BACKEND_SMOKE` | Permit a bounded live readiness or integration turn. | Exactly `1` | Disabled; `--smoke` is the doctor equivalent. | Spends a small number of tokens and sends the smoke prompt to the provider. Require explicit consent before enabling it. |
| `ORCA_ACP_BENCHMARK_LIVE` | Permit live ACP benchmark workloads. | Exactly `1` | Disabled | Can run many credentialed turns and spend tokens. Enable only for an intentional benchmark. |
| `ORCA_ACP_CAPTURE_LIVE` | Permit live ACP transcript scenarios. | Exactly `1` | Disabled for live scenarios | Can spend tokens and writes backend transcripts; review captured data before sharing. |

The documentation checker derives names from runtime, CLI, installer, packaged
skill scripts, and gated diagnostic sources. It requires every public and
diagnostic name on this page and in the in-repo reference.
