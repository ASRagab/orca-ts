import type { z } from "zod";
import {
  backendFailed,
  parseStructuredOutput,
  sessionId,
  structuredOutputValidationFailed,
  type RuntimeError
} from "../model/index.ts";
import {
  collectConversation,
  StreamConversation,
  type ConversationCapture
} from "../conversation/index.ts";

interface ClaudeStreamLine {
  readonly type?: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly result?: string;
  /** Schema-enforced value when the session ran with `--json-schema` (a JSON
   * subtree, already parsed). Preferred over `result` per Scala
   * `structuredOutput.orElse(output)`. */
  readonly structured_output?: unknown;
  readonly is_error?: boolean;
  readonly event?: {
    readonly type?: string;
    readonly delta?: {
      readonly type?: string;
      readonly text?: string;
    };
  };
  readonly message?: {
    readonly role?: string;
    readonly content?: readonly ClaudeContentBlock[];
  };
}

type ClaudeContentBlock =
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: unknown;
      readonly is_error?: boolean;
    }
  | {
      readonly type: "text";
      readonly text: string;
    };

export type ClaudeParseResult = ConversationCapture<"claude">;

export interface ClaudeStreamOptions<Output = unknown> {
  readonly schema?: z.ZodType<Output>;
}

export async function collectClaudeStreamJson(lines: readonly string[]): Promise<ClaudeParseResult> {
  return collectConversation({
    backend: "claude",
    consume: async (conversation) => {
      await consumeClaudeStreamJson(lines, conversation);
    }
  });
}

export async function consumeClaudeStreamJson<Output = unknown>(
  lines: readonly string[],
  conversation: StreamConversation<"claude">,
  options: ClaudeStreamOptions<Output> = {}
): Promise<void> {
  for (const raw of lines) {
    if (raw.trim() === "") {
      continue;
    }

    const line = JSON.parse(raw) as ClaudeStreamLine;
    await consumeClaudeLine(line, conversation, options);
  }
}

export interface ClaudeStreamConsumer {
  readonly completed: boolean;
  consume(raw: string): Promise<void>;
  finish(): void;
}

/** Incremental, fault-tolerant consumer used by the live driver: tolerates
 * malformed JSON (→ backend failure rather than a throw), validates structured
 * output against a supplied schema, and fails cleanly if the stream ends before
 * claude sends its `result` message (mirrors Scala `cleanExitWithoutResult`). The
 * batch {@link consumeClaudeStreamJson} above is left untouched so Tier-1 parity
 * fixtures keep their exact behavior. */
export function createClaudeStreamConsumer<Output = unknown>(
  conversation: StreamConversation<"claude">,
  options: ClaudeStreamOptions<Output> = {}
): ClaudeStreamConsumer {
  let completed = false;

  return {
    get completed() {
      return completed;
    },

    async consume(raw: string): Promise<void> {
      if (completed || raw.trim() === "") {
        return;
      }

      let line: ClaudeStreamLine;
      try {
        line = JSON.parse(raw) as ClaudeStreamLine;
      } catch (error) {
        completed = true;
        const message = error instanceof Error ? error.message : String(error);
        conversation.fail(backendFailed("claude", `invalid claude stream-json: ${message}`));
        return;
      }

      await consumeClaudeLine(line, conversation, options);
      if (line.type === "result") {
        completed = true;
      }
    },

    finish(): void {
      if (completed) {
        return;
      }
      completed = true;
      conversation.fail(
        backendFailed("claude", "claude exited cleanly but never sent a result message")
      );
    }
  };
}

async function consumeClaudeLine<Output>(
  line: ClaudeStreamLine,
  conversation: StreamConversation<"claude">,
  options: ClaudeStreamOptions<Output>
): Promise<void> {
  if (line.type === "stream_event") {
    await consumeStreamEvent(line, conversation);
    return;
  }

  if (line.type === "assistant" || line.type === "user") {
    await consumeMessage(line, conversation);
    return;
  }

  if (line.type === "result") {
    await consumeResult(line, conversation, options);
  }
}

async function consumeStreamEvent(
  line: ClaudeStreamLine,
  conversation: StreamConversation<"claude">
): Promise<void> {
  const delta = line.event?.delta;
  if (line.event?.type === "content_block_delta" && delta?.type === "text_delta") {
    await conversation.emit({ type: "assistant_text_delta", text: delta.text ?? "" });
  }
}

async function consumeMessage(
  line: ClaudeStreamLine,
  conversation: StreamConversation<"claude">
): Promise<void> {
  const content = line.message?.content ?? [];
  let endsAssistantTurn = false;

  for (const block of content) {
    switch (block.type) {
      case "tool_use":
        await conversation.emit({
          type: "assistant_tool_call",
          id: block.id,
          name: block.name,
          input: block.input
        });
        break;
      case "tool_result":
        await conversation.emit({
          type: "tool_result",
          toolCallId: block.tool_use_id,
          output: block.content,
          isError: block.is_error
        });
        break;
      case "text":
        await conversation.emit({ type: "assistant_text_delta", text: block.text });
        break;
    }

    if (line.type === "assistant" && (block.type === "tool_use" || block.type === "text")) {
      endsAssistantTurn = true;
    }
  }

  if (endsAssistantTurn) {
    await conversation.emit({ type: "assistant_turn_end" });
  }
}

async function consumeResult<Output>(
  line: ClaudeStreamLine,
  conversation: StreamConversation<"claude">,
  options: ClaudeStreamOptions<Output>
): Promise<void> {
  // `--json-schema` runs put the validated value on `structured_output` (a JSON
  // subtree), not `result`; prefer it and stringify for the textual `output`.
  const hasStructuredField = line.structured_output !== undefined;
  const output = hasStructuredField ? JSON.stringify(line.structured_output) : line.result ?? "";
  const session = sessionId("claude", line.session_id ?? "");

  if (line.subtype === "success" && !line.is_error) {
    const structured = parseClaudeStructuredOutput(
      options.schema,
      hasStructuredField ? line.structured_output : output,
      hasStructuredField
    );
    if (structured.type === "failed") {
      conversation.fail(structured.error);
      return;
    }
    conversation.succeed({
      backend: "claude",
      sessionId: session,
      output,
      ...(structured.value === undefined ? {} : { structured: structured.value })
    });
    return;
  }

  await conversation.emit({
    type: "error",
    code: "backend_failed",
    message: "session failed (see message above)"
  });
  conversation.fail(backendFailed("claude", `claude session failed: ${output}`));
}

function parseClaudeStructuredOutput<Output>(
  schema: z.ZodType<Output> | undefined,
  value: unknown,
  alreadyParsed: boolean
):
  | { readonly type: "success"; readonly value?: Output }
  | { readonly type: "failed"; readonly error: RuntimeError } {
  if (!schema) {
    return { type: "success" };
  }

  let raw: unknown;
  if (alreadyParsed) {
    raw = value;
  } else {
    const text = typeof value === "string" ? value : "";
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return {
        type: "failed",
        error: structuredOutputValidationFailed({
          raw: text,
          issues: ["Claude structured output was not valid JSON"]
        })
      };
    }
  }

  const parsed = parseStructuredOutput(schema, raw);
  if (parsed.isErr()) {
    return { type: "failed", error: parsed.error };
  }

  return { type: "success", value: parsed.value.value };
}
