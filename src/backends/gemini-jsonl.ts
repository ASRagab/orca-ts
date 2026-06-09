import { backendFailed, sessionId, unsupportedFeature, type Usage } from "../model/index.ts";
import {
  collectConversation,
  StreamConversation,
  type ConversationCapture
} from "../conversation/index.ts";

interface GeminiLine {
  readonly type?: string;
  readonly session_id?: string;
  readonly role?: string;
  readonly content?: string;
  readonly tool_name?: string;
  readonly tool_id?: string;
  readonly parameters?: unknown;
  readonly status?: string;
  readonly output?: unknown;
  readonly error?: string;
  readonly stats?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}

export type GeminiParseResult = ConversationCapture<"gemini">;

export interface GeminiStreamJsonArgs {
  readonly model?: string;
  readonly approvalMode?: "auto" | "yolo";
}

export function geminiStreamJsonArgs(args: GeminiStreamJsonArgs = {}): readonly string[] {
  return [
    "--output-format",
    "stream-json",
    ...(args.model ? ["--model", args.model] : []),
    ...(args.approvalMode ? ["--approval-mode", args.approvalMode] : [])
  ];
}

export function geminiSettingsWritesForV1(): readonly string[] {
  return [];
}

export async function collectGeminiJsonl(lines: readonly string[]): Promise<GeminiParseResult> {
  return await collectConversation({
    backend: "gemini",
    consume: async (conversation) => {
      await consumeGeminiJsonl(lines, conversation);
    }
  });
}

export async function consumeGeminiJsonl(
  lines: readonly string[],
  conversation: StreamConversation<"gemini">
): Promise<void> {
  let session = "";
  let output = "";

  for (const raw of lines) {
    if (raw.trim() === "") {
      continue;
    }
    const line = JSON.parse(raw) as GeminiLine;

    if (line.type === "init") {
      session = line.session_id ?? session;
      continue;
    }

    if (line.type === "tool_use") {
      if (line.tool_name === "orca__ask_user") {
        conversation.fail(unsupportedFeature("gemini ask_user", "Gemini ask_user MCP bridge is unsupported in v1"));
        return;
      }
      await conversation.emit({
        type: "assistant_tool_call",
        id: line.tool_id ?? "",
        name: line.tool_name ?? "",
        input: line.parameters ?? {}
      });
      continue;
    }

    if (line.type === "tool_result") {
      await conversation.emit({
        type: "tool_result",
        toolCallId: line.tool_id ?? "",
        output: line.output ?? "",
        ...(line.status === undefined ? {} : { isError: line.status !== "success" })
      });
      continue;
    }

    if (line.type === "message" && line.role === "assistant") {
      const text = line.content ?? "";
      output += text;
      await conversation.emit({ type: "assistant_text_delta", text });
      await conversation.emit({ type: "assistant_turn_end" });
      continue;
    }

    if (line.type === "result") {
      if (line.status === "success") {
        conversation.succeed({
          backend: "gemini",
          sessionId: sessionId("gemini", session),
          output,
          usage: normalizeGeminiUsage(line.stats)
        });
      } else {
        conversation.fail(backendFailed("gemini", line.error ?? "Gemini session failed"));
      }
      return;
    }
  }
}

function normalizeGeminiUsage(stats: GeminiLine["stats"]): Usage {
  return {
    input: stats?.input_tokens ?? 0,
    output: stats?.output_tokens ?? 0
  };
}
