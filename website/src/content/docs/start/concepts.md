---
title: Concepts
description: The vocabulary Orca uses for flows, conversations, backends, plans, and loops.
---

## Flow

A flow is a direct-style TypeScript program that orchestrates coding-agent work through Orca runtime primitives. Prefer "flow" over pipeline, job, or command suite.

## Flow context

The flow context is the ambient runtime scope that provides filesystem, git, GitHub, terminal, command, LLM, plan, and review capabilities.

## Conversation

A conversation is the normalized event stream and final outcome produced by a backend adapter. Backend-specific transport details stay behind that adapter.

## Backend adapter

A backend adapter maps a coding-agent CLI or service into the shared conversation model. The supported live backend constructors are `claude()`, `codex()`, `opencode()`, and `pi()`.

## Persistent plan

A persistent plan is a replayable plan artifact stored under `.orca/plan-<hash>.md`. It lets long-running task flows recover progress after an interruption.

## Loop

A loop is a flow that repeats a cycle until a measurable state says the work is done. Loops use presets such as `untilGatesGreen()`, `untilManifestComplete()`, `untilNoIssues()`, `untilConfident(threshold)`, and `times(n)`.

## Loop module

A loop module is an import-safe file under `.orca/loops/` that exports `defineLoop({ name, source, sink, onTrigger })`. Orca can list, run, or serve it without treating it as a self-executing script.
