import { backendFailed, sessionId } from "../model/index.ts";
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

export async function collectClaudeStreamJson(lines: readonly string[]): Promise<ClaudeParseResult> {
  return await collectConversation({
    backend: "claude",
    consume: async (conversation) => {
      await consumeClaudeStreamJson(lines, conversation);
    }
  });
}

export async function consumeClaudeStreamJson(
  lines: readonly string[],
  conversation: StreamConversation<"claude">
): Promise<void> {
  for (const raw of lines) {
    if (raw.trim() === "") {
      continue;
    }

    const line = JSON.parse(raw) as ClaudeStreamLine;
    await consumeClaudeLine(line, conversation);
  }
}

async function consumeClaudeLine(
  line: ClaudeStreamLine,
  conversation: StreamConversation<"claude">
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
    await consumeResult(line, conversation);
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
  let emittedAssistantContent = false;

  for (const block of content) {
    switch (block.type) {
      case "tool_use":
        await conversation.emit({
          type: "assistant_tool_call",
          id: block.id,
          name: block.name,
          input: block.input
        });
        emittedAssistantContent = true;
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
        emittedAssistantContent = true;
        break;
    }
  }

  if (line.type === "assistant" && emittedAssistantContent) {
    await conversation.emit({ type: "assistant_turn_end" });
  }
}

async function consumeResult(
  line: ClaudeStreamLine,
  conversation: StreamConversation<"claude">
): Promise<void> {
  const output = line.result ?? "";
  const session = sessionId("claude", line.session_id ?? "");

  if (line.subtype === "success" && !line.is_error) {
    conversation.succeed({
      backend: "claude",
      sessionId: session,
      output
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
