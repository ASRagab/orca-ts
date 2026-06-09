import { claude, flow, llm } from "../../../src/index.ts";

await flow()(async () => {
  const conversation = llm().autonomous(claude(), {
    prompt: "Say hello from an autonomous Orca flow."
  });
  console.log(JSON.stringify(await conversation.awaitResult(), null, 2));
});
