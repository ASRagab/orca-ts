import { flow, llm, selectBackend } from "../../../src/index.ts";

await flow()(async () => {
  const selected = selectBackend({ default: "claude" });
  try {
    const conversation = llm().autonomous(selected.backend, {
      prompt: "Say hello from an autonomous Orca flow."
    });
    console.log(JSON.stringify(await conversation.awaitResult(), null, 2));
  } finally {
    await selected.shutdown?.();
  }
});
