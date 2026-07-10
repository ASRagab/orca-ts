import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Backend = "claude" | "codex";
type Transport = "current" | "acp";
type Scenario = "handshake" | "success" | "structured" | "failure" | "cancel";

interface CaptureOptions {
  backend: Backend;
  transport: Transport;
  scenario: Scenario;
  outDir: string;
}

interface CaptureEvent {
  atMs: number;
  direction: "stdin" | "stdout" | "stderr";
  payload: unknown;
}

interface ChildResult {
  exitCode: number | null;
  events: CaptureEvent[];
  wallTimeMs: number;
}

const liveScenarios = new Set<Scenario>(["success", "structured", "cancel"]);

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (liveScenarios.has(options.scenario) && process.env.ORCA_ACP_CAPTURE_LIVE !== "1") {
    throw new Error(
      `scenario ${options.scenario} can call a live model; set ORCA_ACP_CAPTURE_LIVE=1 to run it`
    );
  }

  const repo = await createDisposableRepo();
  try {
    const result =
      options.transport === "current"
        ? await captureCurrent(options, repo)
        : await captureAcp(options, repo);
    await writeCapture(options, repo, result);
    console.log(
      JSON.stringify({
        backend: options.backend,
        transport: options.transport,
        scenario: options.scenario,
        outDir: options.outDir,
        wallTimeMs: result.wallTimeMs,
        eventCount: result.events.length,
        exitCode: result.exitCode
      })
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

function parseArgs(args: string[]): CaptureOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("usage: bun run scripts/capture-acp-transcripts.ts --backend claude|codex --transport current|acp --scenario handshake|success|structured|failure|cancel --out-dir PATH");
    }
    values.set(key.slice(2), value);
  }

  const backend = parseChoice(values.get("backend"), ["claude", "codex"], "backend");
  const transport = parseChoice(values.get("transport"), ["current", "acp"], "transport");
  const scenario = parseChoice(
    values.get("scenario"),
    ["handshake", "success", "structured", "failure", "cancel"],
    "scenario"
  );
  if (transport === "current" && scenario === "handshake") {
    throw new Error("handshake scenario is ACP-only");
  }
  return {
    backend,
    transport,
    scenario,
    outDir: resolve(values.get("out-dir") ?? join("openspec", "changes", "spike-acp-claude-codex-backends", "transcripts", `${backend}-${transport}-${scenario}`))
  };
}

function parseChoice<T extends string>(value: string | undefined, choices: readonly T[], name: string): T {
  if (value !== undefined && choices.includes(value as T)) {
    return value as T;
  }
  throw new Error(`${name} must be one of ${choices.join("|")}`);
}

async function createDisposableRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "orca-acp-capture-"));
  await writeFile(join(repo, "package.json"), "{\"name\":\"orca-acp-capture\",\"private\":true}\n");
  await writeFile(join(repo, "README.md"), "# ACP capture fixture\n");
  runGit(repo, ["init"]);
  runGit(repo, ["config", "user.email", "orca-capture@example.invalid"]);
  runGit(repo, ["config", "user.name", "Orca Capture"]);
  runGit(repo, ["add", "package.json", "README.md"]);
  runGit(repo, ["commit", "-m", "init"]);
  return repo;
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function captureCurrent(options: CaptureOptions, cwd: string): Promise<ChildResult> {
  const startedAt = Date.now();
  const events: CaptureEvent[] = [];
  const prompt = promptFor(options.scenario);
  const command = options.backend;
  const args = currentArgs(options, prompt);
  const child = spawn(command, args, {
    cwd,
    stdio: [options.backend === "claude" ? "pipe" : "ignore", "pipe", "pipe"]
  });
  if (child.stdout === null || child.stderr === null) {
    throw new Error(`failed to capture stdio for ${command}`);
  }
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  collectText(child.stdout, "stdout", startedAt, events);
  collectText(child.stderr, "stderr", startedAt, events);

  if (options.backend === "claude" && options.scenario !== "failure") {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] }
    });
    events.push({ atMs: Date.now() - startedAt, direction: "stdin", payload: line });
    child.stdin?.end(`${line}\n`);
  } else {
    child.stdin?.end();
  }

  if (options.scenario === "cancel") {
    setTimeout(() => child.kill("SIGTERM"), 1_500);
  }

  const exitCode = await waitForExit(child);
  return { exitCode, events, wallTimeMs: Date.now() - startedAt };
}

function currentArgs(options: CaptureOptions, prompt: string): string[] {
  if (options.scenario === "failure") {
    return ["--orca-invalid-flag"];
  }
  if (options.backend === "codex") {
    const args = [
      "exec",
      "--json",
      "--ignore-user-config",
      "-c",
      "approval_policy=\"never\"",
      "--sandbox",
      "read-only"
    ];
    if (options.scenario === "structured") {
      args.push("--output-schema", writeInlineSchema());
    }
    args.push(prompt);
    return args;
  }
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "plan"
  ];
  if (options.scenario === "structured") {
    args.push("--json-schema", JSON.stringify({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }));
  }
  return args;
}

function writeInlineSchema(): string {
  const path = join(tmpdir(), `orca-acp-schema-${String(process.pid)}.json`);
  writeFileSync(path, JSON.stringify({ type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }));
  return path;
}

async function captureAcp(options: CaptureOptions, cwd: string): Promise<ChildResult> {
  const startedAt = Date.now();
  const events: CaptureEvent[] = [];
  const child = spawnAcp(options.backend, cwd);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let nextId = 0;
  let buffer = "";

  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      events.push({ atMs: Date.now() - startedAt, direction: "stdout", payload: message });
      void handleAcpMessage(message, pending, child, cwd, startedAt, events);
    }
  });
  collectText(child.stderr, "stderr", startedAt, events);

  const send = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId;
    nextId += 1;
    const message = { jsonrpc: "2.0", id, method, params };
    events.push({ atMs: Date.now() - startedAt, direction: "stdin", payload: message });
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolveResponse) => {
      pending.set(id, resolveResponse);
    });
  };
  const notify = (method: string, params: Record<string, unknown>): void => {
    const message = { jsonrpc: "2.0", method, params };
    events.push({ atMs: Date.now() - startedAt, direction: "stdin", payload: message });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true }, terminal: false },
    clientInfo: { name: "orca-ts-acp-spike", title: "Orca TS ACP Spike", version: "0.0.0" }
  });
  const session = await send("session/new", { cwd, mcpServers: [] });
  const sessionId = (session.result as { sessionId?: string } | undefined)?.sessionId ?? "";

  if (options.scenario !== "handshake") {
    const promptPromise = send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: promptFor(options.scenario) }]
    });
    if (options.scenario === "cancel") {
      setTimeout(() => {
        notify("session/cancel", { sessionId });
      }, 1_500);
    }
    await promptPromise;
  }

  child.stdin.end();
  child.kill("SIGTERM");
  const exitCode = await waitForExit(child);
  return { exitCode, events, wallTimeMs: Date.now() - startedAt };
}

function spawnAcp(backend: Backend, cwd: string) {
  if (backend === "claude") {
    return spawn("claude-agent-acp", [], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  }
  return spawn(
    "npx",
    [
      "--prefer-offline=false",
      "--prefer-online=true",
      "-y",
      "@agentclientprotocol/codex-acp@1.1.0"
    ],
    { cwd, stdio: ["pipe", "pipe", "pipe"] }
  );
}

async function handleAcpMessage(
  message: Record<string, unknown>,
  pending: Map<number, (message: Record<string, unknown>) => void>,
  child: ReturnType<typeof spawn>,
  cwd: string,
  startedAt: number,
  events: CaptureEvent[]
): Promise<void> {
  const id = message.id;
  if (typeof id === "number" && (message.result !== undefined || message.error !== undefined)) {
    pending.get(id)?.(message);
    pending.delete(id);
    return;
  }
  if (typeof id !== "number" || typeof message.method !== "string") {
    return;
  }
  if (child.stdin === null) {
    throw new Error("ACP process stdin is unavailable");
  }
  const response = await responseForClientRequest(id, message.method, message.params, cwd);
  events.push({ atMs: Date.now() - startedAt, direction: "stdin", payload: response });
  child.stdin.write(`${JSON.stringify(response)}\n`);
}

async function responseForClientRequest(
  id: number,
  method: string,
  params: unknown,
  cwd: string
): Promise<Record<string, unknown>> {
  if (method === "fs/read_text_file") {
    try {
      const pathOrUri = pathOrUriFromParams(params);
      if (pathOrUri === undefined) throw new Error("missing path");
      const path = await resolveCapturePath(cwd, pathOrUri);
      return { jsonrpc: "2.0", id, result: { content: await readFile(path, "utf8") } };
    } catch (error) {
      return rpcError(id, -32000, error instanceof Error ? error.message : String(error));
    }
  }
  if (method === "session/request_permission") {
    return { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } };
  }
  return rpcError(id, -32601, `unsupported client request ${method}`);
}

function pathOrUriFromParams(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const path = (params as { path?: unknown }).path;
  if (typeof path === "string") {
    return path;
  }
  const uri = (params as { uri?: unknown }).uri;
  return typeof uri === "string" ? uri : undefined;
}

async function resolveCapturePath(cwd: string, pathOrUri: string): Promise<string> {
  const root = await realpath(cwd);
  const path = pathOrUri.startsWith("file://")
    ? resolve(fileURLToPath(pathOrUri))
    : resolve(cwd, pathOrUri);
  const target = await realpath(path);
  const fromRoot = relative(root, target);
  if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
    throw new Error("path outside capture repo");
  }
  return target;
}

function rpcError(id: number, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function promptFor(scenario: Scenario): string {
  if (scenario === "structured") {
    return "Inspect this tiny repository without modifying files. Return JSON only: {\"answer\":\"package.json exists\"}.";
  }
  if (scenario === "cancel") {
    return "Inspect this tiny repository without modifying files, then wait briefly before answering.";
  }
  if (scenario === "failure") {
    return "This prompt is unused for deterministic failure capture.";
  }
  return "Inspect this tiny repository without modifying files. Return one short sentence that includes package.json.";
}

function collectText(
  stream: NodeJS.ReadableStream,
  direction: "stdout" | "stderr",
  startedAt: number,
  events: CaptureEvent[]
): void {
  stream.on("data", (chunk: string | Buffer) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split(/\n/)) {
      if (line.length > 0) {
        events.push({ atMs: Date.now() - startedAt, direction, payload: line });
      }
    }
  });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return await new Promise((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", resolveExit);
  });
}

async function writeCapture(options: CaptureOptions, repo: string, result: ChildResult): Promise<void> {
  await mkdir(options.outDir, { recursive: true });
  const versions = await versionMetadata(options);
  await writeFile(
    join(options.outDir, "metadata.json"),
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        backend: options.backend,
        transport: options.transport,
        scenario: options.scenario,
        prompt: options.scenario === "handshake" ? null : promptFor(options.scenario),
        repoFixture: repo,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        versions,
        wallTimeMs: result.wallTimeMs,
        exitCode: result.exitCode,
        eventCount: result.events.length,
        live: liveScenarios.has(options.scenario)
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(options.outDir, "transcript.jsonl"),
    result.events.map((event) => JSON.stringify(event)).join("\n") + "\n"
  );
}

async function versionMetadata(options: CaptureOptions): Promise<Record<string, string | null>> {
  if (options.backend === "claude") {
    return {
      claude: await commandOutput("claude", ["--version"]),
      "claude-agent-acp":
        options.transport === "acp" ? await commandOutput("claude-agent-acp", ["--version"]) : null
    };
  }
  return {
    codex: await commandOutput("codex", ["--version"]),
    "codex-acp":
      options.transport === "acp"
        ? await commandOutput("npx", [
            "--prefer-offline=false",
            "--prefer-online=true",
            "-y",
            "@agentclientprotocol/codex-acp@1.1.0",
            "--version"
          ])
        : null
  };
}

async function commandOutput(command: string, args: readonly string[]): Promise<string | null> {
  const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
  const exitCode = await waitForExit(child);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return exitCode === 0 ? text : text || null;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
