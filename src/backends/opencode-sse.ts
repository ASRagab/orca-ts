import { backendFailed, sessionId, type Usage } from "../model/index.ts";
import {
  collectConversation,
  StreamConversation,
  type ConversationCapture
} from "../conversation/index.ts";

interface OpenCodeSseEvent {
  readonly type?: string;
  readonly properties?: {
    readonly field?: string;
    readonly delta?: string;
    readonly error?: { readonly message?: string };
    readonly part?: {
      readonly id?: string;
      readonly type?: string;
      readonly tool?: string;
      readonly state?: {
        readonly status?: string;
        readonly output?: unknown;
      };
    };
    readonly info?: {
      readonly role?: string;
      readonly sessionID?: string;
      readonly structured?: unknown;
      readonly tokens?: {
        readonly input?: number;
        readonly output?: number;
        readonly reasoning?: number;
        readonly cache?: {
          readonly read?: number;
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
}

function newOpenCodeSseState(): OpenCodeSseState {
  return { output: "", session: "", structured: undefined, usage: undefined };
}

/** Apply one SSE line to the conversation, mutating `state`. Returns `true` when
 * the event is terminal (`session.idle` succeeded / `session.error` failed). The
 * single source of truth for OpenCode event → conversation mapping, shared by the
 * batch parser and the live incremental consumer so they can't drift. */
async function applyOpenCodeSseLine(
  raw: string,
  conversation: StreamConversation<"opencode">,
  state: OpenCodeSseState
): Promise<boolean> {
  const event = parseSseLine(raw);
  if (!event) {
    return false;
  }

  if (event.type === "message.part.delta" && event.properties?.field === "text") {
    const delta = event.properties.delta ?? "";
    state.output += delta;
    await conversation.emit({ type: "assistant_text_delta", text: delta });
    return false;
  }

  if (event.type === "message.part.updated") {
    const part = event.properties?.part;
    if (part?.type === "tool" && part.state?.status === "completed") {
      await conversation.emit({
        type: "tool_result",
        toolCallId: part.id ?? part.tool ?? "",
        output: part.state.output ?? "",
        isError: false
      });
    }
    return false;
  }

  if (event.type === "message.updated") {
    const info = event.properties?.info;
    state.session = info?.sessionID ?? state.session;
    state.structured = info?.structured;
    state.usage = normalizeUsage(info?.tokens);
    if (state.structured !== undefined) {
      state.output = JSON.stringify(state.structured);
    }
    await conversation.emit({ type: "assistant_turn_end" });
    return false;
  }

  if (event.type === "session.error") {
    conversation.fail(
      backendFailed("opencode", event.properties?.error?.message ?? "OpenCode session failed")
    );
    return true;
  }

  if (event.type === "session.idle") {
    conversation.succeed({
      backend: "opencode",
      sessionId: sessionId("opencode", state.session),
      output: state.output,
      ...(state.structured === undefined ? {} : { structured: state.structured }),
      ...(state.usage === undefined ? {} : { usage: state.usage })
    });
    return true;
  }

  return false;
}

export async function consumeOpenCodeSse(
  lines: readonly string[],
  conversation: StreamConversation<"opencode">
): Promise<void> {
  const state = newOpenCodeSseState();
  for (const raw of lines) {
    if (await applyOpenCodeSseLine(raw, conversation, state)) {
      return;
    }
  }
}

export interface OpenCodeSseConsumer {
  readonly completed: boolean;
  consume(raw: string): Promise<void>;
  finish(): void;
}

/** Incremental consumer for the live driver: feeds SSE lines off the wire and
 * fails cleanly if the stream ends before a terminal `session.idle`/`error`. */
export function createOpenCodeSseConsumer(
  conversation: StreamConversation<"opencode">
): OpenCodeSseConsumer {
  const state = newOpenCodeSseState();
  let completed = false;

  return {
    get completed() {
      return completed;
    },

    async consume(raw: string): Promise<void> {
      if (completed) {
        return;
      }
      if (await applyOpenCodeSseLine(raw, conversation, state)) {
        completed = true;
      }
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
    input: (tokens.input ?? 0) + (tokens.cache?.read ?? 0),
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0
  };
}
