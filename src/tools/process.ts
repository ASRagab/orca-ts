import { spawn } from "node:child_process";
import { err, ok, type Result } from "neverthrow";
import { commandFailed, type RuntimeError } from "../model/index.ts";

export interface QuietProcResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface QuietProcOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface VerificationCommand {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export type VerificationCommandResult =
  | {
      readonly type: "success";
      readonly command: string;
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: 0;
    }
  | {
      readonly type: "failed";
      readonly command: string;
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number | null;
    };

export interface CommandTool {
  run(command: VerificationCommand): Promise<VerificationCommandResult>;
}

export async function runQuiet(
  command: string,
  args: readonly string[] = [],
  options: QuietProcOptions = {}
): Promise<Result<QuietProcResult, RuntimeError>> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    signal: options.signal,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  const result = { stdout, stderr, exitCode };
  if (exitCode === 0) {
    return ok(result);
  }

  return err(
    commandFailed({
      command: [command, ...args].join(" "),
      exitCode,
      stdout,
      stderr
    })
  );
}

export function createCommandTool(defaultCwd = process.cwd()): CommandTool {
  return {
    async run(command) {
      const args = command.args ?? [];
      const rendered = [command.command, ...args].join(" ");
      const result = await runQuiet(command.command, args, { cwd: command.cwd ?? defaultCwd });

      if (result.isOk()) {
        return {
          type: "success",
          command: rendered,
          stdout: result.value.stdout,
          stderr: result.value.stderr,
          exitCode: 0
        };
      }

      const error = result.error;
      if (error._tag === "CommandFailed") {
        return {
          type: "failed",
          command: error.command,
          stdout: error.stdout,
          stderr: error.stderr,
          exitCode: error.exitCode
        };
      }

      return {
        type: "failed",
        command: rendered,
        stdout: "",
        stderr: JSON.stringify(error),
        exitCode: null
      };
    }
  };
}
