# Orca TypeScript Context

Orca TypeScript is a workflow runner for deterministic coding-agent work. This context names the project concepts that should anchor architecture discussions and documentation.

## Language

**Flow**:
A direct-style TypeScript program that orchestrates coding-agent work through Orca runtime primitives.
_Avoid_: pipeline, job, command suite

**Flow context**:
The ambient runtime scope that provides a flow with filesystem, git, GitHub, terminal, command, LLM, plan, and review capabilities.
_Avoid_: global services, dependency bag

**Conversation**:
The normalized event stream and final outcome produced by a backend adapter.
_Avoid_: chat session, transcript

**Backend adapter**:
A concrete adapter that maps a coding-agent transport into the shared Conversation model.
_Avoid_: agent wrapper, provider client

**Conversation harness**:
The runtime module that captures a backend adapter's Conversation events and final outcome for tests and reusable backend flows.
_Avoid_: fixture helper, parser test wrapper

**Codex child run**:
One Codex backend execution, including config resolution, prompt composition, process lifecycle, structured output schema handling, interactive ask_user bridging, stream consumption, and cleanup.
_Avoid_: Codex call, subprocess wrapper

**Review module**:
The flow authoring module that selects reviewer prompts, runs review turns, applies fixable findings, and reports review-loop events.
_Avoid_: review helper, reviewer list

**Persistent plan**:
A replayable plan artifact stored under `.orca/` from deterministic input so multi-task flows can recover progress.
_Avoid_: scratch plan, task list
