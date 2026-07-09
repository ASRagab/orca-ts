---
title: Examples
description: Checked examples and what each one demonstrates.
---

| Example | Demonstrates |
| --- | --- |
| `examples/implement.ts` | Plan, implement, review, and fix shape. |
| `examples/implement-enhanced.ts` | Larger implementation-loop shape. |
| `examples/issue-pr.ts` | Issue-to-PR workflow. |
| `examples/issue-pr-bugfix.ts` | Bugfix-oriented issue workflow. |
| `examples/multi-backend-compare.ts` | Comparing backend behavior. |
| `examples/epic.ts` | Structured output with a Zod schema. |
| `examples/loop-single-cycle.ts` | Single-cycle preset loop. |
| `examples/loop-gated-task.ts` | Gate-converging loop with `untilGatesGreen()`. |
| `examples/loop-fanout.ts` | Fan-out and fan-in with bounded concurrency. |
| `examples/loop-persisted-state.ts` | Snapshot store checkpoint, history, branch, and merge. |
| `examples/loop-served-trigger.ts` | Import-safe `defineLoop()` module. |
| `examples/linear-ticket-triage.ts` | Linear ticket source, progress comment, triage loop, final update, optional Slack. |

Inside this repository, examples may import from local source paths. Package consumers should import from `@twelvehart/orcats`.
