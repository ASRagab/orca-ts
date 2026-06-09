import { backendFailed, sessionId, unsupportedFeature, type ConversationEvent, type Usage } from "../model/index.ts";
import { StreamConversation, type Outcome } from "../conversation/index.ts";

interface CodexLine {
  readonly type?: string;
  readonly thread_id?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly reasoning_output_tokens?: number;
  };
  readonly item?: {
    readonly id?: string;
    readonly type?: string;
    readonly text?: string;
    readonly server?: string;
    readonly tool?: string;
    readonly arguments?: unknown;
    readonly result?: {
      readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
    } | null;
    readonly error?: string | null;
  };
}

export interface CodexParseResult {
  readonly events: readonly ConversationEvent[];
  readonly outcome: Outcome<"codex">;
}

export interface CodexExecArgs {
  readonly model?: string;
  readonly approvalPolicy?: "auto" | "never" | "on-request";
  readonly prompt?: string;
}

export function codexExecJsonlArgs(args: CodexExecArgs = {}): readonly string[] {
  return [
    "exec",
    "--json",
    ...(args.model ? ["--model", args.model] : []),
    ...(args.approvalPolicy ? ["--approval-policy", args.approvalPolicy] : []),
    ...(args.prompt !== undefined ? [args.prompt] : [])
  ];
}

export async function collectCodexJsonl(lines: readonly string[]): Promise<CodexParseResult> {
  const conversation = new StreamConversation({ backend: "codex" });
  await consumeCodexJsonl(lines, conversation);

  const events: ConversationEvent[] = [];
  for await (const event of conversation.events()) {
    events.push(event);
  }

  return { events, outcome: await conversation.awaitResult() };
}

export async function consumeCodexJsonl(
  lines: readonly string[],
  conversation: StreamConversation<"codex">
): Promise<void> {
  const consumer = createCodexJsonlConsumer(conversation);
  for (const raw of lines) {
    await consumer.consume(raw);
  }
  consumer.finish();
}

export interface CodexJsonlConsumer {
  readonly completed: boolean;
  consume(raw: string): Promise<void>;
  finish(): void;
}

export function createCodexJsonlConsumer(
  conversation: StreamConversation<"codex">
): CodexJsonlConsumer {
  let threadId = "";
  let output = "";
  let completed = false;

  return {
    get completed() {
      return completed;
    },

    async consume(raw: string): Promise<void> {
      if (completed || raw.trim() === "") {
        return;
      }

      let line: CodexLine;
      try {
        line = JSON.parse(raw) as CodexLine;
      } catch (error) {
        completed = true;
        conversation.fail(backendFailed("codex", `invalid codex JSONL: ${errorMessage(error)}`));
        return;
      }

      if (line.type === "thread.started") {
        threadId = line.thread_id ?? threadId;
        return;
      }

      if (line.type === "item.started" && line.item?.type === "mcp_tool_call") {
        if (line.item.server === "orca" && line.item.tool === "ask_user") {
          completed = true;
          conversation.fail(unsupportedFeature("codex ask_user", "Codex ask_user MCP bridge is unsupported in v1"));
          return;
        }
        await conversation.emit({
          type: "assistant_tool_call",
          id: line.item.id ?? "",
          name: `${line.item.server ?? ""}.${line.item.tool ?? ""}`,
          input: line.item.arguments ?? {}
        });
        return;
      }

      if (line.type === "item.completed" && line.item?.type === "mcp_tool_call") {
        if (line.item.error) {
          completed = true;
          conversation.fail(backendFailed("codex", line.item.error));
          return;
        }
        await conversation.emit({
          type: "tool_result",
          toolCallId: line.item.id ?? "",
          output: textContent(line.item.result?.content)
        });
        return;
      }

      if (line.type === "item.completed" && line.item?.type === "agent_message") {
        const text = line.item.text ?? "";
        output += text;
        await conversation.emit({ type: "assistant_text_delta", text });
        return;
      }

      if (line.type === "turn.completed") {
        await conversation.emit({ type: "assistant_turn_end" });
        completed = true;
        conversation.succeed({
          backend: "codex",
          sessionId: sessionId("codex", threadId),
          output,
          usage: normalizeCodexUsage(line.usage)
        });
      }
    },

    finish(): void {
      if (completed) {
        return;
      }
      completed = true;
      conversation.fail(backendFailed("codex", "codex stream ended before turn.completed"));
    }
  };
}

function textContent(content: ReadonlyArray<{ readonly text?: string }> | undefined): string {
  return content?.map((part) => part.text ?? "").join("") ?? "";
}

function normalizeCodexUsage(usage: CodexLine["usage"]): Usage {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    ...(usage?.reasoning_output_tokens ? { reasoning: usage.reasoning_output_tokens } : {})
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
