import { spawn } from "node:child_process";
import {
  backendFailed,
  type BackendTag
} from "../model/index.ts";
import type { StreamConversation } from "../conversation/index.ts";

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
 * `completed` lets the helper stop reading once the turn is settled — required
 * for persistent processes (pi rpc) that don't exit after a turn. */
export interface SubprocessConsumer {
  readonly completed?: boolean;
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
  /** Records the spawned process so the accessor can `kill` it on cancellation. */
  readonly setProcess?: (process: SubprocessProcess) => void;
  /** Runs right after spawn (before the read loop) — claude/pi write the opening
   * user turn to stdin and close it here. */
  readonly onStart?: (process: SubprocessProcess) => void | Promise<void>;
}

/** Shared spawn → stdout-line-stream → consumer → outcome plumbing for
 * subprocess-stream backends (codex, claude, pi). Owns process spawn, line
 * splitting, stderr capture, non-zero-exit failure, and cancellation checks; the
 * per-backend command/args builder and line consumer plug in.
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

  const consumer = options.createConsumer();
  for await (const line of splitLines(process.stdout)) {
    if (conversation.signal.aborted) {
      return;
    }
    await consumer.consume(line);
    if (consumer.completed) {
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
  if (consumer.completed) {
    return;
  }

  const exitCode = await process.exit;
  const stderrText = (await stderr).trim();
  if (conversation.signal.aborted) {
    return;
  }

  if (exitCode !== 0) {
    const exitCodeText = exitCode === null ? "unknown" : String(exitCode);
    conversation.fail(
      backendFailed(
        backend,
        `${backend} exited with code ${exitCodeText}${stderrText ? `: ${stderrText}` : ""}`
      )
    );
    return;
  }

  consumer.finish();
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

  return {
    stdout: child.stdout,
    ...(child.stderr ? { stderr: child.stderr } : {}),
    exit: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }),
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
