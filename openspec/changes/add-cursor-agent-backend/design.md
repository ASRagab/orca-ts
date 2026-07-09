## Context

Orca currently supports four live backend tags: `claude`, `codex`, `opencode`, and `pi`. `BackendTagSchema`, `selectBackend()`, public exports, tests, docs, and symbol checks all treat that tag set as public API. Claude, Codex, and Pi use the shared subprocess execution helper. OpenCode is the managed-process exception.

Cursor's official CLI docs now support non-interactive automation through `agent -p`, with `--output-format text|json|stream-json`, `--stream-partial-output`, `--model`, `--mode`, `--force`, `--sandbox`, `--trust`, `--workspace`, and `--resume`.

## Goals / Non-Goals

**Goals:**

- Add Cursor Agent as a first-class Orca backend with the same `Conversation` and `LlmResult` contract as existing backends.
- Preserve backend-neutral flow and loop authoring: existing scripts should work by changing `ORCA_BACKEND`.
- Keep default CI deterministic; live Cursor validation must be opt-in and credential-gated.
- Validate both correctness and runtime performance with live flow and loop runs before declaring the backend release-ready.

**Non-Goals:**

- Do not add interactive human-question support for autonomous Cursor runs.
- Do not install, update, or vendor Cursor CLI; users are responsible for having the CLI installed and authenticated.
- Do not implement Cursor Cloud Agent orchestration, private workers, PR creation, or cloud handoff in this change.
- Do not support Cursor SDK or Cursor ACP in this change.
- Do not guarantee Cursor service/model latency; validate adapter overhead and observed live-run parity instead.

## Decisions

### Decision: Use the documented headless CLI as the only implementation target

Implement a subprocess-stream backend around `agent -p --output-format stream-json --stream-partial-output --trust --workspace <cwd> <prompt>`. Default `command` should be `agent`, with `cursor-agent` configurable through backend options for installations that expose that alias.

Rationale: this matches the existing Claude/Codex/Pi architecture, avoids a new beta SDK dependency, keeps cancellation and timeout behavior inside `runSubprocessConversation`, and uses the official non-interactive surface intended for scripts and CI.

Alternative rejected for this change: `@cursor/sdk` or Cursor ACP. They may be viable later, but this change should first make the installed CLI work as a normal Orca subprocess backend.

### Decision: Add backend tag `cursor`

Use `cursor` as the public tag rather than `cursor-agent`.

Rationale: existing tags are short product/runtime names (`claude`, `codex`, `opencode`, `pi`), and `cursor` is consistent with `ORCA_BACKEND` ergonomics. The constructor can be `cursor()` while the default command remains `agent`.

Alternative considered: `cursor-agent`. That mirrors the binary alias but is longer and leaks command naming into the public API.

### Decision: Treat Cursor as a subprocess-stream backend

Add `src/backends/cursor-run.ts` for config resolution and process launch, plus `src/backends/cursor-stream-json.ts` for frame parsing. Reuse `composeBackendPrompt()` and `runSubprocessConversation()`.

Cursor config mapping:

- `model` -> `--model`
- `readOnly: true` -> `--mode=ask`
- `readOnly: false` or omitted -> default agent mode
- `sandbox: "read-only"` -> `--mode=ask`
- `sandbox: "workspace-write"` -> `--sandbox enabled`
- `sandbox: "danger-full-access"` -> `--sandbox disabled` plus explicit force only when mutating behavior is requested
- `resumeSessionId` -> `--resume <id>`
- `selfManagedGit`, `systemPrompt`, and `retry` -> composed into the prompt
- `structuredOutput` -> prompt-level JSON instruction plus Orca post-validation unless Cursor CLI later exposes a native schema flag

The adapter must not pass `--force` for read-only smoke or planning runs. For mutating flows, the backend may add `--force` only when Orca config indicates the flow owns file edits.

### Decision: Require a fixture spike before parser implementation

Before writing the parser, capture small real Cursor CLI streams for read-only success, tool use, failure, cancellation, and resume. Store sanitized fixtures under the same style as existing backend parser fixtures/tests.

Rationale: the CLI docs document modes and examples, but not a full stable event schema. Parser code should be driven by observed frames and guarded by tests.

### Decision: Performance gate is measured, not assumed

Extend live smoke metadata to include `cursor` and record wall time, event count, session id presence, usage when available, and cleanup result. Add a small benchmark script or test mode that runs the same read-only prompt across `cursor`, `codex`, `claude`, `opencode`, and `pi` when available.

Cursor is acceptable only if:

- adapter overhead is negligible compared with total agent time;
- no extra long-lived process or leaked watcher remains after completion or cancellation;
- the same disposable-repo smoke finishes within the existing 120s live-smoke timeout;
- a documented dogfood run shows Cursor is on par with or faster than the existing coding-agent backends for the same flow and loop prompts selected for the gate.

## Risks / Trade-offs

- Cursor CLI stream schema is underdocumented -> capture live fixtures first, parse defensively, and keep the implementation scoped to fields the CLI actually emits.
- Non-interactive Cursor has full write access by default -> map read-only Orca config to `--mode=ask`, avoid `--force` by default, and run live validation in disposable git repositories.
- `--trust` suppresses workspace prompts -> only use it with explicit `cwd`/`--workspace` and never infer trust for arbitrary paths outside Orca-owned validation.
- Cursor service latency varies by model/account -> measure live runs and publish observed performance instead of promising universal speed.
- Structured output may be prompt-only -> keep Orca's Zod post-validation as the source of truth until Cursor exposes a native schema flag.
- Command naming differs across installs (`agent`, `cursor-agent`) -> default to official `agent`, expose `command` override, and document the required command.
- Cursor CLI may be absent on a developer or CI machine -> do not install it; gated live validation should report a clear prerequisite failure when Cursor validation is explicitly requested.

## Migration Plan

1. Add parser fixtures from sanitized Cursor CLI streams.
2. Implement the Cursor backend behind the new `cursor` tag.
3. Update tests, docs, and symbol checks so the backend appears everywhere existing backend tags appear.
4. Run deterministic verification with no live Cursor dependency.
5. Run gated live validation with `CURSOR_API_KEY`, including flow and loop prompts in disposable repositories.
6. If live parity fails, do not document Cursor as a supported backend; fix the CLI adapter or defer the change.

Rollback is simple before release: remove the `cursor` tag, constructor export, docs entries, tests, and CLI parser fixtures.

## Open Questions

- Does Cursor CLI `stream-json` always emit a terminal result frame with a stable chat/session id?
- Which event fields, if any, expose token usage or model usage suitable for Orca `Usage`?
- Should mutating Cursor runs require an explicit Orca config flag before passing `--force`?
