import type { z } from "zod";
import {
  createClaudeStreamConsumer,
  type ClaudeStreamOptions
} from "./claude-stream-json.ts";
import { composeBackendPrompt } from "./conversation-config.ts";
import {
  errorMessage,
  runSubprocessConversation,
  type SubprocessProcess,
  type SubprocessSpawner
} from "./subprocess-run.ts";
import type { AutonomousRequest, LlmBackend } from "./types.ts";
import { StreamConversation } from "../conversation/index.ts";
import { backendFailed, jsonSchemaFromZod, type BackendConfig } from "../model/index.ts";

export type ClaudeProcess = SubprocessProcess;
export type ClaudeProcessSpawner = SubprocessSpawner;

export interface ClaudeBackendOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly capacity?: number;
  readonly spawnProcess?: ClaudeProcessSpawner;
  readonly config?: BackendConfig<"claude">;
  readonly inactivityTimeoutMs?: number;
  readonly wallClockTimeoutMs?: number;
}

interface ResolvedClaudeConfig<Output> {
  model?: string;
  systemPrompt?: string;
  readOnly?: boolean;
  selfManagedGit?: boolean;
  retryAttempts?: number;
  schema?: z.ZodType<Output>;
  resumeSessionId?: string;
}

export function claudeStreamJsonArgs<Output>(config: ResolvedClaudeConfig<Output>): readonly string[] {
  return [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(config.model ? ["--model", config.model] : []),
    ...(config.resumeSessionId ? ["--resume", config.resumeSessionId] : []),
    "--permission-mode",
    config.readOnly ? "plan" : "bypassPermissions",
    ...(config.schema ? ["--json-schema", JSON.stringify(jsonSchemaFromZod(config.schema))] : [])
  ];
}

function userTurnLine(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] }
  });
}

export async function runClaudeConversation<Output>(
  request: AutonomousRequest<Output, "claude">,
  options: ClaudeBackendOptions,
  conversation: StreamConversation<"claude">,
  setProcess: (process: ClaudeProcess) => void
): Promise<void> {
  const command = options.command ?? "claude";
  const config = resolveClaudeConfig(request, options);

  try {
    const args = claudeStreamJsonArgs(config);
    const consumerOptions: ClaudeStreamOptions<Output> =
      config.schema === undefined ? {} : { schema: config.schema };

    await runSubprocessConversation({
      backend: "claude",
      command,
      args,
      conversation,
      setProcess,
      stdin: "pipe",
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      ...(options.inactivityTimeoutMs === undefined ? {} : { inactivityTimeoutMs: options.inactivityTimeoutMs }),
      ...(options.wallClockTimeoutMs === undefined ? {} : { wallClockTimeoutMs: options.wallClockTimeoutMs }),
      onStart: (process) => {
        process.write?.(`${userTurnLine(composeBackendPrompt(request.prompt, config))}\n`);
        process.endStdin?.();
      },
      createConsumer: () => createClaudeStreamConsumer(conversation, consumerOptions)
    });
  } catch (error) {
    if (!conversation.signal.aborted) {
      conversation.fail(backendFailed("claude", errorMessage(error)));
    }
  }
}

function resolveClaudeConfig<Output>(
  request: AutonomousRequest<Output, "claude">,
  options: ClaudeBackendOptions
): ResolvedClaudeConfig<Output> {
  const optionConfig = options.config;
  const requestConfig = request.config;
  const config: ResolvedClaudeConfig<Output> = {};
  const model = requestConfig?.model ?? optionConfig?.model;
  if (model !== undefined) config.model = model;
  const systemPrompt = requestConfig?.systemPrompt ?? optionConfig?.systemPrompt;
  if (systemPrompt !== undefined) config.systemPrompt = systemPrompt;
  const readOnly = requestConfig?.readOnly ?? optionConfig?.readOnly;
  if (readOnly !== undefined) config.readOnly = readOnly;
  const selfManagedGit = requestConfig?.selfManagedGit ?? optionConfig?.selfManagedGit;
  if (selfManagedGit !== undefined) config.selfManagedGit = selfManagedGit;
  const retryAttempts = requestConfig?.retry?.attempts ?? optionConfig?.retry?.attempts;
  if (retryAttempts !== undefined) config.retryAttempts = retryAttempts;
  const schema =
    requestConfig?.structuredOutput?.schema ??
    request.schema ??
    (optionConfig?.structuredOutput?.schema as z.ZodType<Output> | undefined);
  if (schema !== undefined) config.schema = schema;
  if (requestConfig?.resumeSessionId !== undefined)
    config.resumeSessionId = String(requestConfig.resumeSessionId);
  return config;
}

export function claude(options: ClaudeBackendOptions = {}): LlmBackend<"claude"> {
  return {
    tag: "claude",
    autonomous<Output = unknown>(request: AutonomousRequest<Output, "claude">) {
      let child: ClaudeProcess | undefined;
      const conversation = new StreamConversation({
        backend: "claude",
        capacity: options.capacity ?? 256,
        canAskUser: false,
        onCancel: () => {
          child?.kill("SIGTERM");
        }
      });

      queueMicrotask(() => {
        void runClaudeConversation(request, options, conversation, (process) => {
          child = process;
        });
      });

      return conversation;
    }
  };
}
