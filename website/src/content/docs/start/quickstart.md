---
title: Quickstart
description: Install Orca, write a first flow, and run it with a backend.
---

## Requirements

- Bun `>=1.3.0` for source development or typed project authoring.
- Git.
- At least one configured backend CLI when running live flows: Claude, Codex, OpenCode, or Pi.

## Install the binary

```bash
curl -fsSL https://raw.githubusercontent.com/ASRagab/orca-ts/main/install.sh | bash
orca --version
```

Pin a release or install directory when needed:

```bash
ORCA_VERSION=0.1.0 ORCA_INSTALL_DIR="$HOME/.local/bin" \
  bash <(curl -fsSL https://raw.githubusercontent.com/ASRagab/orca-ts/main/install.sh)
```

## Write `hello.ts`

```ts
import { flow, llm, selectBackend } from "orca-ts";

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
orca --backend claude hello.ts
```

`--backend` sets `ORCA_BACKEND`. A flow that calls `selectBackend()` honors it. A flow that calls `claude()`, `codex()`, `opencode()`, or `pi()` directly pins that backend.

## Next

- [Install paths](../install/binary.md)
- [Core concepts](concepts.md)
- [First flow guide](../guides/first-flow.md)
- [Backend setup](../guides/backend-setup.md)
