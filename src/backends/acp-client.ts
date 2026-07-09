import { spawn } from "node:child_process";
import { BoundedAsyncQueue } from "../conversation/index.ts";
import { collectText, splitLines } from "./subprocess-run.ts";

export type AcpId = number | string;

export interface AcpErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface AcpRequestMessage {
  readonly jsonrpc: "2.0";
  readonly id: AcpId;
  readonly method: string;
  readonly params?: unknown;
}

export interface AcpNotificationMessage {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface AcpResponseMessage {
  readonly jsonrpc: "2.0";
  readonly id: AcpId;
  readonly result?: unknown;
  readonly error?: AcpErrorPayload;
}

export type AcpIncomingMessage = AcpRequestMessage | AcpNotificationMessage;

export interface AcpProcess {
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr?: AsyncIterable<string | Uint8Array>;
  readonly exit: Promise<number | null>;
  write(data: string): void;
  endStdin(): void;
  kill(signal?: NodeJS.Signals): void;
}

export interface AcpSpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type AcpProcessSpawner = (
  command: string,
  args: readonly string[],
  options: AcpSpawnOptions
) => AcpProcess;

export type AcpRequestHandler = (message: AcpRequestMessage) => Promise<unknown> | unknown;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export interface AcpClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly capacity?: number;
  readonly requestTimeoutMs?: number;
  readonly spawnProcess?: AcpProcessSpawner;
  readonly handleRequest?: AcpRequestHandler;
  readonly onIncomingMessage?: () => void;
}

export class AcpClient {
  readonly process: AcpProcess;
  private readonly queue: BoundedAsyncQueue<AcpIncomingMessage>;
  private readonly pending = new Map<
    AcpId,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (reason: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly closedState: Deferred<void> = Promise.withResolvers<void>();
  private nextId = 0;
  private closed = false;

  readonly stderr: Promise<string>;
  readonly done: Promise<void>;

  constructor(private readonly options: AcpClientOptions) {
    const spawnProcess = options.spawnProcess ?? spawnAcpProcess;
    this.process = spawnProcess(options.command, options.args ?? [], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env })
    });
    this.queue = new BoundedAsyncQueue(options.capacity ?? 256);
    this.stderr = collectText(this.process.stderr);
    this.done = this.closedState.promise;
    queueMicrotask(() => {
      void this.readLoop();
    });
  }

  messages(): AsyncIterable<AcpIncomingMessage> {
    return this.queue;
  }

  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.closed) {
      throw new Error("ACP client is closed");
    }
    const id = this.nextId;
    this.nextId += 1;
    const message: AcpRequestMessage = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request ${method} timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    });
    this.write(message);
    return await response;
  }

  notify(method: string, params: unknown = {}): void {
    if (this.closed) {
      return;
    }
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(signal: NodeJS.Signals = "SIGTERM", force = false): void {
    if (this.closed) {
      if (force) {
        this.process.kill(signal);
      }
      return;
    }
    this.closed = true;
    this.process.endStdin();
    this.process.kill(signal);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("ACP client closed"));
    }
    this.pending.clear();
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const line of splitLines(this.process.stdout)) {
        if (line.trim().length === 0) {
          continue;
        }
        await this.route(parseAcpMessage(line));
      }
      const exitCode = await this.process.exit;
      if (!this.closed && exitCode !== 0) {
        throw new Error(`ACP process exited with code ${String(exitCode ?? "unknown")}`);
      }
      this.finish();
    } catch (error) {
      this.fail(error);
    }
  }

  private async route(message: AcpResponseMessage | AcpIncomingMessage): Promise<void> {
    this.options.onIncomingMessage?.();
    if (isResponse(message)) {
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`${message.error.message} (${String(message.error.code)})`));
        return;
      }
      entry.resolve(message.result);
      return;
    }

    if (isRequest(message)) {
      await this.respondToRequest(message);
      return;
    }

    await this.queue.push(message);
  }

  private async respondToRequest(message: AcpRequestMessage): Promise<void> {
    try {
      const result = await this.options.handleRequest?.(message);
      this.write({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: errorMessage(error) }
      });
    }
  }

  private finish(): void {
    if (this.closed) {
      this.queue.close();
      this.closedState.resolve();
      return;
    }
    this.closed = true;
    this.queue.close();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("ACP process exited"));
    }
    this.pending.clear();
    this.closedState.resolve();
  }

  private fail(error: unknown): void {
    if (this.closed) {
      this.queue.close();
      this.closedState.reject(error);
      return;
    }
    this.closed = true;
    this.queue.close();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.closedState.reject(error);
  }

  private write(message: AcpRequestMessage | AcpNotificationMessage | AcpResponseMessage): void {
    this.process.write(`${JSON.stringify(message)}\n`);
  }
}

export function createAcpClient(options: AcpClientOptions): AcpClient {
  return new AcpClient(options);
}

export function spawnAcpProcess(
  command: string,
  args: readonly string[],
  options: AcpSpawnOptions
): AcpProcess {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"]
  });

  if (!child.stdout || !child.stdin) {
    throw new Error(`failed to capture stdio for ${command}`);
  }

  const exit = Promise.withResolvers<number | null>();
  child.on("error", exit.reject);
  child.on("close", exit.resolve);

  return {
    stdout: child.stdout,
    ...(child.stderr ? { stderr: child.stderr } : {}),
    exit: exit.promise,
    write(data: string) {
      child.stdin?.write(data);
    },
    endStdin() {
      child.stdin?.end();
    },
    kill(signal?: NodeJS.Signals) {
      child.kill(signal);
    }
  };
}

function parseAcpMessage(line: string): AcpResponseMessage | AcpIncomingMessage {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`invalid ACP JSON-RPC message: ${errorMessage(error)}`);
  }
  if (!isObject(value) || value.jsonrpc !== "2.0") {
    throw new Error("invalid ACP JSON-RPC message");
  }
  if ("method" in value && typeof value.method === "string") {
    if ("id" in value) {
      return value as unknown as AcpRequestMessage;
    }
    return value as unknown as AcpNotificationMessage;
  }
  if ("id" in value && ("result" in value || "error" in value)) {
    return value as unknown as AcpResponseMessage;
  }
  throw new Error("invalid ACP JSON-RPC message");
}

function isResponse(message: AcpResponseMessage | AcpIncomingMessage): message is AcpResponseMessage {
  return "id" in message && ("result" in message || "error" in message) && !("method" in message);
}

function isRequest(message: AcpResponseMessage | AcpIncomingMessage): message is AcpRequestMessage {
  return "id" in message && "method" in message;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
