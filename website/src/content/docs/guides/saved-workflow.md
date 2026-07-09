---
title: Saved Workflow
description: Save a reusable one-shot flow under .orca/workflows.
---

Saved one-shot workflows live in the target repository:

```text
.orca/workflows/<name>.ts
```

They are self-executing flow scripts. Run them through the Orcats CLI:

```bash
bunx -p @twelvehart/orcats orcats --backend codex .orca/workflows/my-workflow.ts -- "task input"
```

Use `flowArgs()` for user input:

```ts
import { flow, flowArgs } from "@twelvehart/orcats";

const task = flowArgs().join(" ");

await flow()(async () => {
  if (task.length === 0) {
    throw new Error("Pass a task after --");
  }
});
```

For mutating work, a saved workflow should gate changes with the target repo's real test and lint commands. The `orcats-author` skill refuses to emit an ungated mutating workflow.

Generated mutating workflows default to baseline policy `repair`: they require a clean worktree, run the baseline gates, and repair red gates before the main workflow stage. Use `--baseline=strict` to fail immediately on red baseline gates, or `--baseline=accept-dirty` to explicitly accept a dirty worktree with a snapshot. The helper default is `.orca/baselines/`; commit/sweep templates may use the repo's git dir so snapshots stay out of commits.

```bash
bunx -p @twelvehart/orcats orcats --backend codex .orca/workflows/my-workflow.ts -- --baseline=strict
bunx -p @twelvehart/orcats orcats --backend codex .orca/workflows/my-workflow.ts -- --baseline=accept-dirty
ORCA_BASELINE_POLICY=strict bunx -p @twelvehart/orcats orcats --backend codex .orca/workflows/my-workflow.ts
```

The CLI arg wins over `ORCA_BASELINE_POLICY`. `accept-dirty` records `git status --porcelain=v1`, staged and unstaged diffs, untracked files, and initial gate output before any backend repair turn.

Use a loop module instead when the artifact should be discoverable with `orcats loops`, run with `orcats run`, or served as a long-lived trigger.
