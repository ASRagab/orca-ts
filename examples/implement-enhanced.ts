import { claude, flow, llm, plan, terminal, z } from "../src/index.ts";

const PlanResult = z.object({
  tasks: z.array(z.object({ id: z.string(), description: z.string() }))
});

await flow(process.argv.slice(2))(async () => {
  const prompt = "Assess the repository, create a deterministic implementation plan, and return tasks.";
  const path = plan().defaultPath(process.cwd(), prompt);
  terminal().emit({ type: "step", name: "plan", status: "started" });

  const conversation = llm().autonomous(claude(), { prompt, schema: PlanResult });
  const outcome = await conversation.awaitResult();

  await plan().write(process.cwd(), prompt, `# Plan\n\nPersisted at ${path}\n`);
  terminal().emit({ type: "step", name: "plan", status: outcome.type === "success" ? "completed" : "failed" });
});
