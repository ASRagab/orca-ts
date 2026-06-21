---
title: Saved Workflow
description: Save a reusable one-shot flow under .orca/workflows.
---

Saved one-shot workflows live in the target repository:

```text
.orca/workflows/<name>.ts
```

They are self-executing flow scripts. Run them through the standalone binary:

```bash
orca .orca/workflows/my-workflow.ts --backend codex -- "task input"
```

Use `flowArgs()` for user input:

```ts
import { flow, flowArgs } from "@twelvehart/orca-ts";

const task = flowArgs().join(" ");

await flow()(async () => {
  if (task.length === 0) {
    throw new Error("Pass a task after --");
  }
});
```

For mutating work, a saved workflow should gate changes with the target repo's real test and lint commands. The `orca-ts-author` skill refuses to emit an ungated mutating workflow.

Use a loop module instead when the artifact should be discoverable with `orca loops`, run with `orca run`, or served as a long-lived trigger.
