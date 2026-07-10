---
title: Overview
description: What Orcats is for and where to start.
---

Orcats is a workflow runner for deterministic coding-agent work.

Write a TypeScript flow, choose a backend such as Claude, Codex, OpenCode, or Pi, and let Orcats provide the runtime pieces around it: a flow context, normalized conversation results, filesystem and git helpers, persistent plans, review loops, and a CLI runner.

Start with the [quickstart](../quickstart/) if you want to run a flow. Start with [Agent Skills](../../install/agent-skills/) if you want a coding agent to author and run a saved workflow for another repository.

## Supported boundaries

- Package version: `0.2.3`.
- Normal install: `npm i @twelvehart/orcats`.
- Optional standalone install: GitHub Release binary.
- Supported backend tags: `claude`, `codex`, `opencode`, and `pi`.
- Durable loop state: snapshot and sqlite stores.
