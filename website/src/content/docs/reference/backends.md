---
title: Backend Matrix
description: Backend tags, constructors, the LlmBackend contract, selectBackend, and shared timeout defaults.
---

A backend is an LLM driver that produces autonomous `Conversation`s. orca ships four backend tags — `claude`, `codex`, `opencode`, `pi` — behind a shared `LlmBackend<B>` contract. Signatures are transcribed from `src/backends/` and verified by `bun run docs:symbols`.

## Tags and constructors

```ts
type BackendTag = "claude" | "codex" | "opencode" | "pi";
```

| Backend | Tag | Constructor | Returns | Runtime |
| --- | --- | --- | --- | --- |
| Claude | `claude` | `claude(options?)` | `LlmBackend<"claude">` | ACP JSON-RPC over `claude-agent-acp` by default; stream-json fallback via `ORCA_CLAUDE_TRANSPORT=stream-json`. |
| Codex | `codex` | `codex(options?)` | `LlmBackend<"codex">` | Subprocess JSONL over `codex exec --json`. |
| OpenCode | `opencode` | `opencode(options?)` | `OpenCodeBackend` | Managed `opencode serve` over HTTP/SSE. |
| Pi | `pi` | `pi(options?)` | `LlmBackend<"pi">` | Subprocess RPC JSONL over the `pi` CLI. |

```ts
export function claude(options?: ClaudeBackendOptions): LlmBackend<"claude">;
export function codex(options?: CodexBackendOptions): LlmBackend<"codex">;
export function opencode(options?: OpenCodeBackendOptions): OpenCodeBackend;
export function pi(options?: PiBackendOptions): LlmBackend<"pi">;
```

All constructors default to `{}` and return immediately — they do not start a process or perform IO. The backend process is spawned lazily on the first `autonomous()` call.

`codex({ ignoreUserConfig: true })` passes `--ignore-user-config` to `codex exec`, keeping Codex auth while skipping user config such as MCP servers. Use it for hermetic automation; leave it unset when a flow should honor the operator's normal Codex setup.

`claude()` uses `claude-agent-acp` by default. Set `ORCA_CLAUDE_ACP_COMMAND` to point at a different ACP adapter command, or set `ORCA_CLAUDE_TRANSPORT=stream-json` / `claude({ transport: "stream-json" })` to use the previous `claude --print --input-format stream-json` subprocess path. Model-pinned and resumed Claude runs use the stream-json fallback automatically because the ACP adapter does not expose equivalent stable fields yet.

## The `LlmBackend<B>` contract

```ts
interface AutonomousRequest<Output = unknown, B extends BackendTag = BackendTag> {
  readonly prompt: string;
  readonly schema?: z.ZodType<Output>;
  readonly config?: BackendConfig<B, Output>;
}

interface LlmBackend<B extends BackendTag = BackendTag> {
  readonly tag: B;
  autonomous<Output = unknown>(request: AutonomousRequest<Output, B>): Conversation<B>;
}
```

`autonomous(request)` starts a run and returns a `Conversation<B>` **synchronously** — it does not await the result. Consume events with `events()` and the terminal state with `awaitResult()` (which never rejects; see [Errors and Results](../errors-and-results/)). When `schema` is provided, the run validates structured output against it; a validation failure surfaces as a `StructuredOutputValidationFailed` `RuntimeError` (see [Runtime Errors](../runtime-errors/)).

## `OpenCodeBackend`

`opencode()` is the only constructor that returns a subtype:

```ts
interface OpenCodeBackend extends LlmBackend<"opencode"> {
  shutdown(signal?: NodeJS.Signals): Promise<void>;
}
```

OpenCode owns a managed `opencode serve` process. Call `shutdown()` when done (typically in a `finally`). When selected through `selectBackend()`, the shutdown is exposed on `SelectedBackend.shutdown`.

## `selectBackend()`

```ts
interface SelectBackendOptions {
  readonly default: BackendTag;
  readonly config?: PortableBackendConfig;
  readonly perBackend?: Partial<Record<BackendTag, PortableBackendConfig>>;
  readonly env?: NodeJS.ProcessEnv;
}

interface SelectedBackend {
  readonly tag: BackendTag;
  readonly backend: LlmBackend;
  readonly model?: string;
  readonly shutdown?: () => Promise<void>;
}

export function selectBackend(options: SelectBackendOptions): SelectedBackend;
```

`selectBackend` resolves the backend **synchronously** and **throws** on an invalid `ORCA_BACKEND`. The chosen tag is `process.env.ORCA_BACKEND` when set, otherwise `options.default`. An unrecognized value throws `Unsupported backend "<value>" (expected one of: claude, codex, opencode, pi)` — wrap the call if you prefer a `Result`-style boundary.

```ts
import { selectBackend } from "orca";

const selected = selectBackend({ default: "claude" }); // reads ORCA_BACKEND
try {
  const convo = selected.backend.autonomous({ prompt: "ship it" });
  const outcome = await convo.awaitResult();
} finally {
  await selected.shutdown?.(); // present for opencode
}
```

## Timeout defaults

Each backend takes optional `inactivityTimeoutMs` and `wallClockTimeoutMs`; OpenCode additionally takes `startupTimeoutMs`. When omitted, shared defaults apply (defined in `src/backends/subprocess-run.ts` and `src/backends/opencode-run.ts`):

| Timeout | Default | Applies to | Effect when exceeded |
| --- | --- | --- | --- |
| Inactivity | `120_000` ms (120s) | claude, codex, opencode, pi | No event for the window → run aborted. |
| Wall-clock | `600_000` ms (600s) | claude, codex, opencode, pi | Absolute per-turn cap, even if events keep flowing. |
| Startup | `30_000` ms (30s) | opencode only | `opencode serve` did not print a listening URL → `BackendFailed`. |

A timeout aborts the conversation's `signal`; `awaitResult()` then resolves to `{ type: "cancelled" }` or `{ type: "failed", error }` — it never rejects.

## Credentials and login

Autonomous conversations are intended to complete without asking the human for input. Configure credentials, approvals, and login state before running a live flow. See [Backend Setup](../../guides/backend-setup/) and [Backend Auth troubleshooting](../../troubleshooting/backend-auth/).

Gemini is not a supported backend in this release. Future Google support should use a new `agy` backend tag rather than reviving the Gemini path.
