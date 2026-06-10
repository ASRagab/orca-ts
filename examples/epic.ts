import { codex, flow, llm, z } from "../src/index.ts";

const EpicResult = z.object({
  issues: z.array(z.object({ title: z.string(), body: z.string() }))
});

await flow(process.argv.slice(2))(async () => {
  const conversation = llm().autonomous(codex(), {
    prompt: "Break this epic into implementation issues.",
    schema: EpicResult
  });

  console.log(JSON.stringify(await conversation.awaitResult(), null, 2));
});
