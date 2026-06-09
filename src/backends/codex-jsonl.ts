import type { z } from "zod";
import {
  collectConversation,
  StreamConversation,
  type ConversationCapture
} from "../conversation/index.ts";
import {
  backendFailed,
  parseStructuredOutput,
  sessionId,
  structuredOutputValidationFailed,
  unsupportedFeature,
  type BackendApprovalPolicy,
  type BackendSandboxMode,
  type RuntimeError,
  type Usage
} from "../model/index.ts";

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
    readonly name?: string;
    readonly server?: string;
    readonly tool?: string;
    readonly command?: unknown;
    readonly path?: string;
    readonly changes?: unknown;
    readonly output?: unknown;
    readonly arguments?: unknown;
    readonly result?: {
      readonly content?: ReadonlyArray<{ readonly text?: string }>;
    } | null;
    readonly error?: string | null;
  };
}

export type CodexParseResult = ConversationCapture<"codex">;

export interface CodexExecArgs {
  readonly model?: string;
  readonly approvalPolicy?: BackendApprovalPolicy;
  readonly sandbox?: BackendSandboxMode;
  readonly readOnly?: boolean;
  readonly outputSchemaPath?: string;
  readonly resumeSessionId?: string;
  readonly mcpServerUrl?: string;
  readonly prompt?: string;
}

export function codexExecJsonlArgs(args: CodexExecArgs = {}): readonly string[] {
  const sandbox = args.sandbox ?? (args.readOnly ? "read-only" : undefined);
  const promptArgs = args.prompt === undefined ? [] : [args.prompt];
  const commonArgs = [
    "--json",
    ...(args.model ? ["--model", args.model] : []),
    ...(args.approvalPolicy ? ["-c", `approval_policy="${args.approvalPolicy}"`] : []),
    ...(args.mcpServerUrl ? ["-c", `mcp_servers.orca.url=${JSON.stringify(args.mcpServerUrl)}`] : []),
    ...(args.outputSchemaPath ? ["--output-schema", args.outputSchemaPath] : [])
  ];

  if (args.resumeSessionId) {
    return [
      "exec",
      "resume",
      ...commonArgs,
      // `codex exec resume` rejects the exec-only `--sandbox` flag; express the
      // sandbox as the equivalent config override instead (same form as
      // `approval_policy` above).
      ...(sandbox ? ["-c", `sandbox_mode="${sandbox}"`] : []),
      args.resumeSessionId,
      ...promptArgs
    ];
  }

  return [
    "exec",
    ...commonArgs,
    ...(sandbox ? ["--sandbox", sandbox] : []),
    ...promptArgs
  ];
}

export interface CodexJsonlOptions<Output = unknown> {
  readonly schema?: z.ZodType<Output>;
  /** Interactive conversations surface the agent's `ask_user` call as a
   * `user_question` event for the renderer. The answer is NOT routed here — Codex
   * obtains it from the Orca MCP HTTP bridge and re-emits it on the matching
   * `item.completed`, which the tool-result branch turns into a `tool_result`.
   * Autonomous conversations leave this false and reject `ask_user` explicitly. */
  readonly interactive?: boolean;
}

export async function collectCodexJsonl<Output = unknown>(
  lines: readonly string[],
  options: CodexJsonlOptions<Output> = {}
): Promise<CodexParseResult> {
  return collectConversation({
    backend: "codex",
    consume: async (conversation) => {
      await consumeCodexJsonl(lines, conversation, options);
    }
  });
}

export async function consumeCodexJsonl<Output = unknown>(
  lines: readonly string[],
  conversation: StreamConversation<"codex">,
  options: CodexJsonlOptions<Output> = {}
): Promise<void> {
  const consumer = createCodexJsonlConsumer(conversation, options);
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

export function createCodexJsonlConsumer<Output = unknown>(
  conversation: StreamConversation<"codex">,
  options: CodexJsonlOptions<Output> = {}
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
        const message = error instanceof Error ? error.message : String(error);
        conversation.fail(backendFailed("codex", `invalid codex JSONL: ${message}`));
        return;
      }

      if (line.type === "thread.started") {
        threadId = line.thread_id ?? threadId;
        return;
      }

      if (line.type === "item.started" && isToolItem(line.item)) {
        if (line.item.server === "orca" && line.item.tool === "ask_user") {
          if (options.interactive) {
            // Surface the question for the renderer only. The answer travels
            // Codex ↔ Orca MCP HTTP bridge and arrives on the matching
            // `item.completed`, which the tool-result branch emits below.
            const question = askUserQuestion(line.item.arguments);
            await conversation.emit({ type: "user_question", question });
            return;
          }
          completed = true;
          conversation.fail(
            unsupportedFeature(
              "codex ask_user",
              "Codex ask_user MCP bridge requires an explicit interactive conversation"
            )
          );
          return;
        }
        await conversation.emit({
          type: "assistant_tool_call",
          id: line.item.id ?? "",
          name: toolName(line.item),
          input: toolInput(line.item)
        });
        return;
      }

      if (line.type === "item.completed" && isToolItem(line.item)) {
        await conversation.emit({
          type: "tool_result",
          toolCallId: line.item.id ?? "",
          output: toolOutput(line.item),
          ...(line.item.error ? { isError: true } : {})
        });
        if (line.item.error) {
          completed = true;
          conversation.fail(backendFailed("codex", line.item.error));
        }
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
        const structured = parseCodexStructuredOutput(options.schema, output);
        if (structured.type === "failed") {
          completed = true;
          conversation.fail(structured.error);
          return;
        }

        completed = true;
        conversation.succeed({
          backend: "codex",
          sessionId: sessionId("codex", threadId),
          output,
          ...(structured.value === undefined ? {} : { structured: structured.value }),
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

function parseCodexStructuredOutput<Output>(
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
        issues: ["Codex structured output was not valid JSON"]
      })
    };
  }

  const parsed = parseStructuredOutput(schema, raw);
  if (parsed.isErr()) {
    return { type: "failed", error: parsed.error };
  }

  return { type: "success", value: parsed.value.value };
}

function isToolItem(item: CodexLine["item"]): item is NonNullable<CodexLine["item"]> {
  return (
    item?.type === "mcp_tool_call" ||
    item?.type === "command_execution" ||
    item?.type === "file_change" ||
    item?.type === "tool_call"
  );
}

function toolName(item: NonNullable<CodexLine["item"]>): string {
  if (item.type === "mcp_tool_call") {
    return `${item.server ?? ""}.${item.tool ?? ""}`;
  }
  return item.name ?? item.tool ?? item.type ?? "tool_call";
}

function toolInput(item: NonNullable<CodexLine["item"]>): unknown {
  if (item.arguments !== undefined) {
    return item.arguments;
  }
  if (item.command !== undefined) {
    return { command: item.command };
  }
  if (item.path !== undefined || item.changes !== undefined) {
    return {
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.changes === undefined ? {} : { changes: item.changes })
    };
  }
  return {};
}

function toolOutput(item: NonNullable<CodexLine["item"]>): unknown {
  if (item.output !== undefined) {
    return item.output;
  }
  const content = item.result?.content?.map((part) => part.text ?? "").join("") ?? "";
  if (content.length > 0) {
    return content;
  }
  return item.error ?? "";
}

function askUserQuestion(input: unknown): string {
  if (typeof input === "object" && input !== null && "question" in input) {
    const question = (input as { readonly question?: unknown }).question;
    return typeof question === "string" ? question : "";
  }
  return "";
}

function normalizeCodexUsage(usage: CodexLine["usage"]): Usage {
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    ...(usage?.reasoning_output_tokens ? { reasoning: usage.reasoning_output_tokens } : {})
  };
}
