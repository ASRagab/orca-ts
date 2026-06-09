import type { Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import { runQuiet, type QuietProcResult } from "./process.ts";

export interface PullRequestInput {
  readonly title: string;
  readonly bodyFile: string;
  readonly base?: string;
}

export interface GitHubTool {
  createPullRequest(input: PullRequestInput): Promise<Result<QuietProcResult, RuntimeError>>;
}

export function createGitHubTool(cwd: string): GitHubTool {
  return {
    createPullRequest(input) {
      const args = ["pr", "create", "--title", input.title, "--body-file", input.bodyFile];
      if (input.base) {
        args.push("--base", input.base);
      }
      return runQuiet("gh", args, { cwd });
    }
  };
}
