import { backendFailed, sessionId, type ConversationEvent, type Usage } from "../model/index.ts";
import { StreamConversation, type Outcome } from "../conversation/index.ts";

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

export interface OpenCodeParseResult {
  readonly events: readonly ConversationEvent[];
  readonly outcome: Outcome<"opencode">;
}

export interface OpenCodeServerProcess {
  readonly url: string;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export interface OpenCodeServerManager {
  get(): Promise<OpenCodeServerProcess>;
  shutdown(signal?: NodeJS.Signals): Promise<void>;
}

export async function collectOpenCodeSse(lines: readonly string[]): Promise<OpenCodeParseResult> {
  const conversation = new StreamConversation({ backend: "opencode" });
  await consumeOpenCodeSse(lines, conversation);

  const events: ConversationEvent[] = [];
  for await (const event of conversation.events()) {
    events.push(event);
  }

  return { events, outcome: await conversation.awaitResult() };
}

export async function consumeOpenCodeSse(
  lines: readonly string[],
  conversation: StreamConversation<"opencode">
): Promise<void> {
  let output = "";
  let session = "";
  let structured: unknown;
  let usage: Usage | undefined;

  for (const raw of lines) {
    const event = parseSseLine(raw);
    if (!event) {
      continue;
    }

    if (event.type === "message.part.delta" && event.properties?.field === "text") {
      const delta = event.properties.delta ?? "";
      output += delta;
      await conversation.emit({ type: "assistant_text_delta", text: delta });
      continue;
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
      continue;
    }

    if (event.type === "message.updated") {
      const info = event.properties?.info;
      session = info?.sessionID ?? session;
      structured = info?.structured;
      usage = normalizeUsage(info?.tokens);
      if (structured !== undefined) {
        output = JSON.stringify(structured);
      }
      await conversation.emit({ type: "assistant_turn_end" });
      continue;
    }

    if (event.type === "session.error") {
      conversation.fail(backendFailed("opencode", event.properties?.error?.message ?? "OpenCode session failed"));
      return;
    }

    if (event.type === "session.idle") {
      conversation.succeed({
        backend: "opencode",
        sessionId: sessionId("opencode", session),
        output,
        ...(structured === undefined ? {} : { structured }),
        ...(usage === undefined ? {} : { usage })
      });
      return;
    }
  }
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
