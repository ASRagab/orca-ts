import { AsyncLocalStorage } from "node:async_hooks";
import { unsupportedFeature } from "../model/index.ts";
import { createFsTool, type FsTool } from "../tools/fs.ts";
import { createGitTool, type GitTool } from "../tools/git.ts";
import { createGitHubTool, type GitHubTool } from "../tools/github.ts";
import { createTerminalTool, type TerminalTool } from "../tools/terminal.ts";
import type { LlmTool } from "../backends/index.ts";
import {
  defaultPlanPath,
  implementTaskLoop,
  recoverPlan,
  writePlan
} from "../plan/index.ts";

export interface PlanTool {
  readonly defaultPath: typeof defaultPlanPath;
  readonly write: typeof writePlan;
  readonly recover: typeof recoverPlan;
  readonly implementTaskLoop: typeof implementTaskLoop;
  interactive(): never;
}

export interface ReviewTool {
  readonly reviewers: readonly string[];
}

export interface FlowContext {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly fs: FsTool;
  readonly git: GitTool;
  readonly gh: GitHubTool;
  readonly terminal: TerminalTool;
  readonly llm: LlmTool;
  readonly plan: PlanTool;
  readonly review: ReviewTool;
}

export type FlowOverrides = Partial<Omit<FlowContext, "args">>;

const storage = new AsyncLocalStorage<FlowContext>();

export function flow<T>(
  args: readonly string[] = [],
  overrides: FlowOverrides = {}
): (fn: () => Promise<T> | T) => Promise<T> {
  const context = createDefaultFlowContext(args, overrides);
  return async (fn) => await storage.run(context, async () => await fn());
}

export function currentFlowContext(): FlowContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error("No active Orca flow context");
  }
  return context;
}

export function createDefaultFlowContext(
  args: readonly string[],
  overrides: FlowOverrides = {}
): FlowContext {
  const cwd = overrides.cwd ?? process.cwd();

  return {
    args,
    cwd,
    fs: overrides.fs ?? createFsTool(),
    git: overrides.git ?? createGitTool(cwd),
    gh: overrides.gh ?? createGitHubTool(cwd),
    terminal: overrides.terminal ?? createTerminalTool(),
    llm: overrides.llm ?? createDefaultLlmTool(),
    plan: overrides.plan ?? createDefaultPlanTool(),
    review: overrides.review ?? { reviewers: [] }
  };
}

function createDefaultLlmTool(): LlmTool {
  return {
    autonomous(backend, request) {
      return backend.autonomous(request);
    }
  };
}

function createDefaultPlanTool(): PlanTool {
  return {
    defaultPath: defaultPlanPath,
    write: writePlan,
    recover: recoverPlan,
    implementTaskLoop,
    interactive() {
      throw unsupportedFeature(
        "Plan.interactive",
        "Interactive planning is intentionally unsupported in v1"
      );
    }
  };
}
