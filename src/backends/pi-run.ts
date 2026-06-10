import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { composeBackendPrompt } from "./conversation-config.ts";
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
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      onStart: (process) => {
        process.write?.(`${piPromptCommand(composeBackendPrompt(request.prompt, config))}\n`);
        // Pi rpc keeps reading stdin for the next command; leave it open. The
        // shared helper kills the process once `agent_end` settles the turn.
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
  const optionConfig = options.config;
  const requestConfig = request.config;
  const config: ResolvedPiConfig<Output> = {};
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
