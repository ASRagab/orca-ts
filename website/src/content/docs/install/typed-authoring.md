---
title: NPM Package
description: Install Orcats from npm for local flow authoring and CLI use.
---

Use the npm package when you are writing and versioning flows in a project.

Install the package and, when you want editor feedback, TypeScript:

```bash
npm i @twelvehart/orcats
npm i -D typescript
bunx -p @twelvehart/orcats orcats --version
```

Bun `>=1.3.0` must be on `PATH`. The npm package's POSIX `orcats` launcher
clears ambient `BUN_OPTIONS` before entering Bun.

Flow files import from the public package surface:

```ts
import { flow, flowArgs, llm, selectBackend } from "@twelvehart/orcats";
```

Run a flow with:

```bash
bunx -p @twelvehart/orcats orcats --backend codex .orca/workflows/my-flow.ts -- "task input"
```

Check a workflow or import-safe loop without running it:

```bash
bunx -p @twelvehart/orcats orcats check .orca/workflows/my-flow.ts
```

The checker is self-contained and offline; target-repository TypeScript setup is
not required.

Read task input through `flowArgs()`:

```ts
import { flowArgs } from "@twelvehart/orcats";

const args = flowArgs();
```

Do not read task input from `process.argv`; the CLI also uses argv for the flow path and flags.

Use the [standalone binary](../binary/) only when you need an `orcats` executable that can run without a local `node_modules` install.
