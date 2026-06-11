import { backendFailed, codex, fixLoop, flow, implementTaskLoop, llm, z } from "../src/index.ts";
import { err, ok } from "neverthrow";

const PlanSchema = z.object({
  tasks: z.array(z.object({ id: z.string(), description: z.string() }))
});

const ReviewSchema = z.object({
  issues: z.array(z.object({ message: z.string(), fixable: z.boolean() }))
});

await flow(process.argv.slice(2))(async () => {
  const planConv = llm().autonomous(codex(), {
    prompt: "Analyze the repository and produce a deterministic implementation plan as JSON.",
    schema: PlanSchema,
  });
  const planOutcome = await planConv.awaitResult();
  if (planOutcome.type !== "success") throw new Error(`Planning failed: ${planOutcome.type}`);
  const { tasks } = planOutcome.result.structured as z.infer<typeof PlanSchema>;

  const result = await implementTaskLoop(tasks, async (task) => {
    const implConv = llm().autonomous(codex(), { prompt: `Implement task: ${task.description}` });
    const implOutcome = await implConv.awaitResult();
    if (implOutcome.type !== "success")
      return err(backendFailed("codex", `Task ${task.id} failed: ${implOutcome.type}`));

    const loopResult = await fixLoop(
      async () => {
        const reviewConv = llm().autonomous(codex(), {
          prompt: `Review changes for task "${task.description}". Return JSON issues.`,
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

  console.log(JSON.stringify(result._unsafeUnwrap(), null, 2));
});
