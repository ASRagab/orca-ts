---
title: Quickstart
description: Install Orcats, write a first flow, and run it with a backend.
---

## Requirements

- Bun `>=1.3.0` for source development or typed project authoring.
- Git.
- At least one configured backend CLI when running live flows: Claude, Codex, OpenCode, or Pi.

## Install Orcats

```bash
npm i @twelvehart/orcats
npm i -D typescript
bunx -p @twelvehart/orcats orcats --version
```

`typescript` enables editor feedback and the CLI typecheck preflight. Bun `>=1.3.0` must be on `PATH` because the npm CLI shim runs with Bun.

## Write `hello.ts`

```ts
import { flow, llm, selectBackend } from "@twelvehart/orcats";

await flow()(async () => {
  const selected = selectBackend({ default: "claude" });
  try {
    const conversation = llm().autonomous(selected.backend, {
      prompt: "Say hello from an autonomous Orca flow."
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

## Run the flow

```bash
bunx -p @twelvehart/orcats orcats --backend claude hello.ts
```

`--backend` sets `ORCA_BACKEND`. A flow that calls `selectBackend()` honors it. A flow that calls `claude()`, `codex()`, `opencode()`, or `pi()` directly pins that backend.

## Next

- [Package install](../../install/typed-authoring/)
- [Standalone binary](../../install/binary/)
- [Core concepts](../concepts/)
- [First flow guide](../../guides/first-flow/)
- [Backend setup](../../guides/backend-setup/)
