import type { z } from "zod";
import {
  backendFailed,
  parseStructuredOutput,
  sessionId,
  structuredOutputValidationFailed,
  type RuntimeError,
  type Usage
} from "../model/index.ts";
import {
  collectConversation,
  StreamConversation,
  type ConversationCapture
} from "../conversation/index.ts";

interface PiLine {
  readonly type?: string;
  readonly success?: boolean;
  readonly error?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: unknown;
  readonly isError?: boolean;
  readonly result?: {
    readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  };
  readonly message?: {
    readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
    readonly usage?: {
      readonly input?: number;
      readonly output?: number;
    };
  };
}

export type PiParseResult = ConversationCapture<"pi">;

export function piRpcArgs(sessionDir: string): readonly string[] {
  return ["--mode", "rpc", "--session-dir", sessionDir];
}

export function piPromptCommand(message: string): string {
  return JSON.stringify({ id: "orca-prompt", type: "prompt", message });
}

export async function collectPiRpc(
  lines: readonly string[],
  piSessionId = "pi-session"
): Promise<PiParseResult> {
  return await collectConversation({
    backend: "pi",
    consume: async (conversation) => {
      await consumePiRpc(lines, conversation, piSessionId);
    }
  });
}

export interface PiRpcOptions<Output = unknown> {
  readonly schema?: z.ZodType<Output>;
}

interface PiRpcState {
  output: string;
  usage: Usage;
}

function newPiRpcState(): PiRpcState {
  return { output: "", usage: { input: 0, output: 0 } };
}

/** Apply one Pi RPC line to the conversation, mutating `state`. Returns `true`
 * when terminal (`agent_end` succeeded / a failed `response` failed). Single
 * source of truth shared by the batch parser and the live incremental consumer. */
async function applyPiRpcLine<Output>(
  raw: string,
  conversation: StreamConversation<"pi">,
  state: PiRpcState,
  piSessionId: string,
  options: PiRpcOptions<Output>
): Promise<boolean> {
  if (raw.trim() === "") {
    return false;
  }
  const line = JSON.parse(raw) as PiLine;

  if (line.type === "response" && line.success === false) {
    const message = line.error ?? "Pi command failed";
    await conversation.emit({ type: "error", message });
    conversation.fail(backendFailed("pi", message));
    return true;
  }

  if (line.type === "tool_execution_start") {
    await conversation.emit({
      type: "assistant_tool_call",
      id: line.toolCallId ?? "",
      name: line.toolName ?? "",
      input: line.args ?? {}
    });
    return false;
  }

  if (line.type === "tool_execution_end") {
    await conversation.emit({
      type: "tool_result",
      toolCallId: line.toolCallId ?? "",
      output: textContent(line.result?.content),
      isError: line.isError ?? false
    });
    return false;
  }

  if (line.type === "message_end") {
    state.output = textContent(line.message?.content);
    state.usage = {
      input: line.message?.usage?.input ?? 0,
      output: line.message?.usage?.output ?? 0
    };
    if (state.output) {
      await conversation.emit({ type: "assistant_text_delta", text: state.output });
      await conversation.emit({ type: "assistant_turn_end" });
    }
    return false;
  }

  if (line.type === "agent_end") {
    const structured = parsePiStructuredOutput(options.schema, state.output);
    if (structured.type === "failed") {
      conversation.fail(structured.error);
      return true;
    }
    conversation.succeed({
      backend: "pi",
      sessionId: sessionId("pi", piSessionId),
      output: state.output,
      usage: state.usage,
      ...(structured.value === undefined ? {} : { structured: structured.value })
    });
    return true;
  }

  return false;
}

export async function consumePiRpc(
  lines: readonly string[],
  conversation: StreamConversation<"pi">,
  piSessionId = "pi-session"
): Promise<void> {
  const state = newPiRpcState();
  for (const raw of lines) {
    if (await applyPiRpcLine(raw, conversation, state, piSessionId, {})) {
      return;
    }
  }
}

export interface PiRpcConsumer {
  readonly signal: AbortSignal;
  consume(raw: string): Promise<void>;
  finish(): void;
}

/** Incremental consumer for the live driver: tolerates malformed JSON, validates
 * structured output against a supplied schema (Pi has no native schema flag, so
 * this is post-hoc text validation), and fails cleanly if the stream ends before
 * `agent_end`. */
export function createPiRpcConsumer<Output = unknown>(
  conversation: StreamConversation<"pi">,
  piSessionId: string,
  options: PiRpcOptions<Output> = {}
): PiRpcConsumer {
  const state = newPiRpcState();
  const controller = new AbortController();

  return {
    get signal() {
      return controller.signal;
    },

    async consume(raw: string): Promise<void> {
      if (controller.signal.aborted) {
        return;
      }
      let terminal: boolean;
      try {
        terminal = await applyPiRpcLine(raw, conversation, state, piSessionId, options);
      } catch (error) {
        controller.abort();
        const message = error instanceof Error ? error.message : String(error);
        conversation.fail(backendFailed("pi", `invalid pi RPC: ${message}`));
        return;
      }
      if (terminal) {
        controller.abort();
      }
    },

    finish(): void {
      if (controller.signal.aborted) {
        return;
      }
      controller.abort();
      conversation.fail(backendFailed("pi", "pi stream ended before agent_end"));
    }
  };
}

function parsePiStructuredOutput<Output>(
  schema: z.ZodType<Output> | undefined,
  output: string
):
  | { readonly type: "success"; readonly value?: Output }
  | { readonly type: "failed"; readonly error: RuntimeError } {
  if (!schema) {
    return { type: "success" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(output) as unknown;
  } catch {
    return {
      type: "failed",
      error: structuredOutputValidationFailed({
        raw: output,
        issues: ["Pi structured output was not valid JSON"]
      })
    };
  }

  const parsed = parseStructuredOutput(schema, raw);
  if (parsed.isErr()) {
    return { type: "failed", error: parsed.error };
  }

  return { type: "success", value: parsed.value.value };
}

function textContent(content: ReadonlyArray<{ readonly text?: string }> | undefined): string {
  return content?.map((part) => part.text ?? "").join("") ?? "";
}
