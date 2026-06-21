---
title: First Flow
description: Build a copyable autonomous flow that selects a backend at run time.
---

Create `hello.ts`:

```ts
import { flow, llm, selectBackend } from "@twelvehart/orca-ts";

await flow()(async () => {
  const selected = selectBackend({
    default: "codex",
    perBackend: {
      codex: { approvalPolicy: "never" },
      opencode: { model: "openai/gpt-5.5" }
    }
  });

  try {
    const conversation = llm().autonomous(selected.backend, {
      prompt: "Inspect the repository and summarize the test command."
    });

    const outcome = await conversation.awaitResult();
    if (outcome.type !== "success") {
      throw new Error(`Backend failed with outcome: ${outcome.type}`);
    }

    console.log(outcome.result.output);
  } finally {
    await selected.shutdown?.();
  }
});
```

Run it:

```bash
orca --backend codex hello.ts
```

`selectBackend()` lets the CLI select the backend through `ORCA_BACKEND`. `ORCA_BACKEND_MODEL` overrides the configured model for the selected backend.

Use `selected.shutdown?.()` in a `finally` because OpenCode owns a managed `opencode serve` process.
