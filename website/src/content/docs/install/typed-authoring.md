---
title: Typed Authoring
description: Set up a project that typechecks flow files against Orca.
---

Use typed authoring when you are writing and versioning flows in a project.

Until npm publishing is restored, install the library from Git and run flows with the standalone `orca` binary:

```bash
bun add -d git+https://github.com/ASRagab/orca-ts.git typescript
orca --version
```

Flow files import from the public package surface:

```ts
import { flow, flowArgs, llm, selectBackend } from "orca-ts";
```

Run a flow with:

```bash
orca --backend codex .orca/workflows/my-flow.ts -- "task input"
```

Read task input through `flowArgs()`:

```ts
import { flowArgs } from "orca-ts";

const args = flowArgs();
```

Do not read task input from `process.argv`; the CLI also uses argv for the flow path and flags.
