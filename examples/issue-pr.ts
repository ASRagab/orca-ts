import { codex, flow, gh, llm, z } from "../src/index.ts";

const PullRequestSummary = z.object({
  title: z.string(),
  bodyFile: z.string()
});

await flow(process.argv.slice(2))(async () => {
  const conversation = llm().autonomous(codex(), {
    prompt: "Implement the issue and produce a pull request summary.",
    schema: PullRequestSummary
  });
  const outcome = await conversation.awaitResult();

  if (outcome.type === "success" && outcome.result.structured) {
    const summary = PullRequestSummary.parse(outcome.result.structured);
    await gh().createPullRequest(summary);
  }
});
