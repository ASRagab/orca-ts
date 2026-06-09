import type { z } from "zod";
import {
  createClaudeStreamConsumer,
  type ClaudeStreamOptions
} from "./claude-stream-json.ts";
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

/** Build the `claude` stream-json invocation. Mirrors Scala `ClaudeArgs.streamJson`:
 * `--print --input-format stream-json --output-format stream-json --verbose
 * --include-partial-messages`, plus model / session / permission-mode / inline
 * `--json-schema`. The opening user turn is written to stdin, not argv. */
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
    ...permissionModeArgs(config.readOnly),
    ...(config.schema ? ["--json-schema", JSON.stringify(jsonSchemaFromZod(config.schema))] : [])
  ];
}

function permissionModeArgs(readOnly: boolean | undefined): readonly string[] {
  // readOnly → `plan` makes Edit/Write/Bash unavailable (hard guarantee); an
  // autonomous acting turn needs writes, so default to bypassPermissions.
  return ["--permission-mode", readOnly ? "plan" : "bypassPermissions"];
}

/** Claude's stdin user-turn NDJSON shape (Scala `OutboundMessage.UserText`). */
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
      onStart: (process) => {
        process.write?.(`${userTurnLine(composePrompt(request.prompt, config))}\n`);
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
  const config: ResolvedClaudeConfig<Output> = {};
  const optionConfig = options.config;
  const requestConfig = request.config;

  setValue(config, "model", requestConfig?.model ?? optionConfig?.model);
  setValue(config, "systemPrompt", requestConfig?.systemPrompt ?? optionConfig?.systemPrompt);
  setValue(config, "readOnly", requestConfig?.readOnly ?? optionConfig?.readOnly);
  setValue(config, "selfManagedGit", requestConfig?.selfManagedGit ?? optionConfig?.selfManagedGit);
  setValue(config, "retryAttempts", requestConfig?.retry?.attempts ?? optionConfig?.retry?.attempts);
  setValue(
    config,
    "schema",
    requestConfig?.structuredOutput?.schema ??
      request.schema ??
      (optionConfig?.structuredOutput?.schema as z.ZodType<Output> | undefined)
  );
  setValue(
    config,
    "resumeSessionId",
    requestConfig?.resumeSessionId === undefined ? undefined : String(requestConfig.resumeSessionId)
  );

  return config;
}

function setValue<Output, Key extends keyof ResolvedClaudeConfig<Output>>(
  config: ResolvedClaudeConfig<Output>,
  key: Key,
  value: ResolvedClaudeConfig<Output>[Key]
): void {
  if (value !== undefined) {
    config[key] = value;
  }
}

function composePrompt<Output>(prompt: string, config: ResolvedClaudeConfig<Output>): string {
  return [
    config.systemPrompt ? `System instructions:\n${config.systemPrompt}` : "",
    config.selfManagedGit === false
      ? "Git policy: Orca is the parent runtime. Do not create commits, branches, pushes, or pull requests; leave repository mutation to the parent workflow."
      : "",
    config.retryAttempts === undefined ? "" : `Retry policy: maximum attempts ${String(config.retryAttempts)}.`,
    prompt
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
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
