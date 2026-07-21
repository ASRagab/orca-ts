import { spawn } from "node:child_process";
import {
  backendFailed,
  type BackendTag
} from "../model/index.ts";
import type { StreamConversation } from "../conversation/index.ts";
import {
  observeConversationCancellationCompletion,
  reportConversationCancellationFailure,
  reserveConversationSettlement
} from "../conversation/settlement-reservation.ts";
import {
  registerSubprocessExitWaitCancellation,
  terminateSubprocess
} from "./subprocess-termination.ts";

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

type SubprocessTerminal =
  | { readonly type: "cancelled" }
  | { readonly type: "consumer" }
  | { readonly type: "timeout"; readonly settlement: SubprocessTimeoutSettlement }
  | {
      readonly type: "exited";
      readonly consumer: SubprocessConsumer;
      readonly exit: number | null;
      readonly stderr: string;
    }
  | { readonly type: "error"; readonly error: unknown };

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

  const timeout: Deferred<SubprocessTimeoutSettlement> =
    Promise.withResolvers<SubprocessTimeoutSettlement>();
  const inactivityMs = options.inactivityTimeoutMs ?? DefaultSubprocessInactivityTimeoutMs;
  const wallClockMs = options.wallClockTimeoutMs ?? DefaultSubprocessWallClockTimeoutMs;
  let streamTeardownDeadline: number | undefined;
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
  const isConversationAborted = (): boolean => conversation.signal.aborted;
  const awaitStreamTeardown = async <T>(operation: PromiseLike<T> | T): Promise<T> => {
    streamTeardownDeadline ??= Date.now() + Math.max(wallClockMs, 0);
    const remainingMs = streamTeardownDeadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      const fail = (): void => {
        reject(
          new Error(
            `subprocess stream teardown exceeded ${String(wallClockMs)}ms wall-clock limit`
          )
        );
      };
      if (remainingMs <= 0) {
        fail();
        return;
      }
      timer = setTimeout(fail, remainingMs);
    });
    try {
      return await Promise.race([Promise.resolve(operation), deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
  const failStreamCleanup = (error: unknown): void => {
    if (
      isConversationAborted() &&
      reportConversationCancellationFailure(conversation, error)
    ) {
      return;
    }
    conversation.fail(backendFailed(backend, errorMessage(error)));
  };
  const settleSubprocessTimeout = (settlement: SubprocessTimeoutSettlement): void => {
    if (settlement.type === "termination_failed") {
      conversation.fail(backendFailed(backend, errorMessage(settlement.error)));
    } else {
      failSubprocessTimeout(conversation, backend, settlement.kind, inactivityMs, wallClockMs);
    }
    releaseTimeoutSettlement?.();
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

  const releaseRunSettlement = reserveConversationSettlement(conversation);
  const conversationAborted = Symbol("conversation aborted during subprocess work");
  const observedConversationAbort = Promise.withResolvers<typeof conversationAborted>();
  const onConversationAbort = (): void => {
    observedConversationAbort.resolve(conversationAborted);
  };
  if (conversation.signal.aborted) {
    onConversationAbort();
  } else {
    conversation.signal.addEventListener("abort", onConversationAbort, { once: true });
  }
  const conversationSettled = Symbol("conversation settled during subprocess read");
  const observedConversationSettlement: Promise<typeof conversationSettled> =
    conversation.awaitResult().then(() => conversationSettled);
  const observedCancellationCompletion =
    observeConversationCancellationCompletion(conversation);
  let stderr: TextCollector | undefined;
  let stdoutIterator: AsyncIterator<string | Uint8Array> | undefined;
  let lines: AsyncIterator<string> | undefined;

  const cancelStdout = async (): Promise<void> => {
    const cleanupErrors: unknown[] = [];
    try {
      if (isDestroyable(process.stdout)) {
        process.stdout.destroy();
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await awaitStreamTeardown(stdoutIterator?.return?.());
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await awaitStreamTeardown(lines?.return?.());
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw cleanupErrors[0];
    }
  };
  const cancelStderr = async (): Promise<void> => {
    if (stderr) {
      await awaitStreamTeardown(stderr.cancel());
      return;
    }
    if (process.stderr && isDestroyable(process.stderr)) {
      process.stderr.destroy();
    }
  };
  const cleanupStreams = async (): Promise<readonly unknown[]> => {
    const cleanupErrors: unknown[] = [];
    await Promise.all([
      cancelStdout().catch((error: unknown) => {
        cleanupErrors.push(error);
      }),
      cancelStderr().catch((error: unknown) => {
        cleanupErrors.push(error);
      })
    ]);
    return cleanupErrors;
  };
  const awaitConversationStop = async (): Promise<void> => {
    if (isConversationAborted()) {
      await observedCancellationCompletion;
      return;
    }
    await Promise.race([
      process.exit.catch(() => null),
      observedConversationSettlement
    ]);
  };
  const terminateAndCleanup = async (
    completeStderr: boolean
  ): Promise<readonly unknown[]> => {
    const cleanupErrors: unknown[] = [];
    let terminationSucceeded = false;
    try {
      await terminateSubprocess(process);
      terminationSucceeded = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await cancelStdout();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (completeStderr && terminationSucceeded && stderr) {
      try {
        await awaitStreamTeardown(stderr.result);
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      try {
        await cancelStderr();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    return cleanupErrors;
  };
  const observeSubprocess = async (
    consumer: SubprocessConsumer,
    lineIterator: AsyncIterator<string>,
    stderrCollector: TextCollector
  ): Promise<SubprocessTerminal> => {
    for (;;) {
      const next:
        | IteratorResult<string>
        | SubprocessTimeoutSettlement
        | typeof conversationAborted
        | typeof conversationSettled = await Promise.race([
        lineIterator.next(),
        timeout.promise,
        observedConversationAbort.promise,
        observedConversationSettlement
      ]);
      if (next === conversationAborted || next === conversationSettled) {
        return { type: "cancelled" };
      }
      if (isSubprocessTimeoutSettlement(next)) {
        return { type: "timeout", settlement: next };
      }
      if (hasTimeoutStarted()) {
        return { type: "timeout", settlement: await timeout.promise };
      }
      if (next.done) {
        break;
      }
      resetInactivityTimer();
      if (isConversationAborted()) {
        return { type: "cancelled" };
      }
      const consumed: undefined | SubprocessTimeoutSettlement | typeof conversationAborted =
        await Promise.race([
          consumer.consume(next.value).then(() => undefined),
          timeout.promise,
          observedConversationAbort.promise
        ]);
      if (consumed === conversationAborted) {
        return { type: "cancelled" };
      }
      if (consumed !== undefined) {
        return { type: "timeout", settlement: consumed };
      }
      if (hasTimeoutStarted()) {
        return { type: "timeout", settlement: await timeout.promise };
      }
      if (isConversationAborted()) {
        return { type: "cancelled" };
      }
      if (consumer.signal.aborted) {
        return { type: "consumer" };
      }
    }

    if (consumer.signal.aborted) {
      return { type: "consumer" };
    }

    const exit:
      | number
      | null
      | SubprocessTimeoutSettlement
      | typeof conversationAborted
      | typeof conversationSettled = await Promise.race([
      process.exit,
      timeout.promise,
      observedConversationAbort.promise,
      observedConversationSettlement
    ]);
    if (exit === conversationAborted || exit === conversationSettled) {
      return { type: "cancelled" };
    }
    if (isSubprocessTimeoutSettlement(exit)) {
      return { type: "timeout", settlement: exit };
    }

    const stderrResult:
      | string
      | SubprocessTimeoutSettlement
      | typeof conversationAborted
      | typeof conversationSettled = await Promise.race([
      stderrCollector.result,
      timeout.promise,
      observedConversationAbort.promise,
      observedConversationSettlement
    ]);
    if (stderrResult === conversationAborted || stderrResult === conversationSettled) {
      return { type: "cancelled" };
    }
    if (isSubprocessTimeoutSettlement(stderrResult)) {
      return { type: "timeout", settlement: stderrResult };
    }
    if (hasTimeoutStarted()) {
      return { type: "timeout", settlement: await timeout.promise };
    }
    if (isConversationAborted()) {
      return { type: "cancelled" };
    }
    return { type: "exited", consumer, exit, stderr: stderrResult };
  };
  const finalizeSubprocess = async (terminal: SubprocessTerminal): Promise<void> => {
    clearTimeout(inactivityTimer);
    clearTimeout(wallClockTimer);
    streamTeardownDeadline = Date.now() + Math.max(wallClockMs, 0);

    if (terminal.type === "consumer") {
      const cleanupErrors = await terminateAndCleanup(true);
      if (cleanupErrors.length > 0) {
        failStreamCleanup(cleanupErrors[0]);
      }
      return;
    }
    if (terminal.type === "timeout") {
      const cleanupErrors = await cleanupStreams();
      if (cleanupErrors.length > 0) {
        failStreamCleanup(cleanupErrors[0]);
      }
      settleSubprocessTimeout(terminal.settlement);
      return;
    }
    if (terminal.type === "cancelled") {
      await awaitConversationStop();
      const cleanupErrors = await cleanupStreams();
      if (cleanupErrors.length > 0) {
        reportConversationCancellationFailure(conversation, cleanupErrors[0]);
      }
      if (hasTimeoutStarted()) {
        settleSubprocessTimeout(await timeout.promise);
      }
      return;
    }
    if (terminal.type === "error") {
      const cleanupErrors = await terminateAndCleanup(false);
      if (isConversationAborted() && cleanupErrors.length > 0) {
        reportConversationCancellationFailure(conversation, cleanupErrors[0]);
      }
      throw terminal.error;
    }
    if (isConversationAborted()) {
      await awaitConversationStop();
      const cleanupErrors = await cleanupStreams();
      if (cleanupErrors.length > 0) {
        reportConversationCancellationFailure(conversation, cleanupErrors[0]);
      }
      if (hasTimeoutStarted()) {
        settleSubprocessTimeout(await timeout.promise);
      }
      return;
    }

    const stderrText = terminal.stderr.trim();
    if (terminal.exit !== 0) {
      const exitCodeText = terminal.exit === null ? "unknown" : String(terminal.exit);
      conversation.fail(
        backendFailed(
          backend,
          `${backend} exited with code ${exitCodeText}${stderrText ? `: ${stderrText}` : ""}`
        )
      );
      return;
    }
    terminal.consumer.finish();
  };

  try {
    let terminal: SubprocessTerminal;
    try {
      options.setProcess?.(process);
      stderr = startTextCollector(process.stderr);
      stdoutIterator = process.stdout[Symbol.asyncIterator]();
      const stdoutChunks: AsyncIterable<string | Uint8Array> = {
        [Symbol.asyncIterator]: () => stdoutIterator as AsyncIterator<string | Uint8Array>
      };
      lines = splitLines(stdoutChunks)[Symbol.asyncIterator]();
      const startup:
        | undefined
        | SubprocessTimeoutSettlement
        | typeof conversationAborted
        | typeof conversationSettled =
        options.onStart === undefined
          ? undefined
          : await Promise.race([
              Promise.resolve(options.onStart(process)).then(() => undefined),
              timeout.promise,
              observedConversationAbort.promise,
              observedConversationSettlement
            ]);
      if (
        startup === conversationAborted ||
        startup === conversationSettled ||
        isConversationAborted()
      ) {
        terminal = { type: "cancelled" };
      } else if (isSubprocessTimeoutSettlement(startup)) {
        terminal = { type: "timeout", settlement: startup };
      } else if (hasTimeoutStarted()) {
        terminal = { type: "timeout", settlement: await timeout.promise };
      } else {
        terminal = await observeSubprocess(options.createConsumer(), lines, stderr);
      }
    } catch (error) {
      terminal = hasTimeoutStarted()
        ? { type: "timeout", settlement: await timeout.promise }
        : { type: "error", error };
    }
    await finalizeSubprocess(terminal);
  } finally {
    clearTimeout(inactivityTimer);
    clearTimeout(wallClockTimer);
    conversation.signal.removeEventListener("abort", onConversationAbort);
    releaseRunSettlement();
  }
}

export function spawnSubprocess(
  command: string,
  args: readonly string[],
  options: SubprocessSpawnOptions
): SubprocessProcess {
  const stdinMode = options.stdin ?? "ignore";
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: useProcessGroup,
    stdio: [stdinMode === "pipe" ? "pipe" : "ignore", "pipe", "pipe"]
  });

  if (!child.stdout) {
    throw new Error(`failed to capture stdout for ${command}`);
  }

  const leaderExit = Promise.withResolvers<number | null>();
  child.on("error", leaderExit.reject);
  child.on("close", leaderExit.resolve);
  const processGroupExit =
    useProcessGroup && child.pid !== undefined
      ? waitForProcessGroupExit(child.pid, leaderExit.promise)
      : undefined;
  const subprocess: SubprocessProcess = {
    stdout: child.stdout,
    ...(child.stderr ? { stderr: child.stderr } : {}),
    exit: processGroupExit?.promise ?? leaderExit.promise,
    kill(signal?: NodeJS.Signals) {
      if (!useProcessGroup || child.pid === undefined) {
        child.kill(signal);
        return;
      }
      try {
        process.kill(-child.pid, signal ?? "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    },
    write(data: string) {
      child.stdin?.write(data);
    },
    endStdin() {
      child.stdin?.end();
    }
  };
  if (processGroupExit !== undefined) {
    registerSubprocessExitWaitCancellation(subprocess, (error: unknown) => {
      processGroupExit.cancel(error);
    });
  }
  return subprocess;
}

interface ProcessGroupExitWait {
  readonly promise: Promise<number | null>;
  cancel(error: unknown): void;
}

function waitForProcessGroupExit(
  processGroupId: number,
  leaderExit: Promise<number | null>
): ProcessGroupExitWait {
  const completion = Promise.withResolvers<number | null>();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reject = (error: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    timer = undefined;
    completion.reject(error);
  };
  const poll = (exitCode: number | null): void => {
    if (settled) {
      return;
    }
    try {
      if (!isProcessGroupAlive(processGroupId)) {
        settled = true;
        completion.resolve(exitCode);
        return;
      }
    } catch (error) {
      reject(error);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      poll(exitCode);
    }, 10);
  };
  void leaderExit.then(poll, reject);
  void completion.promise.catch(() => undefined);
  return {
    promise: completion.promise,
    cancel: reject
  };
}

function isProcessGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
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
  return await startTextCollector(chunks).result;
}

interface TextCollector {
  readonly result: Promise<string>;
  cancel(): Promise<void>;
}

function startTextCollector(
  chunks: AsyncIterable<string | Uint8Array> | undefined
): TextCollector {
  if (!chunks) {
    return {
      result: Promise.resolve(""),
      cancel: () => Promise.resolve()
    };
  }

  const decoder = new TextDecoder();
  const text: string[] = [];
  const iterator = chunks[Symbol.asyncIterator]();
  const result = (async (): Promise<string> => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      text.push(decodeChunk(decoder, next.value));
    }
    text.push(decoder.decode());
    return text.join("");
  })();
  void result.catch(() => undefined);
  let cancellation: Promise<void> | undefined;

  return {
    result,
    cancel() {
      cancellation ??= (async (): Promise<void> => {
        const cleanupErrors: unknown[] = [];
        try {
          if (isDestroyable(chunks)) {
            chunks.destroy();
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await iterator.return?.();
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length > 0) {
          throw cleanupErrors[0];
        }
      })();
      return cancellation;
    }
  };
}

function isDestroyable(value: unknown): value is { destroy(): unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "destroy" in value &&
    typeof value.destroy === "function"
  );
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
