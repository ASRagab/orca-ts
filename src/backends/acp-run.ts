import type { z } from "zod";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAcpClient,
  type AcpClient,
  type AcpProcess,
  type AcpProcessSpawner,
  type AcpRequestMessage
} from "./acp-client.ts";
import { composeBackendPrompt, type SharedBackendConfig } from "./conversation-config.ts";
import type { AutonomousRequest } from "./types.ts";
import type { StreamConversation } from "../conversation/index.ts";
import {
  backendFailed,
  jsonSchemaFromZod,
  parseStructuredOutput,
  sessionId,
  structuredOutputValidationFailed,
  type BackendTag,
  type Usage
} from "../model/index.ts";

const DefaultAcpInactivityTimeoutMs = 120_000;

export interface AcpBackendRuntimeOptions<B extends BackendTag, Output = unknown> {
  readonly backend: B;
  readonly command: string;
  readonly args?: readonly string[];
  readonly config?: SharedBackendConfig<Output>;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnProcess?: AcpProcessSpawner;
  readonly setProcess: (process: AcpProcess) => void;
  readonly setCancel: (cancel: () => Promise<void>) => void;
  readonly cancelTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly inactivityTimeoutMs?: number;
}

export function experimentalAcpBackendEnabled(backend: "claude" | "codex"): boolean {
  const value = process.env.ORCA_EXPERIMENTAL_ACP_BACKENDS;
  if (value === undefined) {
    return false;
  }
  return value === "1" || value.split(",").map((item) => item.trim()).includes(backend);
}

export function claudeAcpCommand(): { readonly command: string; readonly args: readonly string[] } {
  return { command: process.env.ORCA_CLAUDE_ACP_COMMAND ?? "claude-agent-acp", args: [] };
}

export function codexAcpCommand(): { readonly command: string; readonly args: readonly string[] } {
  const command = process.env.ORCA_CODEX_ACP_COMMAND;
  if (command !== undefined) {
    return { command, args: [] };
  }
  return {
    command: "npx",
    args: [
      "--prefer-offline=false",
      "--prefer-online=true",
      "-y",
      "@agentclientprotocol/codex-acp@1.1.0"
    ]
  };
}

interface AcpSessionResponse {
  readonly sessionId?: string;
  readonly configOptions?: unknown;
  readonly modes?: unknown;
}

interface AcpPromptResponse {
  readonly stopReason?: string;
  readonly usage?: unknown;
}

export async function runAcpConversation<Output, B extends "claude" | "codex">(
  request: AutonomousRequest<Output, B>,
  options: AcpBackendRuntimeOptions<B, Output>,
  conversation: StreamConversation<B>
): Promise<void> {
  let client: AcpClient | undefined;
  let activeSessionId = "";
  let activePrompt: Promise<AcpPromptResponse> | undefined;
  let output = "";
  const sessionCwd = options.cwd ?? process.cwd();
  let markPromptActivity = (): void => {};

  try {
    client = await runAcpPhase(options.backend, "initialization", async () => createAcpClient({
      command: options.command,
      args: options.args ?? [],
      cwd: sessionCwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      requestTimeoutMs: options.requestTimeoutMs ?? 600_000,
      handleRequest: (message) => handleClientRequest(message, sessionCwd, options.config?.readOnly === true),
      onIncomingMessage: () => {
        markPromptActivity();
      }
    }));
    options.setProcess(client.process);
    const acpClient = client;
    options.setCancel(() => cancelAcpTurn(acpClient, activeSessionId, activePrompt, options.cancelTimeoutMs));
    const done = acpClient.done.then(
      () => ({ type: "success" as const }),
      (error) => ({ type: "failed" as const, error })
    );

    const updates = consumeAcpMessages(
      acpClient,
      conversation,
      (text) => {
        output += text;
      },
      () => {
        markPromptActivity();
      }
    );

    await runAcpPhase(options.backend, "initialization", () => acpClient.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: options.config?.readOnly === true ? false : true
        },
        terminal: false
      },
      clientInfo: { name: "orcats", title: "Orcats", version: "0.0.0" }
    }));

    const session = await runAcpPhase(options.backend, "session creation", () => acpClient.request<AcpSessionResponse>("session/new", {
      cwd: sessionCwd,
      mcpServers: []
    }));
    activeSessionId = session.sessionId ?? "";
    await runAcpPhase(options.backend, "session mode configuration", () =>
      configureAcpMode(acpClient, activeSessionId, session, options.config)
    );

    const watchdog = createAcpTurnWatchdog(
      acpClient,
      options.requestTimeoutMs ?? 600_000,
      options.inactivityTimeoutMs ?? DefaultAcpInactivityTimeoutMs
    );
    markPromptActivity = watchdog.markActivity;
    activePrompt = runAcpPhase(options.backend, "prompt execution", () => Promise.race([
      acpClient.request<AcpPromptResponse>("session/prompt", {
      sessionId: activeSessionId,
      prompt: [{ type: "text", text: composeAcpPrompt(request.prompt, options.config) }]
      }),
      watchdog.done
    ]));
    let promptResult: AcpPromptResponse;
    try {
      promptResult = await activePrompt;
    } finally {
      watchdog.stop();
    }

    if (conversation.signal.aborted) {
      return;
    }
    await runAcpPhase(options.backend, "shutdown", () =>
      shutdownAcpClient(acpClient, updates, done, options.shutdownTimeoutMs)
    );

    if (promptResult.stopReason !== undefined && promptResult.stopReason !== "end_turn") {
      conversation.fail(
        backendFailed(
          options.backend,
          `${backendLabel(options.backend)} ACP prompt stopped with ${promptResult.stopReason}`
        )
      );
      return;
    }

    await conversation.emit({ type: "assistant_turn_end" });

    const structured = parseAcpStructuredOutput(options.config?.schema ?? request.schema, output);
    if (structured.type === "failed") {
      conversation.fail(structured.error);
      return;
    }

    const usage = normalizeAcpUsage(promptResult.usage);
    conversation.succeed({
      backend: options.backend,
      sessionId: sessionId(options.backend, activeSessionId),
      output,
      ...(structured.value === undefined ? {} : { structured: structured.value }),
      ...(usage === undefined ? {} : { usage })
    });
  } catch (error) {
    if (!conversation.signal.aborted) {
      conversation.fail(backendFailed(options.backend, errorMessage(error)));
    }
  } finally {
    client?.close();
  }
}

function composeAcpPrompt(prompt: string, config: SharedBackendConfig<unknown> | undefined): string {
  const composed = composeBackendPrompt(prompt, config ?? {});
  if (config?.schema === undefined) {
    return composed;
  }
  return [
    composed,
    "Return only JSON matching this JSON Schema:",
    JSON.stringify(jsonSchemaFromZod(config.schema))
  ].join("\n\n");
}

async function configureAcpMode(
  client: AcpClient,
  sessionIdValue: string,
  session: AcpSessionResponse,
  config: SharedBackendConfig<unknown> | undefined
): Promise<void> {
  const targetMode = selectAcpMode(session, config?.readOnly === true);
  if (targetMode === undefined) {
    return;
  }
  await client.request("session/set_config_option", {
    sessionId: sessionIdValue,
    configId: "mode",
    value: targetMode
  });
}

function selectAcpMode(session: AcpSessionResponse, readOnly: boolean): string | undefined {
  const advertisedModes = acpModeIds(session);
  const preferences = readOnly
    ? ["plan", "read-only", "readOnly"]
    : ["bypassPermissions", "dontAsk", "agent", "default"];
  return preferences.find((mode) => advertisedModes.has(mode));
}

function acpModeIds(session: AcpSessionResponse): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(session.configOptions)) {
    const modeOption = session.configOptions.find(
      (option): option is Record<string, unknown> => isObject(option) && option.id === "mode"
    );
    const options = isObject(modeOption) ? modeOption.options : undefined;
    if (Array.isArray(options)) {
      for (const option of options) {
        if (isObject(option) && typeof option.value === "string") {
          ids.add(option.value);
        }
      }
    }
  }
  if (isObject(session.modes) && Array.isArray(session.modes.availableModes)) {
    for (const mode of session.modes.availableModes) {
      if (isObject(mode) && typeof mode.id === "string") {
        ids.add(mode.id);
      }
    }
  }
  return ids;
}

async function consumeAcpMessages<B extends "claude" | "codex">(
  client: AcpClient,
  conversation: StreamConversation<B>,
  appendOutput: (text: string) => void,
  onActivity: () => void
): Promise<void> {
  for await (const message of client.messages()) {
    if (!("method" in message) || message.method !== "session/update") {
      continue;
    }
    onActivity();
    const update = readUpdate(message.params);
    if (update === undefined) {
      continue;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = textFromContent(update.content);
      if (text.length > 0) {
        appendOutput(text);
        await emitIfOpen(conversation, { type: "assistant_text_delta", text });
      }
      continue;
    }
    if (update.sessionUpdate === "tool_call") {
      await emitIfOpen(conversation, {
        type: "assistant_tool_call",
        id: stringField(update, "toolCallId"),
        name: stringField(update, "title") || stringField(update, "kind") || "tool_call",
        input: update.rawInput ?? {}
      });
      continue;
    }
    if (update.sessionUpdate === "tool_call_update" && update.status === "completed") {
      await emitIfOpen(conversation, {
        type: "tool_result",
        toolCallId: stringField(update, "toolCallId"),
        output: update.content ?? update.rawOutput ?? ""
      });
    }
  }
}

async function emitIfOpen<B extends "claude" | "codex">(
  conversation: StreamConversation<B>,
  event: Parameters<StreamConversation<B>["emit"]>[0]
): Promise<void> {
  try {
    await conversation.emit(event);
  } catch (error) {
    if (errorMessage(error) !== "Queue is closed") {
      throw error;
    }
  }
}

interface AcpTurnWatchdog {
  readonly done: Promise<never>;
  markActivity(): void;
  stop(): void;
}

function createAcpTurnWatchdog(
  client: AcpClient,
  wallClockTimeoutMs: number,
  inactivityTimeoutMs: number | undefined
): AcpTurnWatchdog {
  let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectWatchdog: (error: Error) => void = () => {};

  const done = new Promise<never>((_resolve, reject) => {
    rejectWatchdog = reject;
    wallClockTimer = setTimeout(() => {
      reject(new Error(`turn exceeded ${String(wallClockTimeoutMs)}ms wall-clock limit`));
      client.close("SIGKILL", true);
    }, wallClockTimeoutMs);
  });

  const resetInactivity = (): void => {
    if (inactivityTimeoutMs === undefined) {
      return;
    }
    if (inactivityTimer !== undefined) {
      clearTimeout(inactivityTimer);
    }
    inactivityTimer = setTimeout(() => {
      rejectWatchdog(new Error(`emitted no session updates for ${String(inactivityTimeoutMs)}ms`));
      client.close("SIGKILL", true);
    }, inactivityTimeoutMs);
  };

  resetInactivity();

  return {
    done,
    markActivity: resetInactivity,
    stop() {
      if (wallClockTimer !== undefined) {
        clearTimeout(wallClockTimer);
      }
      if (inactivityTimer !== undefined) {
        clearTimeout(inactivityTimer);
      }
    }
  };
}

async function shutdownAcpClient(
  client: AcpClient,
  updates: Promise<void>,
  done: Promise<{ readonly type: "success" } | { readonly type: "failed"; readonly error: unknown }>,
  timeoutMs = 2_000
): Promise<void> {
  client.close("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.all([updates, done]).then(([, doneResult]) => {
    if (doneResult.type === "failed") {
      throw doneResult.error;
    }
  });
  const timeoutReached = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      client.close("SIGKILL", true);
      reject(new Error(`ACP shutdown timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([settled, timeoutReached]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
  await settled;
}

async function cancelAcpTurn(
  client: AcpClient,
  sessionIdValue: string,
  activePrompt: Promise<unknown> | undefined,
  timeoutMs = 2_000
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (sessionIdValue.length > 0) {
      client.notify("session/cancel", { sessionId: sessionIdValue });
    }
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        client.close("SIGKILL", true);
        resolve();
      }, timeoutMs);
    });
    await Promise.race([activePrompt?.catch(() => undefined) ?? Promise.resolve(), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    client.close("SIGTERM");
    await waitForAcpExit(client, timeoutMs);
  }
}

async function waitForAcpExit(client: AcpClient, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forceClose = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      client.close("SIGKILL", true);
      resolve();
    }, timeoutMs);
  });
  try {
    await Promise.race([client.done.catch(() => undefined), forceClose]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function handleClientRequest(
  message: AcpRequestMessage,
  cwd: string,
  readOnly: boolean
): Promise<unknown> {
  if (message.method === "fs/read_text_file") {
    const pathOrUri = pathOrUriFromParams(message.params);
    if (pathOrUri === undefined) {
      throw new Error("missing path");
    }
    const path = await resolveContainedPath(cwd, pathOrUri, "read");
    return { content: await readFile(path, "utf8") };
  }
  if (message.method === "fs/write_text_file") {
    if (readOnly) {
      throw new Error("write request rejected in read-only mode");
    }
    const pathOrUri = pathOrUriFromParams(message.params);
    const content = isObject(message.params) ? message.params.content : undefined;
    if (pathOrUri === undefined || typeof content !== "string") {
      throw new Error("missing write payload");
    }
    const path = await resolveContainedPath(cwd, pathOrUri, "write");
    await writeFile(path, content);
    return {};
  }
  if (message.method === "session/request_permission") {
    return { outcome: { outcome: "cancelled" } };
  }
  throw new Error(`unsupported ACP client request ${message.method}`);
}

function pathOrUriFromParams(params: unknown): string | undefined {
  if (!isObject(params)) {
    return undefined;
  }
  if (typeof params.path === "string") {
    return params.path;
  }
  return typeof params.uri === "string" ? params.uri : undefined;
}

async function resolveContainedPath(cwd: string, pathOrUri: string, mode: "read" | "write"): Promise<string> {
  const root = await realpath(cwd);
  const path = pathOrUri.startsWith("file://")
    ? resolve(fileURLToPath(pathOrUri))
    : resolve(cwd, pathOrUri);
  const target = mode === "read" ? await realpath(path) : await resolveWritablePath(path);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === ".." || pathFromRoot.startsWith("../") || isAbsolute(pathFromRoot)) {
    throw new Error("path outside backend cwd");
  }
  return target;
}

async function resolveWritablePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(await realpath(dirname(path)), basename(path));
  }
}

function readUpdate(params: unknown): Record<string, unknown> | undefined {
  if (!isObject(params) || !isObject(params.update)) {
    return undefined;
  }
  return params.update;
}

function textFromContent(content: unknown): string {
  if (isObject(content) && content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function parseAcpStructuredOutput<Output>(
  schema: z.ZodType<Output> | undefined,
  output: string
):
  | { readonly type: "success"; readonly value?: Output }
  | { readonly type: "failed"; readonly error: ReturnType<typeof structuredOutputValidationFailed> } {
  if (!schema) {
    return { type: "success" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(jsonCandidate(output)) as unknown;
  } catch {
    return {
      type: "failed",
      error: structuredOutputValidationFailed({
        raw: output,
        issues: ["ACP structured output was not valid JSON"]
      })
    };
  }
  const parsed = parseStructuredOutput(schema, raw);
  if (parsed.isErr()) {
    return { type: "failed", error: parsed.error };
  }
  return { type: "success", value: parsed.value.value };
}

function normalizeAcpUsage(usage: unknown): Usage | undefined {
  if (!isObject(usage)) {
    return undefined;
  }
  const input = numberField(usage, "inputTokens") ?? numberField(usage, "input_tokens");
  const cached =
    numberField(usage, "cachedInputTokens") ??
    numberField(usage, "cacheCreationInputTokens") ??
    numberField(usage, "cacheReadInputTokens") ??
    numberField(usage, "cached_input_tokens") ??
    0;
  const output = numberField(usage, "outputTokens") ?? numberField(usage, "output_tokens");
  const total = numberField(usage, "totalTokens") ?? numberField(usage, "total_tokens");
  if ((input === undefined && total === undefined) || output === undefined) {
    return undefined;
  }
  const normalizedInput = input ?? Math.max((total ?? 0) - output, 0);
  const reasoning =
    numberField(usage, "reasoningOutputTokens") ??
    numberField(usage, "reasoning_output_tokens") ??
    numberField(usage, "thoughtTokens") ??
    numberField(usage, "thought_tokens");
  return {
    input: normalizedInput + cached,
    output,
    ...(reasoning === undefined ? {} : { reasoning })
  };
}

function jsonCandidate(output: string): string {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const startCandidates = [objectStart, arrayStart].filter((index) => index >= 0);
  if (startCandidates.length === 0) {
    return trimmed;
  }
  const start = Math.min(...startCandidates);
  return trimmed.slice(start);
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
}

async function runAcpPhase<T>(
  backend: "claude" | "codex",
  phase: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${backendLabel(backend)} ACP ${phase} failed: ${errorMessage(error)}`);
  }
}

function backendLabel(backend: "claude" | "codex"): string {
  return backend === "claude" ? "Claude" : "Codex";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
