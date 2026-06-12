import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
  codexExecJsonlArgs,
  createCodexJsonlConsumer,
  type CodexExecArgs
} from "./codex-jsonl.ts";
import { composeBackendPrompt } from "./conversation-config.ts";
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
  readonly inactivityTimeoutMs?: number;
  readonly wallClockTimeoutMs?: number;
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
      prompt: composeBackendPrompt(request.prompt, config),
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
      ...(options.inactivityTimeoutMs === undefined ? {} : { inactivityTimeoutMs: options.inactivityTimeoutMs }),
      ...(options.wallClockTimeoutMs === undefined ? {} : { wallClockTimeoutMs: options.wallClockTimeoutMs }),
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
  const optionConfig = options.config;
  const requestConfig = request.config;
  const config: ResolvedCodexConfig<Output> = {};
  const model = requestConfig?.model ?? optionConfig?.model ?? options.model;
  if (model !== undefined) config.model = model;
  const systemPrompt = requestConfig?.systemPrompt ?? optionConfig?.systemPrompt;
  if (systemPrompt !== undefined) config.systemPrompt = systemPrompt;
  const approvalPolicy =
    requestConfig?.approvalPolicy ?? optionConfig?.approvalPolicy ?? options.approvalPolicy;
  if (approvalPolicy !== undefined) config.approvalPolicy = approvalPolicy;
  const sandbox = requestConfig?.sandbox ?? optionConfig?.sandbox ?? options.sandbox;
  if (sandbox !== undefined) config.sandbox = sandbox;
  const readOnly = requestConfig?.readOnly ?? optionConfig?.readOnly ?? options.readOnly;
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
  const interactive = requestConfig?.interactive ?? optionConfig?.interactive;
  if (interactive !== undefined) config.interactive = interactive;
  return config;
}
