---
title: Agent Skills Reference
description: What each bundled skill does and when to use it.
---

| Skill | Trigger | Done when |
| --- | --- | --- |
| `orcats-setup` | Install or verify Orca. | `orcats --version` succeeds and at least one backend is ready or unverified. |
| `orcats-author` | Create a saved workflow or loop. | The artifact is saved, gated, and typechecked when possible. |
| `orcats-flow` | Run or heal a saved artifact. | The run completes or escalates with classification, evidence, and safe next steps. |

## Setup

`orcats-setup` installs or locates the standalone `orcats` binary, asks which backend to enable, runs the bundled doctor, and classifies missing, unauthenticated, or misconfigured CLIs.

## Author

`orcats-author` reads the target repo, detects real test and lint commands, interviews for workflow shape, fills a checked template, and saves either `.orca/workflows/<name>.ts` or `.orca/loops/<name>.ts`.

Mutating artifacts must include verification gates and the shared baseline policy. The default is `repair`; `strict` and `accept-dirty` are explicit overrides via `--baseline=<policy>` or `ORCA_BASELINE_POLICY`.

## Flow

`orcats-flow` runs saved artifacts, watches monitoring JSON, loop state, persistent plans, and git progress, then diagnoses backend failures, baseline repair progress, gate failures, non-convergence, stalls, crashes, and served-child failures. It does not retry with `accept-dirty` unless the operator explicitly asks.
