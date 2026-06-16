import { type Result } from "neverthrow";
import { z } from "zod";
import { parseStructuredOutput, type RuntimeError } from "../../model/index.ts";

// The loop manifest is runtime state (design D4) — the "Ralph" pattern. It is the
// single spine for progress, the termination variant, and the monitor stream, all
// projected from the same pass-flags. It does NOT replace `.orca/plan-<hash>.md`,
// which remains the human plan artifact recovered by the plans-and-review APIs.

/** A single atomic subtask; `passes` is the progress flag flipped by the loop. */
export const ManifestTaskSchema = z.object({
  id: z.string(),
  passes: z.boolean()
});

/** Typed loop manifest — the single progress/variant/monitor spine. */
export const TaskManifestSchema = z.object({
  tasks: z.array(ManifestTaskSchema)
});

export type ManifestTask = z.infer<typeof ManifestTaskSchema>;
export type TaskManifest = z.infer<typeof TaskManifestSchema>;

/** Validate raw state against the manifest schema each cycle; a validation
 * failure surfaces as `err(RuntimeError)` (`StructuredOutputValidationFailed`). */
export function parseManifest(raw: unknown): Result<TaskManifest, RuntimeError> {
  return parseStructuredOutput(TaskManifestSchema, raw).map((parsed) => parsed.value);
}

/** The single shared projection: count of tasks not yet passing. The termination
 * variant, reported progress, and the monitor signal all read this one value, so
 * they always reflect the same number. */
export function measure(manifest: TaskManifest): number {
  return manifest.tasks.reduce((pending, task) => (task.passes ? pending : pending + 1), 0);
}

export interface ManifestProgress {
  readonly total: number;
  readonly passed: number;
  readonly pending: number;
  /** Fraction of tasks passing in `[0, 1]`; `1` for an empty manifest. */
  readonly ratio: number;
}

/** Progress report derived from {@link measure} so it cannot drift from the variant. */
export function progress(manifest: TaskManifest): ManifestProgress {
  const total = manifest.tasks.length;
  const pending = measure(manifest);
  const passed = total - pending;
  return { total, passed, pending, ratio: total === 0 ? 1 : passed / total };
}

/** Termination predicate: the manifest is complete when nothing is pending. */
export function isComplete(manifest: TaskManifest): boolean {
  return measure(manifest) === 0;
}
