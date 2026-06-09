import { codex, flow, llm, z } from "../src/index.ts";

const BugfixResult = z.object({
  rootCause: z.string(),
  verification: z.array(z.string())
});

await flow(process.argv.slice(2))(async () => {
  const conversation = llm().autonomous(codex(), {
    prompt: "Reproduce the bug, fix the root cause, and report verification.",
    schema: BugfixResult
  });

  console.log(JSON.stringify(await conversation.awaitResult(), null, 2));
});
