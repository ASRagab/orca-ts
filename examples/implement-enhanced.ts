import { backendFailed, codex, fixLoop, flow, implementTaskLoop, llm, plan, terminal, z } from "../src/index.ts";
import { err, ok } from "neverthrow";
import type { Verdict } from "../src/index.ts";

const PlanSchema = z.object({
  tasks: z.array(z.object({ id: z.string(), description: z.string() }))
});

const ReviewSchema = z.object({
  issues: z.array(z.object({ message: z.string(), fixable: z.boolean() }))
});

const PlanVerdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proceed"), value: PlanSchema }),
  z.object({ kind: z.literal("rejection"), category: z.enum(["question", "critique", "rebuff"]), body: z.string() }),
]);

await flow(process.argv.slice(2))(async () => {
  const prompt = "Assess the repository, produce a deterministic implementation plan, and return a Verdict.";
  const planPath = plan().defaultPath(process.cwd(), prompt);

  terminal().emit({ type: "step", name: "assess", status: "started" });
  const assessConv = llm().autonomous(codex(), { prompt, schema: PlanVerdictSchema });
  const assessOutcome = await assessConv.awaitResult();
  terminal().emit({ type: "step", name: "assess", status: assessOutcome.type === "success" ? "completed" : "failed" });

  if (assessOutcome.type !== "success") throw new Error(`Assessment failed: ${assessOutcome.type}`);
  const verdict = assessOutcome.result.structured as Verdict<z.infer<typeof PlanSchema>>;

  if (verdict.kind === "rejection") {
    throw new Error(`Plan rejected (${verdict.category}): ${verdict.body}`);
  }

  const { tasks } = verdict.value;
  await plan().write(process.cwd(), prompt, `# Plan\n\nPersisted at ${planPath}\n`);

  terminal().emit({ type: "step", name: "implement", status: "started" });
  const result = await implementTaskLoop(tasks, async (task) => {
    const implConv = llm().autonomous(codex(), { prompt: `Implement task: ${task.description}` });
    const implOutcome = await implConv.awaitResult();
    if (implOutcome.type !== "success")
      return err(backendFailed("codex", `Task ${task.id} failed`));

    const loopResult = await fixLoop(
      async () => {
        const reviewConv = llm().autonomous(codex(), {
          prompt: `Review changes for "${task.description}". Return JSON issues.`,
          schema: ReviewSchema,
        });
        const reviewOutcome = await reviewConv.awaitResult();
        if (reviewOutcome.type !== "success")
          return err(backendFailed("codex", "Review failed"));
        const { issues } = reviewOutcome.result.structured as z.infer<typeof ReviewSchema>;
        return ok(issues.map((i) => ({ reviewer: "code-functionality" as const, ...i })));
      },
      async (issues) => {
        const fixConv = llm().autonomous(codex(), {
          prompt: `Fix these issues:\n${issues.map((i) => `- ${i.message}`).join("\n")}`,
        });
        const fixOutcome = await fixConv.awaitResult();
        if (fixOutcome.type !== "success")
          return err(backendFailed("codex", "Fix failed"));
        return ok(undefined);
      },
    );

    if (loopResult.isErr()) return err(loopResult.error);
    return ok(undefined);
  });

  terminal().emit({ type: "step", name: "implement", status: result.isOk() ? "completed" : "failed" });
  console.log(JSON.stringify(result._unsafeUnwrap(), null, 2));
});
