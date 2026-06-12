import { spawn } from "node:child_process";
import {
  backendFailed,
  type BackendTag
} from "../model/index.ts";
import type { StreamConversation } from "../conversation/index.ts";

const DefaultSubprocessInactivityTimeoutMs = 120_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}
const DefaultSubprocessWallClockTimeoutMs = 600_000;

/** A spawned agent subprocess: a stdout (and optional stderr) line/byte stream,
 * an exit promise, a kill signal, and — for backends that feed their prompt over
 * stdin (claude, pi) — an optional write/end pair. Codex leaves stdin ignored and
 * never touches these. */
export interface SubprocessProcess {
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr?: AsyncIterable<string | Uint8Array>;
  readonly exit: Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
  write?(data: string): void;
  endStdin?(): void;
}

export interface SubprocessSpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Whether stdin is wired. Defaults to "ignore" so codex stays byte-identical;
   * claude/pi pass "pipe" to write the opening user turn. */
  readonly stdin?: "ignore" | "pipe";
}

export type SubprocessSpawner = (
  command: string,
  args: readonly string[],
  options: SubprocessSpawnOptions
) => SubprocessProcess;

/** The per-line consumer half a backend supplies: incremental `consume(line)`
 * plus a `finish()` that the helper calls after a clean (zero-exit) stream end.
 * `signal` aborts once the turn is settled — required for persistent processes
 * (pi rpc) that don't exit after a turn. */
export interface SubprocessConsumer {
  readonly signal: AbortSignal;
  consume(raw: string): Promise<void>;
  finish(): void;
}

export interface RunSubprocessOptions<B extends BackendTag> {
  readonly backend: B;
  readonly command: string;
  readonly args: readonly string[];
  readonly conversation: StreamConversation<B>;
  readonly createConsumer: () => SubprocessConsumer;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: "ignore" | "pipe";
  readonly spawnProcess?: SubprocessSpawner;
  /** Fail when stdout produces no line for this many ms. Defaults to 120s. */
  readonly inactivityTimeoutMs?: number;
  /** Fail after this absolute turn duration even if stdout stays active. Defaults to 600s. */
  readonly wallClockTimeoutMs?: number;
  /** Records the spawned process so the accessor can `kill` it on cancellation. */
  readonly setProcess?: (process: SubprocessProcess) => void;
  /** Runs right after spawn (before the read loop) — claude/pi write the opening
   * user turn to stdin and close it here. */
  readonly onStart?: (process: SubprocessProcess) => void | Promise<void>;
}

type SubprocessTimeoutKind = "inactivity" | "wallclock";

interface SubprocessTimeout {
  readonly type: "timeout";
  readonly kind: SubprocessTimeoutKind;
}

/** Shared spawn → stdout-line-stream → consumer → outcome plumbing for
 * subprocess-stream backends (codex, claude, pi). Owns process spawn, line
 * splitting, stderr capture, non-zero-exit failure, cancellation checks, and
 * timeout settlement; the per-backend command/args builder and line consumer
 * plug in.
 *
 * The helper deliberately does NOT catch spawn / stream / consumer exceptions —
 * each driver wraps the call in its own try/catch/finally so spawn-error→fail and
 * resource teardown stay synchronous with the failure (matters for deterministic
 * cleanup ordering; see codex's ask_user bridge). Use {@link errorMessage} +
 * {@link backendFailed} in that catch. */
export async function runSubprocessConversation<B extends BackendTag>(
  options: RunSubprocessOptions<B>
): Promise<void> {
  const { conversation, backend } = options;
  const spawnProcess = options.spawnProcess ?? spawnSubprocess;
  const spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: "ignore" | "pipe" } = {};
  if (options.cwd !== undefined) {
    spawnOptions.cwd = options.cwd;
  }
  if (options.env !== undefined) {
    spawnOptions.env = options.env;
  }
  if (options.stdin !== undefined) {
    spawnOptions.stdin = options.stdin;
  }

  const process = spawnProcess(options.command, options.args, spawnOptions);
  options.setProcess?.(process);

  const stderr = collectText(process.stderr);
  await options.onStart?.(process);

  const timeout: Deferred<SubprocessTimeout> = Promise.withResolvers<SubprocessTimeout>();
  const inactivityMs = options.inactivityTimeoutMs ?? DefaultSubprocessInactivityTimeoutMs;
  const wallClockMs = options.wallClockTimeoutMs ?? DefaultSubprocessWallClockTimeoutMs;
  let timeoutSettled = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

  const settleTimeout = (kind: SubprocessTimeoutKind): void => {
    if (timeoutSettled) {
      return;
    }
    timeoutSettled = true;
    process.kill("SIGTERM");
    timeout.resolve({ type: "timeout", kind });
  };
  const resetInactivityTimer = (): void => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      settleTimeout("inactivity");
    }, Math.max(inactivityMs, 0));
  };

  const wallClockTimer = setTimeout(() => {
    settleTimeout("wallclock");
  }, Math.max(wallClockMs, 0));
  resetInactivityTimer();

  try {
    const consumer = options.createConsumer();
    const lines = splitLines(process.stdout)[Symbol.asyncIterator]();
    for (;;) {
      const next: IteratorResult<string> | SubprocessTimeout = await Promise.race([lines.next(), timeout.promise]);
      if (isSubprocessTimeout(next)) {
        failSubprocessTimeout(conversation, backend, next.kind, inactivityMs, wallClockMs);
        return;
      }
      if (next.done) {
        break;
      }
      resetInactivityTimer();
      if (conversation.signal.aborted) {
        return;
      }
      await consumer.consume(next.value);
      if (consumer.signal.aborted) {
        // Kill the child once the consumer has settled the conversation on a
        // terminal event (success, modeled failure, or early parse/tool error).
        // Safe because we only reach here after consuming that event — the agent's
        // session rollout is already flushed — and it stops a persistent process
        // (pi rpc) or a stalled CLI from lingering after Orca has the outcome.
        process.kill();
        break;
      }
    }

    // The consumer already settled the conversation (success/failure); the
    // exit-code path below is only for a stream that ended without one.
    if (consumer.signal.aborted) {
      return;
    }

    const exit: number | null | SubprocessTimeout = await Promise.race([process.exit, timeout.promise]);
    if (isSubprocessTimeout(exit)) {
      failSubprocessTimeout(conversation, backend, exit.kind, inactivityMs, wallClockMs);
      return;
    }
    const stderrText = (await stderr).trim();
    if (conversation.signal.aborted) {
      return;
    }

    if (exit !== 0) {
      const exitCodeText = exit === null ? "unknown" : String(exit);
      conversation.fail(
        backendFailed(
          backend,
          `${backend} exited with code ${exitCodeText}${stderrText ? `: ${stderrText}` : ""}`
        )
      );
      return;
    }

    consumer.finish();
  } finally {
    clearTimeout(inactivityTimer);
    clearTimeout(wallClockTimer);
  }
}

export function spawnSubprocess(
  command: string,
  args: readonly string[],
  options: SubprocessSpawnOptions
): SubprocessProcess {
  const stdinMode = options.stdin ?? "ignore";
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [stdinMode === "pipe" ? "pipe" : "ignore", "pipe", "pipe"]
  });

  if (!child.stdout) {
    throw new Error(`failed to capture stdout for ${command}`);
  }

  const exit = Promise.withResolvers<number | null>();
  child.on("error", exit.reject);
  child.on("close", exit.resolve);

  return {
    stdout: child.stdout,
    ...(child.stderr ? { stderr: child.stderr } : {}),
    exit: exit.promise,
    kill(signal?: NodeJS.Signals) {
      child.kill(signal);
    },
    write(data: string) {
      child.stdin?.write(data);
    },
    endStdin() {
      child.stdin?.end();
    }
  };
}

export async function* splitLines(
  chunks: AsyncIterable<string | Uint8Array>
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += decodeChunk(decoder, chunk);
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      yield line;
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer.replace(/\r$/, "");
  }
}

export async function collectText(
  chunks: AsyncIterable<string | Uint8Array> | undefined
): Promise<string> {
  if (!chunks) {
    return "";
  }

  const decoder = new TextDecoder();
  const text: string[] = [];
  for await (const chunk of chunks) {
    text.push(decodeChunk(decoder, chunk));
  }
  text.push(decoder.decode());
  return text.join("");
}

function decodeChunk(decoder: TextDecoder, chunk: string | Uint8Array): string {
  return typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
}

function isSubprocessTimeout(value: IteratorResult<string> | number | null | SubprocessTimeout): value is SubprocessTimeout {
  return typeof value === "object" && value !== null && (value as { readonly type?: unknown }).type === "timeout";
}

function failSubprocessTimeout<B extends BackendTag>(
  conversation: StreamConversation<B>,
  backend: B,
  kind: SubprocessTimeoutKind,
  inactivityMs: number,
  wallClockMs: number
): void {
  if (conversation.signal.aborted) {
    return;
  }
  const message =
    kind === "inactivity"
      ? `${backend} emitted no stdout for ${String(inactivityMs)}ms; treating the turn as stalled`
      : `${backend} turn exceeded ${String(wallClockMs)}ms wall-clock limit`;
  conversation.fail(backendFailed(backend, message));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
