import { createHash } from "node:crypto";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import { createFsTool, type FsTool } from "../tools/index.ts";

export interface PlanTask {
  readonly id: string;
  readonly description: string;
}

export interface PlanLoopResult {
  readonly completed: readonly string[];
}

export function planHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

export function defaultPlanPath(root: string, input: string): string {
  return join(root, ".orca", `plan-${planHash(input)}.md`);
}

export async function writePlan(
  root: string,
  input: string,
  content: string,
  fsTool: FsTool = createFsTool()
): Promise<Result<string, RuntimeError>> {
  const path = defaultPlanPath(root, input);
  const written = await fsTool.writeText(path, content);
  return written.map(() => path);
}

export async function recoverPlan(
  path: string,
  fsTool: FsTool = createFsTool()
): Promise<Result<string, RuntimeError>> {
  return await fsTool.readText(path);
}

export async function implementTaskLoop(
  tasks: readonly PlanTask[],
  implement: (task: PlanTask) => Promise<Result<void, RuntimeError>>
): Promise<Result<PlanLoopResult, RuntimeError>> {
  const completed: string[] = [];

  for (const task of tasks) {
    const result = await implement(task);
    if (result.isErr()) {
      return err(result.error);
    }
    completed.push(task.id);
  }

  return ok({ completed });
}
