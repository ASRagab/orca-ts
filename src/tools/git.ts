import { err, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import { runQuiet, type QuietProcResult } from "./process.ts";

export interface GitTool {
  status(): Promise<Result<string, RuntimeError>>;
  add(paths: readonly string[]): Promise<Result<void, RuntimeError>>;
  commit(message: string): Promise<Result<QuietProcResult, RuntimeError>>;
}

export function createGitTool(cwd: string): GitTool {
  return {
    async status() {
      const result = await runQuiet("git", ["status", "--short"], { cwd });
      return result.map(({ stdout }) => stdout);
    },
    async add(paths) {
      const result = await runQuiet("git", ["add", ...paths], { cwd });
      return result.map(() => undefined);
    },
    async commit(message) {
      const status = await runQuiet("git", ["status", "--short"], { cwd });
      if (status.isErr()) {
        return err(status.error);
      }

      if (status.value.stdout.trim() === "") {
        return err({ _tag: "NothingToCommit" });
      }

      return await runQuiet("git", ["commit", "-m", message], { cwd });
    }
  };
}
