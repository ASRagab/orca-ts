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
