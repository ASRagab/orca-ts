import { spawn } from "node:child_process";
import {
  backendFailed,
  type BackendTag
} from "../model/index.ts";
import type { StreamConversation } from "../conversation/index.ts";
import { reserveConversationSettlement } from "../conversation/settlement-reservation.ts";
import { terminateSubprocess } from "./subprocess-termination.ts";

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

interface SubprocessTerminationFailed {
  readonly type: "termination_failed";
  readonly error: unknown;
}

type SubprocessTimeoutSettlement = SubprocessTimeout | SubprocessTerminationFailed;

/** Shared spawn → stdout-line-stream → consumer → outcome plumbing for
 * subprocess-stream backends (codex, claude, pi). Owns process spawn, line
 * splitting, stderr capture, non-zero-exit failure, cancellation checks, and
 * timeout settlement; the per-backend command/args builder and line consumer
 * plug in.
 *
 * The helper propagates spawn / stream / consumer exceptions unless a timeout
 * has already reserved settlement. In that case timeout termination owns the
 * outcome. Each driver wraps propagated errors so failure and resource teardown
 * stay ordered; use {@link errorMessage} + {@link backendFailed} there. */
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

  const timeout: Deferred<SubprocessTimeoutSettlement> =
    Promise.withResolvers<SubprocessTimeoutSettlement>();
  const inactivityMs = options.inactivityTimeoutMs ?? DefaultSubprocessInactivityTimeoutMs;
  const wallClockMs = options.wallClockTimeoutMs ?? DefaultSubprocessWallClockTimeoutMs;
  let timeoutStarted = false;
  let releaseTimeoutSettlement: (() => void) | undefined;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

  const settleTimeout = (kind: SubprocessTimeoutKind): void => {
    if (timeoutStarted) {
      return;
    }
    timeoutStarted = true;
    releaseTimeoutSettlement = reserveConversationSettlement(conversation);
    void terminateSubprocess(process).then(
      () => {
        timeout.resolve({ type: "timeout", kind });
      },
      (error: unknown) => {
        timeout.resolve({ type: "termination_failed", error });
      }
    );
  };
  const hasTimeoutStarted = (): boolean => timeoutStarted;
  const settleSubprocessTimeout = (settlement: SubprocessTimeoutSettlement): void => {
    releaseTimeoutSettlement?.();
    if (settlement.type === "termination_failed") {
      conversation.fail(backendFailed(backend, errorMessage(settlement.error)));
      return;
    }
    failSubprocessTimeout(conversation, backend, settlement.kind, inactivityMs, wallClockMs);
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
      const next: IteratorResult<string> | SubprocessTimeoutSettlement = await Promise.race([
        lines.next(),
        timeout.promise
      ]);
      if (isSubprocessTimeoutSettlement(next)) {
        settleSubprocessTimeout(next);
        return;
      }
      if (hasTimeoutStarted()) {
        const completedTimeout = await timeout.promise;
        settleSubprocessTimeout(completedTimeout);
        return;
      }
      if (next.done) {
        break;
      }
      resetInactivityTimer();
      if (conversation.signal.aborted) {
        return;
      }
      const consumed: undefined | SubprocessTimeoutSettlement = await Promise.race([
        consumer.consume(next.value).then(() => undefined),
        timeout.promise
      ]);
      if (consumed !== undefined) {
        settleSubprocessTimeout(consumed);
        return;
      }
      if (hasTimeoutStarted()) {
        const completedTimeout = await timeout.promise;
        settleSubprocessTimeout(completedTimeout);
        return;
      }
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

    const exit: number | null | SubprocessTimeoutSettlement = await Promise.race([
      process.exit,
      timeout.promise
    ]);
    if (isSubprocessTimeoutSettlement(exit)) {
      settleSubprocessTimeout(exit);
      return;
    }
    const stderrResult: string | SubprocessTimeoutSettlement = await Promise.race([
      stderr,
      timeout.promise
    ]);
    if (isSubprocessTimeoutSettlement(stderrResult)) {
      settleSubprocessTimeout(stderrResult);
      return;
    }
    if (hasTimeoutStarted()) {
      const completedTimeout = await timeout.promise;
      settleSubprocessTimeout(completedTimeout);
      return;
    }
    const stderrText = stderrResult.trim();
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
  } catch (error) {
    if (hasTimeoutStarted()) {
      const completedTimeout = await timeout.promise;
      settleSubprocessTimeout(completedTimeout);
      return;
    }
    throw error;
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

function isSubprocessTimeoutSettlement(value: unknown): value is SubprocessTimeoutSettlement {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const type = (value as { readonly type?: unknown }).type;
  return type === "timeout" || type === "termination_failed";
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
