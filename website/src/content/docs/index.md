---
title: Orcats
description: Deterministic coding-agent flows, loops, and saved automation in TypeScript.
---

Orcats lets you express coding-agent work as a direct-style TypeScript flow instead of a one-off prompt. A flow chooses a backend, runs autonomous conversations, uses filesystem and git helpers, persists plans, and reports structured outcomes.

Use Orcats when you want repeatable automation around a coding agent: implement a task, review the change, run gates, recover after a crash, or package the same workflow for another repository.

## Start paths

- New to Orcats: read the [quickstart](start/quickstart/), then the [concepts](start/concepts/).
- Installing for local use: start with the [npm package](install/typed-authoring/).
- Need one executable with no project setup: use the [standalone binary](install/binary/).
- Creating reusable automations in another repo: install the [Agent Skills](install/agent-skills/).
- Building repeatable work: start with [flows](guides/first-flow/) or [loops](guides/loops/).

## What Orcats gives you

| Need | Orca surface |
| --- | --- |
| Run one autonomous coding-agent task | flow + backend adapter |
| Honor a backend chosen at runtime | `selectBackend()` + `--backend` |
| Read task input passed after `--` | `flowArgs()` |
| Repeat until a measured state converges | `loop()` presets and guards |
| Package a loop for discovery and serving | `defineLoop()` + `orcats run` / `orcats serve` |
| Recover long work | persistent plans and loop state stores |
| Install in any git-backed repo | Orcats CLI + Agent Skills |

## Supported boundaries

The current package version is `0.2.3`. The normal install path is `npm i @twelvehart/orcats`.

Supported live backend tags are `claude`, `codex`, `opencode`, and `pi`. Snapshot and sqlite loop state stores are available.
