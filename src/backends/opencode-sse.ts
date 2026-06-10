import { backendFailed, sessionId, type Usage } from "../model/index.ts";
import {
  collectConversation,
  StreamConversation,
  type ConversationCapture
} from "../conversation/index.ts";

interface OpenCodeSseEvent {
  readonly type?: string;
  readonly properties?: {
    readonly sessionID?: string;
    readonly field?: string;
    readonly delta?: string;
    readonly error?: unknown;
    readonly part?: {
      readonly id?: string;
      readonly sessionID?: string;
      readonly type?: string;
      readonly tool?: string;
      readonly state?: {
        readonly status?: string;
        readonly input?: unknown;
        readonly output?: unknown;
      };
    };
    readonly info?: {
      readonly role?: string;
      readonly sessionID?: string;
      readonly structured?: unknown;
      readonly error?: unknown;
      readonly tokens?: {
        readonly input?: number;
        readonly output?: number;
        readonly reasoning?: number;
        readonly cache?: {
          readonly read?: number;
          readonly write?: number;
        };
      };
    };
  };
}

interface OpenCodeTokens {
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cache?: {
    readonly read?: number;
    readonly write?: number;
  };
}

export type OpenCodeParseResult = ConversationCapture<"opencode">;

export interface OpenCodeServerProcess {
  readonly url: string;
  /** Preemptive `Authorization` header value the server requires (Basic auth from
   * the `OPENCODE_SERVER_PASSWORD` the spawn set). Absent for transports that
   * don't authenticate. */
  readonly authHeader?: string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export interface OpenCodeServerManager {
  get(): Promise<OpenCodeServerProcess>;
  shutdown(signal?: NodeJS.Signals): Promise<void>;
}

export async function collectOpenCodeSse(lines: readonly string[]): Promise<OpenCodeParseResult> {
  return await collectConversation({
    backend: "opencode",
    consume: async (conversation) => {
      await consumeOpenCodeSse(lines, conversation);
    }
  });
}

interface OpenCodeSseState {
  output: string;
  session: string;
  structured: unknown;
  usage: Usage | undefined;
  error: unknown;
  assistantSeen: boolean;
  startedTools: Set<string>;
}

function newOpenCodeSseState(): OpenCodeSseState {
  return {
    output: "",
    session: "",
    structured: undefined,
    usage: undefined,
    error: undefined,
    assistantSeen: false,
    startedTools: new Set()
  };
}

interface OpenCodeLineOutcome {
  /** Terminal event consumed (`session.idle`/`session.error` settled the turn). */
  readonly terminal: boolean;
  /** Line belonged to this turn's session — only relevant lines count as
   * activity for the inactivity watchdog, so foreign-session traffic can't
   * mask a dead turn. */
  readonly relevant: boolean;
}

const IGNORED: OpenCodeLineOutcome = { terminal: false, relevant: false };
const CONSUMED: OpenCodeLineOutcome = { terminal: false, relevant: true };
const TERMINAL: OpenCodeLineOutcome = { terminal: true, relevant: true };

/** opencode wraps errors as `{name, data: {message}}` and sometimes as a bare
 * `{message}` (Scala `OpencodeEvent.errorMessage`); fall back to the raw JSON so
 * the failure is never silently empty. */
export function extractOpenCodeErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const shape = error as { readonly message?: unknown; readonly data?: { readonly message?: unknown } };
    if (typeof shape.message === "string") {
      return shape.message;
    }
    if (typeof shape.data?.message === "string") {
      return shape.data.message;
    }
  }
  return JSON.stringify(error);
}

/** Session id owner of an event, per the oracle's per-type extraction rules
 * (Scala `OpencodeEvent.sessionId`). */
function eventSession(event: OpenCodeSseEvent): string | undefined {
  switch (event.type) {
    case "message.part.delta":
    case "message.part.updated":
      return event.properties?.sessionID ?? event.properties?.part?.sessionID;
    case "message.updated":
      return event.properties?.sessionID ?? event.properties?.info?.sessionID;
    default:
      return event.properties?.sessionID;
  }
}

/** Apply one SSE line to the conversation, mutating `state`. The single source
 * of truth for OpenCode event → conversation mapping, shared by the batch parser
 * and the live incremental consumer so they can't drift.
 *
 * When `session` is given, the `/event` firehose is scoped to it: events owned
 * by another session are dropped (opencode spawns child sessions for subagent
 * work, and their idle/error/updated frames must not settle or pollute this
 * turn). An event with a *missing* session id is treated as ours — terminal
 * frames from a protocol deviation settle the turn instead of hanging it
 * (Scala `forThisSession`'s `forall`). */
async function applyOpenCodeSseLine(
  raw: string,
  conversation: StreamConversation<"opencode">,
  state: OpenCodeSseState,
  session?: string
): Promise<OpenCodeLineOutcome> {
  const event = parseSseLine(raw);
  if (!event) {
    return IGNORED;
  }

  const owner = eventSession(event);
  if (session !== undefined && owner !== undefined && owner !== session) {
    return IGNORED;
  }

  if (event.type === "message.part.delta" && event.properties?.field === "text") {
    const delta = event.properties.delta ?? "";
    state.output += delta;
    await conversation.emit({ type: "assistant_text_delta", text: delta });
    return CONSUMED;
  }

  if (event.type === "message.part.delta" && event.properties?.field === "reasoning") {
    await conversation.emit({
      type: "assistant_thinking_delta",
      text: event.properties.delta ?? ""
    });
    return CONSUMED;
  }

  if (event.type === "message.part.updated") {
    const part = event.properties?.part;
    if (part?.type === "tool") {
      const toolCallId = part.id ?? part.tool ?? "";
      const status = part.state?.status;
      if (status === "running" && !state.startedTools.has(toolCallId)) {
        state.startedTools.add(toolCallId);
        await conversation.emit({
          type: "assistant_tool_call",
          id: toolCallId,
          name: part.tool ?? "",
          input: part.state?.input
        });
      } else if (status === "completed" || status === "error") {
        await conversation.emit({
          type: "tool_result",
          toolCallId,
          output: part.state?.output ?? "",
          isError: status === "error"
        });
      }
    }
    return CONSUMED;
  }

  if (event.type === "message.updated") {
    const info = event.properties?.info;
    // opencode echoes the user message (`role:"user"`, no structured/tokens);
    // a non-assistant update must not masquerade as — or wipe — the result.
    if (info?.role !== "assistant") {
      return CONSUMED;
    }
    state.assistantSeen = true;
    state.session = info.sessionID ?? state.session;
    state.structured = info.structured;
    state.usage = normalizeUsage(info.tokens);
    state.error = info.error;
    if (state.structured !== undefined) {
      state.output = JSON.stringify(state.structured);
    }
    await conversation.emit({ type: "assistant_turn_end" });
    return CONSUMED;
  }

  if (event.type === "session.error") {
    const error = event.properties?.error;
    conversation.fail(
      backendFailed(
        "opencode",
        error === undefined ? "OpenCode session failed" : extractOpenCodeErrorMessage(error)
      )
    );
    return TERMINAL;
  }

  if (event.type === "session.idle") {
    // Mirrors Scala `finishTurn`: an error-bearing assistant message means the
    // agent failed even though the session idled "normally" — succeeding here
    // would return garbage output and bury the actual failure.
    if (state.error !== undefined) {
      conversation.fail(backendFailed("opencode", extractOpenCodeErrorMessage(state.error)));
      return TERMINAL;
    }
    if (!state.assistantSeen && state.output === "") {
      conversation.fail(
        backendFailed("opencode", "session went idle without an assistant message")
      );
      return TERMINAL;
    }
    conversation.succeed({
      backend: "opencode",
      sessionId: sessionId("opencode", state.session),
      output: state.output,
      ...(state.structured === undefined ? {} : { structured: state.structured }),
      ...(state.usage === undefined ? {} : { usage: state.usage })
    });
    return TERMINAL;
  }

  return CONSUMED;
}

export async function consumeOpenCodeSse(
  lines: readonly string[],
  conversation: StreamConversation<"opencode">,
  session?: string
): Promise<void> {
  const state = newOpenCodeSseState();
  for (const raw of lines) {
    if ((await applyOpenCodeSseLine(raw, conversation, state, session)).terminal) {
      return;
    }
  }
}

export interface OpenCodeSseConsumer {
  readonly completed: boolean;
  /** Returns whether the line was relevant to this turn's session (activity
   * signal for the inactivity watchdog). */
  consume(raw: string): Promise<boolean>;
  finish(): void;
}

/** Incremental consumer for the live driver: feeds SSE lines off the wire,
 * scoped to `session`, and fails cleanly if the stream ends before a terminal
 * `session.idle`/`error`. */
export function createOpenCodeSseConsumer(
  conversation: StreamConversation<"opencode">,
  session: string
): OpenCodeSseConsumer {
  const state = newOpenCodeSseState();
  let completed = false;

  return {
    get completed() {
      return completed;
    },

    async consume(raw: string): Promise<boolean> {
      if (completed) {
        return false;
      }
      const outcome = await applyOpenCodeSseLine(raw, conversation, state, session);
      if (outcome.terminal) {
        completed = true;
      }
      return outcome.relevant;
    },

    finish(): void {
      if (completed) {
        return;
      }
      completed = true;
      conversation.fail(backendFailed("opencode", "opencode stream ended before session.idle"));
    }
  };
}

export function createOpenCodeServerManager(args: {
  start: () => Promise<OpenCodeServerProcess>;
}): OpenCodeServerManager {
  let processPromise: Promise<OpenCodeServerProcess> | undefined;

  return {
    async get() {
      processPromise ??= args.start();
      return await processPromise;
    },
    async shutdown(signal = "SIGINT") {
      const process = await processPromise;
      processPromise = undefined;
      await process?.stop(signal);
    }
  };
}

function parseSseLine(raw: string): OpenCodeSseEvent | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("data:")) {
    return undefined;
  }
  return JSON.parse(trimmed.slice("data:".length).trim()) as OpenCodeSseEvent;
}

function normalizeUsage(tokens: OpenCodeTokens | undefined): Usage | undefined {
  if (!tokens) {
    return undefined;
  }

  return {
    input: (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0),
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0
  };
}
