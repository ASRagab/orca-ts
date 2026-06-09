import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
  codexExecJsonlArgs,
  createCodexJsonlConsumer,
  type CodexExecArgs
} from "./codex-jsonl.ts";
import {
  errorMessage,
  runSubprocessConversation,
  type SubprocessProcess,
  type SubprocessSpawner
} from "./subprocess-run.ts";
import type { AutonomousRequest } from "./types.ts";
import {
  createAskUserMcpServer,
  type AskUserMcpServer,
  type AskUserMcpServerOptions,
  type AskUserResponder,
  type StreamConversation
} from "../conversation/index.ts";
import {
  backendFailed,
  jsonSchemaFromZod,
  type BackendApprovalPolicy,
  type BackendConfig,
  type BackendSandboxMode
} from "../model/index.ts";

export interface CodexBackendOptions
  extends Omit<CodexExecArgs, "prompt" | "outputSchemaPath" | "resumeSessionId" | "mcpServerUrl"> {
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly capacity?: number;
  readonly spawnProcess?: CodexProcessSpawner;
  readonly config?: BackendConfig<"codex">;
  readonly askUser?: AskUserResponder;
  readonly createAskUserServer?: (options: AskUserMcpServerOptions) => AskUserMcpServer;
}

/** Codex's subprocess handle is the shared {@link SubprocessProcess}; the alias
 * is kept for the public API (tests and flow code import `CodexProcess`). */
export type CodexProcess = SubprocessProcess;

export type CodexProcessSpawner = SubprocessSpawner;

interface ResolvedCodexConfig<Output> {
  model?: string;
  systemPrompt?: string;
  approvalPolicy?: BackendApprovalPolicy;
  sandbox?: BackendSandboxMode;
  readOnly?: boolean;
  selfManagedGit?: boolean;
  retryAttempts?: number;
  schema?: z.ZodType<Output>;
  outputSchemaPath?: string;
  resumeSessionId?: string;
  interactive?: boolean;
  mcpServerUrl?: string;
}

export async function runCodexConversation<Output>(
  request: AutonomousRequest<Output, "codex">,
  options: CodexBackendOptions,
  conversation: StreamConversation<"codex">,
  setProcess: (process: CodexProcess) => void
): Promise<void> {
  const command = options.command ?? "codex";
  const config = resolveCodexConfig(request, options);
  let schemaDir: string | undefined;
  let askUserServer: AskUserMcpServer | undefined;

  try {
    if (config.interactive) {
      askUserServer = (options.createAskUserServer ?? createAskUserMcpServer)({
        responder:
          options.askUser ??
          (() => {
            throw new Error("interactive ask_user responder is not configured");
          })
      });
      config.mcpServerUrl = askUserServer.url;
    }

    if (config.schema) {
      schemaDir = await mkdtemp(join(tmpdir(), "orca-codex-schema-"));
      config.outputSchemaPath = join(schemaDir, "output-schema.json");
      await writeFile(
        config.outputSchemaPath,
        `${JSON.stringify(jsonSchemaFromZod(config.schema), null, 2)}\n`
      );
    }

    const args = codexExecJsonlArgs({
      prompt: composePrompt(request.prompt, config),
      ...(config.model === undefined ? {} : { model: config.model }),
      ...(config.approvalPolicy === undefined ? {} : { approvalPolicy: config.approvalPolicy }),
      ...(config.sandbox === undefined ? {} : { sandbox: config.sandbox }),
      ...(config.readOnly === undefined ? {} : { readOnly: config.readOnly }),
      ...(config.outputSchemaPath === undefined ? {} : { outputSchemaPath: config.outputSchemaPath }),
      ...(config.resumeSessionId === undefined ? {} : { resumeSessionId: config.resumeSessionId }),
      ...(config.mcpServerUrl === undefined ? {} : { mcpServerUrl: config.mcpServerUrl })
    });

    await runSubprocessConversation({
      backend: "codex",
      command,
      args,
      conversation,
      setProcess,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      createConsumer: () =>
        createCodexJsonlConsumer(conversation, {
          ...(config.schema === undefined ? {} : { schema: config.schema }),
          // The answer is routed by the MCP HTTP bridge (askUserServer), not the
          // consumer; the consumer only surfaces the question for the renderer.
          ...(config.interactive ? { interactive: true } : {})
        })
    });
  } catch (error) {
    if (!conversation.signal.aborted) {
      conversation.fail(backendFailed("codex", errorMessage(error)));
    }
  } finally {
    await askUserServer?.close();
    if (schemaDir) {
      await rm(schemaDir, { recursive: true, force: true });
    }
  }
}

function resolveCodexConfig<Output>(
  request: AutonomousRequest<Output, "codex">,
  options: CodexBackendOptions
): ResolvedCodexConfig<Output> {
  const config: ResolvedCodexConfig<Output> = {};
  const optionConfig = options.config;
  const requestConfig = request.config;

  setConfigValue(config, "model", requestConfig?.model ?? optionConfig?.model ?? options.model);
  setConfigValue(config, "systemPrompt", requestConfig?.systemPrompt ?? optionConfig?.systemPrompt);
  setConfigValue(
    config,
    "approvalPolicy",
    requestConfig?.approvalPolicy ?? optionConfig?.approvalPolicy ?? options.approvalPolicy
  );
  setConfigValue(config, "sandbox", requestConfig?.sandbox ?? optionConfig?.sandbox ?? options.sandbox);
  setConfigValue(config, "readOnly", requestConfig?.readOnly ?? optionConfig?.readOnly ?? options.readOnly);
  setConfigValue(
    config,
    "selfManagedGit",
    requestConfig?.selfManagedGit ?? optionConfig?.selfManagedGit
  );
  setConfigValue(config, "retryAttempts", requestConfig?.retry?.attempts ?? optionConfig?.retry?.attempts);
  setConfigValue(
    config,
    "schema",
    requestConfig?.structuredOutput?.schema ??
      request.schema ??
      (optionConfig?.structuredOutput?.schema as z.ZodType<Output> | undefined)
  );
  setConfigValue(
    config,
    "resumeSessionId",
    requestConfig?.resumeSessionId === undefined ? undefined : String(requestConfig.resumeSessionId)
  );
  setConfigValue(config, "interactive", requestConfig?.interactive ?? optionConfig?.interactive);

  return config;
}

function setConfigValue<Output, Key extends keyof ResolvedCodexConfig<Output>>(
  config: ResolvedCodexConfig<Output>,
  key: Key,
  value: ResolvedCodexConfig<Output>[Key]
): void {
  if (value !== undefined) {
    config[key] = value;
  }
}

function composePrompt<Output>(prompt: string, config: ResolvedCodexConfig<Output>): string {
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
