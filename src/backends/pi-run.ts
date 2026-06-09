import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { createPiRpcConsumer, piPromptCommand, piRpcArgs, type PiRpcOptions } from "./pi-rpc.ts";
import {
  errorMessage,
  runSubprocessConversation,
  type SubprocessProcess,
  type SubprocessSpawner
} from "./subprocess-run.ts";
import type { AutonomousRequest, LlmBackend } from "./types.ts";
import { StreamConversation } from "../conversation/index.ts";
import { backendFailed, type BackendConfig } from "../model/index.ts";

export type PiProcess = SubprocessProcess;
export type PiProcessSpawner = SubprocessSpawner;

export interface PiBackendOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly capacity?: number;
  readonly spawnProcess?: PiProcessSpawner;
  readonly config?: BackendConfig<"pi">;
  /** Base directory for per-session Pi `--session-dir`s. Defaults to the OS temp dir. */
  readonly sessionsDir?: string;
}

interface ResolvedPiConfig<Output> {
  model?: string;
  systemPrompt?: string;
  readOnly?: boolean;
  selfManagedGit?: boolean;
  retryAttempts?: number;
  schema?: z.ZodType<Output>;
  resumeSessionId?: string;
}

/** Pi's read-only tool allow-list (Scala `PiArgs.ReadOnlyTools`). */
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** Build the `pi --mode rpc` argv (Scala `PiArgs.rpc`): session dir, `--continue`
 * on resume, model, and the read-only `--tools` gate. The prompt is sent as a
 * stdin RPC command, not on argv. */
function piArgs<Output>(sessionDir: string, config: ResolvedPiConfig<Output>): readonly string[] {
  return [
    ...piRpcArgs(sessionDir),
    ...(config.resumeSessionId ? ["--continue"] : []),
    ...(config.model ? ["--model", config.model] : []),
    ...(config.readOnly ? ["--tools", READ_ONLY_TOOLS.join(",")] : [])
  ];
}

export async function runPiConversation<Output>(
  request: AutonomousRequest<Output, "pi">,
  options: PiBackendOptions,
  conversation: StreamConversation<"pi">,
  setProcess: (process: PiProcess) => void
): Promise<void> {
  const command = options.command ?? "pi";
  const config = resolvePiConfig(request, options);

  try {
    const piSessionId = config.resumeSessionId ?? crypto.randomUUID();
    const sessionDir = join(options.sessionsDir ?? tmpdir(), `orca-pi-${piSessionId}`);
    // Synchronous so the process spawns within the first microtask (matching
    // codex/claude): a cancel right after start still finds the child to kill.
    mkdirSync(sessionDir, { recursive: true });

    const args = piArgs(sessionDir, config);
    const consumerOptions: PiRpcOptions<Output> =
      config.schema === undefined ? {} : { schema: config.schema };

    await runSubprocessConversation({
      backend: "pi",
      command,
      args,
      conversation,
      setProcess,
      stdin: "pipe",
      closeOnComplete: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      onStart: (process) => {
        process.write?.(`${piPromptCommand(composePrompt(request.prompt, config))}\n`);
        // Pi rpc keeps reading stdin for the next command; leave it open and let
        // `closeOnComplete` kill the process once `agent_end` settles the turn.
      },
      createConsumer: () => createPiRpcConsumer(conversation, piSessionId, consumerOptions)
    });
  } catch (error) {
    if (!conversation.signal.aborted) {
      conversation.fail(backendFailed("pi", errorMessage(error)));
    }
  }
}

function resolvePiConfig<Output>(
  request: AutonomousRequest<Output, "pi">,
  options: PiBackendOptions
): ResolvedPiConfig<Output> {
  const config: ResolvedPiConfig<Output> = {};
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

function setValue<Output, Key extends keyof ResolvedPiConfig<Output>>(
  config: ResolvedPiConfig<Output>,
  key: Key,
  value: ResolvedPiConfig<Output>[Key]
): void {
  if (value !== undefined) {
    config[key] = value;
  }
}

function composePrompt<Output>(prompt: string, config: ResolvedPiConfig<Output>): string {
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

export function pi(options: PiBackendOptions = {}): LlmBackend<"pi"> {
  return {
    tag: "pi",
    autonomous<Output = unknown>(request: AutonomousRequest<Output, "pi">) {
      let child: PiProcess | undefined;
      const conversation = new StreamConversation({
        backend: "pi",
        capacity: options.capacity ?? 256,
        canAskUser: false,
        onCancel: () => {
          child?.kill("SIGTERM");
        }
      });

      queueMicrotask(() => {
        void runPiConversation(request, options, conversation, (process) => {
          child = process;
        });
      });

      return conversation;
    }
  };
}
