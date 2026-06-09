import { backendFailed, sessionId, type ConversationEvent, type Usage } from "../model/index.ts";
import { StreamConversation, type Outcome } from "../conversation/index.ts";

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

export interface PiParseResult {
  readonly events: readonly ConversationEvent[];
  readonly outcome: Outcome<"pi">;
}

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
  const conversation = new StreamConversation({ backend: "pi" });
  await consumePiRpc(lines, conversation, piSessionId);

  const events: ConversationEvent[] = [];
  for await (const event of conversation.events()) {
    events.push(event);
  }

  return { events, outcome: await conversation.awaitResult() };
}

export async function consumePiRpc(
  lines: readonly string[],
  conversation: StreamConversation<"pi">,
  piSessionId = "pi-session"
): Promise<void> {
  let output = "";
  let usage: Usage = { input: 0, output: 0 };

  for (const raw of lines) {
    if (raw.trim() === "") {
      continue;
    }
    const line = JSON.parse(raw) as PiLine;

    if (line.type === "response" && line.success === false) {
      const message = line.error ?? "Pi command failed";
      await conversation.emit({ type: "error", message });
      conversation.fail(backendFailed("pi", message));
      return;
    }

    if (line.type === "tool_execution_start") {
      await conversation.emit({
        type: "assistant_tool_call",
        id: line.toolCallId ?? "",
        name: line.toolName ?? "",
        input: line.args ?? {}
      });
      continue;
    }

    if (line.type === "tool_execution_end") {
      await conversation.emit({
        type: "tool_result",
        toolCallId: line.toolCallId ?? "",
        output: textContent(line.result?.content),
        isError: line.isError ?? false
      });
      continue;
    }

    if (line.type === "message_end") {
      output = textContent(line.message?.content);
      usage = {
        input: line.message?.usage?.input ?? 0,
        output: line.message?.usage?.output ?? 0
      };
      if (output) {
        await conversation.emit({ type: "assistant_text_delta", text: output });
        await conversation.emit({ type: "assistant_turn_end" });
      }
      continue;
    }

    if (line.type === "agent_end") {
      conversation.succeed({
        backend: "pi",
        sessionId: sessionId("pi", piSessionId),
        output,
        usage
      });
      return;
    }
  }
}

function textContent(content: ReadonlyArray<{ readonly text?: string }> | undefined): string {
  return content?.map((part) => part.text ?? "").join("") ?? "";
}
