import { createHash } from "node:crypto";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { RuntimeError } from "../model/index.ts";
import { fixLoop, type FixLoopAction } from "../review/index.ts";
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

const IMPLEMENT_TASK_ACTION: FixLoopAction = { identity: "implement-task", inputs: null };

/** Sequential-task `.until()` strategy over the generic {@link fixLoop} (design D7):
 * drive the pending-task count to zero, implementing one task per cycle and
 * stopping at the first typed failure. */
export async function sequentialTaskStrategy(
  tasks: readonly PlanTask[],
  implement: (task: PlanTask) => Promise<Result<void, RuntimeError>>
): Promise<Result<PlanLoopResult, RuntimeError>> {
  const completed: string[] = [];
  let index = 0;

  const loop = await fixLoop<{ readonly pending: number }>({
    evaluate: () => Promise.resolve(ok({ pending: tasks.length - index })),
    converged: (state) => state.pending === 0,
    nextAction: (state) => (state.pending === 0 ? undefined : IMPLEMENT_TASK_ACTION),
    fix: async () => {
      const task = tasks[index];
      if (task === undefined) {
        return ok({});
      }
      const result = await implement(task);
      if (result.isErr()) {
        return err(result.error);
      }
      completed.push(task.id);
      index += 1;
      return ok({});
    },
    fingerprint: false,
    maxIterations: Math.max(tasks.length, 1),
  });

  if (loop.isErr()) {
    return err(loop.error);
  }
  return ok({ completed });
}

/** Deprecated compatibility wrapper kept for one release (design D7): delegates to
 * `sequentialTaskStrategy` and emits a runtime DeprecationWarning. Not tagged
 * `@deprecated` so existing callers still using it for this release stay lint-clean. */
export function implementTaskLoop(
  tasks: readonly PlanTask[],
  implement: (task: PlanTask) => Promise<Result<void, RuntimeError>>
): Promise<Result<PlanLoopResult, RuntimeError>> {
  emitDeprecation("implementTaskLoop", "sequentialTaskStrategy");
  return sequentialTaskStrategy(tasks, implement);
}

function emitDeprecation(name: string, replacement: string): void {
  process.emitWarning(
    `${name}() is deprecated and will be removed in a future release; migrate to ${replacement}().`,
    { type: "DeprecationWarning", code: "ORCA_DEP_LOOP_COLLAPSE" }
  );
}
