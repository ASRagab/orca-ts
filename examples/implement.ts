import { codex, flow, llm, z } from "../src/index.ts";

const ImplementationResult = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string())
});

await flow(process.argv.slice(2))(async () => {
  const conversation = llm().autonomous(codex(), {
    prompt: "Implement the requested change and report changed files.",
    schema: ImplementationResult
  });

  const outcome = await conversation.awaitResult();
  console.log(JSON.stringify(outcome, null, 2));
});
