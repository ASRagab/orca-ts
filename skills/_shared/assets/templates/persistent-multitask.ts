// Archetype: persistent-multitask (the canonical "defaults" archetype)
// Plan -> persist the plan under .orca/ -> implement each task with a per-task
// verification gate (the target repo's test + lint) that repairs until green.
// Each converged task is checked off in the persisted plan, so a crash or
// re-run resumes from real progress instead of re-running completed work.
//
// SLOTS the author skill fills:
//   - OBJECTIVE : the high-level goal to decompose into tasks
//   - GATE      : detected target-repo verification commands (>=1 test, >=1 lint)
//   - default backend
import {
  backendFailed,
  command,
  defaultPlanPath,
  err,
  fixLoop,
  flow,
  flowArgs,
  implementTaskLoop,
  llm,
  ok,
  recoverPlan,
  selectBackend,
  writePlan,
  z,
  type PlanTask,
} from "orca-ts";

interface Cmd {
  readonly command: string;
  readonly args: readonly string[];
}

// A plan task plus its persisted completion state.
interface TrackedTask extends PlanTask {
  done: boolean;
}

// ── VERIFICATION GATE — replace with THIS repo's real commands ──────────────
const GATE: readonly Cmd[] = [
  { command: "REPLACE_WITH_TEST_CMD", args: [] },
  { command: "REPLACE_WITH_LINT_CMD", args: [] },
];

const OBJECTIVE = "REPLACE_WITH_OBJECTIVE";

const PlanSchema = z.object({
  tasks: z.array(z.object({ id: z.string(), description: z.string() })),
});

interface GateIssue {
  readonly message: string;
  readonly fixable: true;
}

await flow(flowArgs())(async () => {
  const selected = selectBackend({ default: "claude" });
  const cwd = process.cwd();
  const planPath = defaultPlanPath(cwd, OBJECTIVE);

  try {
    const tasks = await loadOrPlanTasks(selected.backend, cwd);
    const pending = tasks.filter((task) => !task.done);
    console.log(
      `Plan: ${String(tasks.length)} task(s), ${String(pending.length)} pending -> ${planPath}`,
    );

    const result = await implementTaskLoop(pending, async (task) => {
      console.log(`▶ ${task.id}: ${task.description}`);
      const impl = await llm()
        .autonomous(selected.backend, { prompt: `Implement this task:\n${task.description}` })
        .awaitResult();
      if (impl.type !== "success") {
        return err(backendFailed(selected.tag, `${task.id} implementation failed: ${impl.type}`));
      }

      const seen = new Set<string>();
      const loop = await fixLoop<GateIssue>(
        async () => {
          const failure = await runGate(GATE);
          return ok(failure ? [{ message: failure, fixable: true as const }] : []);
        },
        async (issues) => {
          const repair = await llm()
            .autonomous(selected.backend, {
              prompt: `Task "${task.description}" failed the gate:\n${issues
                .map((i) => i.message)
                .join("\n")}\nFix it without weakening the gate.`,
            })
            .awaitResult();
          if (repair.type !== "success") throw new Error(`repair failed: ${repair.type}`);
          return ok(undefined);
        },
        { maxIterations: 8, wallClockMs: 10 * 60_000, stalled: (i) => stalled(seen, i) },
      );

      if (loop.isErr() || !loop.value.converged) {
        const why = loop.isErr() ? JSON.stringify(loop.error) : loop.value.stop;
        return err(backendFailed(selected.tag, `${task.id} did not converge: ${why}`));
      }

      // Persist progress: check this task off so a crash/re-run skips it.
      markDone(tasks, task.id);
      const written = await writePlan(cwd, OBJECTIVE, renderPlanMarkdown(tasks));
      if (written.isErr()) {
        return err(backendFailed(selected.tag, `failed to persist plan: ${JSON.stringify(written.error)}`));
      }
      return ok(undefined);
    });

    if (result.isErr()) throw new Error(`task loop failed: ${JSON.stringify(result.error)}`);
    const completed = tasks.filter((task) => task.done).length;
    console.log(
      `Completed ${String(result.value.completed.length)} task(s) this run; ${String(completed)}/${String(tasks.length)} total.`,
    );
  } finally {
    await selected.shutdown?.();
  }
});

async function loadOrPlanTasks(
  backend: ReturnType<typeof selectBackend>["backend"],
  cwd: string,
): Promise<TrackedTask[]> {
  const recovered = await recoverPlan(defaultPlanPath(cwd, OBJECTIVE));
  if (recovered.isOk()) {
    const parsed = parsePlanMarkdown(recovered.value);
    if (parsed.length > 0) return parsed;
  }

  const outcome = await llm()
    .autonomous(backend, {
      prompt: `Produce a deterministic implementation plan for this objective as JSON:\n${OBJECTIVE}`,
      schema: PlanSchema,
    })
    .awaitResult();
  if (outcome.type !== "success" || !outcome.result.structured) {
    throw new Error(`planning failed: ${outcome.type}`);
  }
  const { tasks } = PlanSchema.parse(outcome.result.structured);
  const tracked: TrackedTask[] = tasks.map((t) => ({ ...t, done: false }));
  await writePlan(cwd, OBJECTIVE, renderPlanMarkdown(tracked));
  return tracked;
}

function markDone(tasks: TrackedTask[], id: string): void {
  const task = tasks.find((t) => t.id === id);
  if (task) task.done = true;
}

function renderPlanMarkdown(tasks: readonly TrackedTask[]): string {
  return [
    "# Plan",
    "",
    ...tasks.map((t) => `- [${t.done ? "x" : " "}] ${t.id}: ${t.description}`),
    "",
  ].join("\n");
}

function parsePlanMarkdown(markdown: string): TrackedTask[] {
  const tasks: TrackedTask[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^- \[([ x])\] ([^:]+): (.+)$/.exec(line.trim());
    if (match?.[2] && match[3]) {
      tasks.push({ id: match[2].trim(), description: match[3].trim(), done: match[1] === "x" });
    }
  }
  return tasks;
}

async function runGate(commands: readonly Cmd[]): Promise<string | undefined> {
  for (const c of commands) {
    const result = await command().run({ command: c.command, args: c.args });
    if (result.type !== "success") return `${c.command} ${c.args.join(" ")}\n${result.stderr || result.stdout}`;
  }
  return undefined;
}

function stalled(seen: Set<string>, issues: readonly GateIssue[]): boolean {
  const signature = issues
    .map((i) => i.message.replace(/\d+/g, "#").replace(/\/[^\s:]+/g, "/PATH"))
    .sort()
    .join("\n");
  if (seen.has(signature)) return true;
  seen.add(signature);
  return false;
}
