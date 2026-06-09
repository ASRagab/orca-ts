import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import { runQuiet, type QuietProcResult } from "../tools/process.ts";

export interface CommandRunner {
  (command: string, args: readonly string[], options: { cwd: string }): Promise<Result<QuietProcResult, RuntimeError>>;
}

export interface TypecheckOptions {
  readonly cwd: string;
  readonly project?: string;
  readonly skip?: boolean;
  readonly runner?: CommandRunner;
}

export interface TypecheckResult {
  readonly skipped: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runTypecheck(
  options: TypecheckOptions
): Promise<Result<TypecheckResult, RuntimeError>> {
  if (options.skip) {
    return ok({ skipped: true, stdout: "", stderr: "" });
  }

  const runner = options.runner ?? runQuiet;
  const args = ["--noEmit"];
  if (options.project) {
    args.push("-p", options.project);
  }

  const result = await runner("tsc", args, { cwd: options.cwd });
  if (result.isErr()) {
    const error = result.error;
    if (error._tag === "CommandFailed") {
      return err({
        _tag: "TypecheckFailed",
        stdout: error.stdout,
        stderr: error.stderr,
        exitCode: error.exitCode
      });
    }
    return err(error);
  }

  return ok({ skipped: false, stdout: result.value.stdout, stderr: result.value.stderr });
}
