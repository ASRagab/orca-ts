import { spawn } from "node:child_process";
import { err, ok, type Result } from "neverthrow";
import { commandFailed, type RuntimeError } from "../model/index.ts";

export interface QuietProcResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface QuietProcOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface VerificationCommand {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export type VerificationCommandResult =
  | {
      readonly type: "success";
      readonly command: string;
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: 0;
      readonly durationMs: number;
    }
  | {
      readonly type: "failed";
      readonly command: string;
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number | null;
      readonly durationMs: number;
    };

export interface CommandTool {
  run(command: VerificationCommand): Promise<VerificationCommandResult>;
}

export async function runQuiet(
  command: string,
  args: readonly string[] = [],
  options: QuietProcOptions = {}
): Promise<Result<QuietProcResult, RuntimeError>> {
  const startedAt = Date.now();
  const rendered = [command, ...args].join(" ");
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    signal: options.signal,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutState = { timedOut: false };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      timeoutState.timedOut = true;
      child.kill("SIGTERM");
    }, Math.max(timeoutMs, 0));
  }

  try {
    const exit = Promise.withResolvers<number | null>();
    child.on("error", exit.reject);
    child.on("close", exit.resolve);
    const exitCode = await exit.promise;
    const durationMs = Date.now() - startedAt;
    const result = { stdout, stderr, exitCode, durationMs };
    if (exitCode === 0 && timeoutMs === undefined) {
      return ok(result);
    }

    const failureStderr = timeoutState.timedOut
      ? [stderr.trimEnd(), `Command timed out after ${String(timeoutMs)}ms`]
          .filter(Boolean)
          .join("\n")
      : stderr;
    return err(
      commandFailed({
        command: rendered,
        exitCode,
        stdout,
        stderr: failureStderr
      })
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function createCommandTool(defaultCwd = process.cwd()): CommandTool {
  return {
    async run(command) {
      const args = command.args ?? [];
      const rendered = [command.command, ...args].join(" ");
      const startedAt = Date.now();
      const result = await runQuiet(command.command, args, {
        cwd: command.cwd ?? defaultCwd,
        ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs })
      });
      const fallbackDurationMs = Date.now() - startedAt;

      if (result.isOk()) {
        return {
          type: "success",
          command: rendered,
          stdout: result.value.stdout,
          stderr: result.value.stderr,
          exitCode: 0,
          durationMs: result.value.durationMs
        };
      }

      const error = result.error;
      if (error._tag === "CommandFailed") {
        return {
          type: "failed",
          command: error.command,
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode,
          durationMs: fallbackDurationMs
        };
      }

      return {
        type: "failed",
        command: rendered,
        stdout: "",
        stderr: JSON.stringify(error),
        exitCode: null,
        durationMs: fallbackDurationMs
      };
    }
  };
}
