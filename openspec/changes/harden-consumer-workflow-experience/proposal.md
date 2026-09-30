## Why

A real `ticket-to-pr-spacelift` run needed three launches before reaching its
correct no-op result: an ambient Bun preload crashed the standalone binary,
Claude ACP stalled despite passing setup checks, and the failed turn was absent
from structured monitoring. The
[experience report](https://artyfacts.ai/a/edd084ef-b695-4126-9627-aeb7ce3291f0)
also exposed a broader contract gap: non-TypeScript repositories cannot verify
authored workflows before spending backend time.

## What Changes

- Restore Claude `stream-json` as the reliable default transport and keep ACP as
  an explicit opt-in until installed-version compatibility is proven.
- Make backend failures name the backend, selected transport, failed phase,
  user workflow location, and safe recovery command while keeping internal Bun
  frames out of the primary diagnostic.
- Isolate standalone execution from ambient Bun preload settings before Orcats
  launches workflow or repository children.
- Add a self-contained `orcats check` path that typechecks workflows and loop
  modules without a target-repository TypeScript project, package dependency,
  or network access; use it in CLI preflight and authoring.
- Persist terminal monitoring state, including success/failure status, end time,
  active stage, backend, transport, and the terminal error.
- Make backend readiness distinguish CLI/auth presence from a successful turn
  over the selected transport, and require transport-proven readiness before a
  skill declares a backend usable.
- Keep generated scratch data out of commits independently of tracked
  `.gitignore` changes, and update execution guidance to trust terminal monitor
  state rather than wrapper exit-code patterns.
- Align the standalone binary, all three packaged skills, README/in-repo guides,
  website guides/reference, generated templates, and deterministic checks.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `conversation-backends`: Change Claude's reliable default and require
  transport-aware, actionable failure behavior.
- `distribution`: Make standalone execution resilient to ambient Bun preloads
  and provide target-repository-independent artifact typechecking.
- `execution-observability`: Record explicit terminal run state and backend
  failure context in machine-readable monitoring output.
- `workflow-skill-setup`: Separate presence/auth checks from selected-transport
  proof before declaring a backend usable.
- `workflow-skill-authoring`: Require self-contained artifact typechecking and
  scratch-safe generated repository mutations.
- `workflow-skill-execution`: Diagnose from terminal monitoring state and give
  transport-specific recovery guidance.
- `documentation-website`: Keep published setup, backend, typecheck,
  monitoring, and troubleshooting contracts aligned with runtime behavior.

## Impact

- Affected runtime: Claude transport selection, backend diagnostics, process
  launch environment, CLI preflight/checking, and `WorkflowMonitor` lifecycle.
- Affected distribution: compiled binaries, installer/package smoke coverage,
  embedded declarations/compiler inputs, and binary-size validation.
- Affected skills: `orcats-setup`, `orcats-author`, `orcats-flow`, their shared
  scripts, templates, runbooks, and drift tests.
- Affected docs: `README.md`, `docs/`, website guides/reference, CLI help, and
  documented `ORCA_*` settings.
- Default CI remains deterministic and credential-free. A gated live smoke must
  prove both Claude transports, including the installed Claude version that
  motivated this change.
