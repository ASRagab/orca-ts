---
title: Agent Skills Reference
description: What each bundled skill does and when to use it.
---

| Skill | Trigger | Done when |
| --- | --- | --- |
| `orca-ts-setup` | Install or verify Orca. | `orca --version` succeeds and at least one backend is ready or unverified. |
| `orca-ts-author` | Create a saved workflow or loop. | The artifact is saved, gated, and typechecked when possible. |
| `orca-ts-flow` | Run or heal a saved artifact. | The run completes or escalates with classification, evidence, and safe next steps. |

## Setup

`orca-ts-setup` installs or locates the standalone `orca` binary, asks which backend to enable, runs the bundled doctor, and classifies missing, unauthenticated, or misconfigured CLIs.

## Author

`orca-ts-author` reads the target repo, detects real test and lint commands, interviews for workflow shape, fills a checked template, and saves either `.orca/workflows/<name>.ts` or `.orca/loops/<name>.ts`.

Mutating artifacts must include verification gates and the shared baseline policy. The default is `repair`; `strict` and `accept-dirty` are explicit overrides via `--baseline=<policy>` or `ORCA_BASELINE_POLICY`.

## Flow

`orca-ts-flow` runs saved artifacts, watches monitoring JSON, loop state, persistent plans, and git progress, then diagnoses backend failures, baseline repair progress, gate failures, non-convergence, stalls, crashes, and served-child failures. It does not retry with `accept-dirty` unless the operator explicitly asks.
