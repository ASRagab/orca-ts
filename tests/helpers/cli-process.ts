import { spawn } from "node:child_process";

export interface CliProcessChunk {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly atMs: number;
}

export interface CliProcessResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly renderedCommand: string;
  readonly cwd?: string;
  readonly pid?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly chunks: readonly CliProcessChunk[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly forceKilled: boolean;
}

export interface CliProcessShutdownAfter {
  readonly stream: "stdout" | "stderr";
  readonly pattern: RegExp | string;
  readonly signal: NodeJS.Signals;
  readonly delayMs?: number;
}

export interface CliProcessOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
  readonly gracefulSignal?: NodeJS.Signals;
  readonly forceKillAfterMs?: number;
  readonly forceSignal?: NodeJS.Signals;
  readonly shutdownAfter?: CliProcessShutdownAfter;
}

export async function runCliProcess(
  command: string,
  args: readonly string[] = [],
  options: CliProcessOptions = {},
): Promise<CliProcessResult> {
  const startedAt = Date.now();
  const renderedCommand = [command, ...args].join(" ");
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let forceKilled = false;
  let shutdownSent = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let forceTimeout: ReturnType<typeof setTimeout> | undefined;
  const chunks: CliProcessChunk[] = [];

  const kill = (signal: NodeJS.Signals): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill(signal);
  };

  const maybeShutdown = (stream: "stdout" | "stderr"): void => {
    const rule = options.shutdownAfter;
    if (rule === undefined || shutdownSent || rule.stream !== stream) {
      return;
    }
    const streamText = stream === "stdout" ? stdout : stderr;
    const matched =
      typeof rule.pattern === "string" ? streamText.includes(rule.pattern) : rule.pattern.test(streamText);
    if (!matched) {
      return;
    }
    shutdownSent = true;
    setTimeout(() => {
      kill(rule.signal);
    }, rule.delayMs ?? 0);
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    chunks.push({ stream: "stdout", text: chunk, atMs: Date.now() - startedAt });
    maybeShutdown("stdout");
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    chunks.push({ stream: "stderr", text: chunk, atMs: Date.now() - startedAt });
    maybeShutdown("stderr");
  });

  if (options.timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      timedOut = true;
      kill(options.gracefulSignal ?? "SIGTERM");
      forceTimeout = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          forceKilled = true;
          kill(options.forceSignal ?? "SIGKILL");
        }
      }, options.forceKillAfterMs ?? 1_000);
    }, Math.max(options.timeoutMs, 0));
  }

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", (error) => {
      stderr += `${String(error)}\n`;
    });
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });

  clearTimeout(timeout);
  clearTimeout(forceTimeout);

  return {
    command,
    args: [...args],
    renderedCommand,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    stdout,
    stderr,
    chunks,
    exitCode: exit.code,
    signal: exit.signal,
    durationMs: Date.now() - startedAt,
    timedOut,
    forceKilled,
  };
}

export function formatCliProcessEvidence(result: CliProcessResult): string {
  return [
    `command: ${result.renderedCommand}`,
    result.cwd === undefined ? undefined : `cwd: ${result.cwd}`,
    result.pid === undefined ? undefined : `pid: ${String(result.pid)}`,
    `exitCode: ${String(result.exitCode)}`,
    `signal: ${String(result.signal)}`,
    `durationMs: ${String(result.durationMs)}`,
    `timedOut: ${String(result.timedOut)}`,
    `forceKilled: ${String(result.forceKilled)}`,
    `stdout:\n${result.stdout.trimEnd()}`,
    `stderr:\n${result.stderr.trimEnd()}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function expectExitZero(result: CliProcessResult): void {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut) {
    throw new Error(formatCliProcessEvidence(result));
  }
}

export function expectProcessExited(result: CliProcessResult): void {
  if (result.pid === undefined) {
    return;
  }
  try {
    process.kill(result.pid, 0);
  } catch {
    return;
  }
  throw new Error(`process still running\n${formatCliProcessEvidence(result)}`);
}

export function expectNoOrcaDiagnosticsOnStdout(result: CliProcessResult): void {
  if (/(^|\n)orca (?:\||:)/.test(result.stdout)) {
    throw new Error(`Orca diagnostics leaked to stdout\n${formatCliProcessEvidence(result)}`);
  }
}

export function expectStderrContainsDiagnostics(
  result: CliProcessResult,
  diagnostics: readonly string[],
): void {
  const missing = diagnostics.filter((diagnostic) => !result.stderr.includes(`orca | ${diagnostic}`));
  if (missing.length > 0) {
    throw new Error(`missing stderr diagnostics: ${missing.join(", ")}\n${formatCliProcessEvidence(result)}`);
  }
}

export function expectOrderedStderr(result: CliProcessResult, diagnostics: readonly string[]): void {
  let offset = 0;
  for (const diagnostic of diagnostics) {
    const next = result.stderr.indexOf(diagnostic, offset);
    if (next === -1) {
      throw new Error(`stderr diagnostic out of order: ${diagnostic}\n${formatCliProcessEvidence(result)}`);
    }
    offset = next + diagnostic.length;
  }
}

export function expectOrderedProcessEvidence(
  result: CliProcessResult,
  sequence: readonly { stream: "stdout" | "stderr"; text: string }[],
): void {
  let offset = 0;
  const timeline = result.chunks.map((chunk) => `[${chunk.stream}] ${chunk.text}`).join("");
  for (const expected of sequence) {
    let textAt = timeline.indexOf(expected.text, offset);
    while (textAt !== -1 && streamAt(timeline, textAt) !== expected.stream) {
      textAt = timeline.indexOf(expected.text, textAt + expected.text.length);
    }
    if (textAt === -1) {
      throw new Error(`process evidence out of order: ${expected.stream} ${expected.text}\n${timeline}`);
    }
    offset = textAt + expected.text.length;
  }
}

function streamAt(timeline: string, offset: number): "stdout" | "stderr" | undefined {
  const stdoutAt = timeline.lastIndexOf("[stdout]", offset);
  const stderrAt = timeline.lastIndexOf("[stderr]", offset);
  if (stdoutAt === -1 && stderrAt === -1) {
    return undefined;
  }
  return stdoutAt > stderrAt ? "stdout" : "stderr";
}
