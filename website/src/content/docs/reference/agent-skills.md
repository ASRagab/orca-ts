---
title: Agent Skills Reference
description: What each bundled skill does and when to use it.
---

| Skill | Trigger | Done when |
| --- | --- | --- |
| `orcats-setup` | Install or verify Orca. | `orcats --version` succeeds and at least one selected backend transport completes a consent-gated readiness turn. |
| `orcats-author` | Create a saved workflow or loop. | The artifact is saved, gated, and passes offline `orcats check`. |
| `orcats-flow` | Run or heal a saved artifact. | The run completes or escalates with classification, evidence, and safe next steps. |

## Installation command

`orcats skills [--list] [--skill <name>|--all] [--agent <name>] [--global] [--yes]`
delegates to `npx skills add ASRagab/orca-ts`. It requires Node.js/npm, keeps
the installer interactive when no selection is provided, and does not own
agent-directory placement, updates, or removal. See the
[installation guide](../../install/agent-skills/) for examples and direct
`npx skills` fallback commands.

## Setup

`orcats-setup` installs or locates `orcats`, asks which backends to enable, and
reports CLI presence, static auth evidence, selected transport, and transport
readiness separately. Static checks remain `unverified`. Setup asks before a
bounded live turn because it spends tokens, and does not finish until at least
one selected transport proves usable.

## Author

`orcats-author` reads the target repo, detects real test and lint commands,
interviews for workflow shape, fills a checked template, and saves either
`.orca/workflows/<name>.ts` or `.orca/loops/<name>.ts`. It always runs the
self-contained `orcats check`, including in non-TypeScript repositories.

Mutating artifacts must include verification gates and the shared baseline policy. The default is `repair`; `strict` and `accept-dirty` are explicit overrides via `--baseline=<policy>` or `ORCA_BASELINE_POLICY`.

## Flow

`orcats-flow` uses stderr/heartbeat, loop state, persistent plans, and Git as
live progress signals. Terminal monitoring JSON is the durable authoritative
final result; its status and error win over wrapper echo text. Recovery stays on
the selected backend transport unless the operator explicitly changes it. It
does not retry with `accept-dirty` unless the operator asks.
