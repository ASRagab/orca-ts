## ADDED Requirements

### Requirement: Canonical loop guide covers tutorial, reference, and operations

The system SHALL provide a canonical loop guide that teaches users how to build,
run, serve, troubleshoot, and migrate Orca loops.

#### Scenario: New user follows first-loop tutorial
- **WHEN** a user starts from the loop guide with no prior loop-builder context
- **THEN** the guide shows a minimal runnable loop and the command needed to run
  it with the Orca CLI

#### Scenario: User needs API reference
- **WHEN** a user needs details for `loop()`, presets, guards, state adapters,
  fan-out/fan-in, sources, sinks, `defineLoop()`, or loop CLI commands
- **THEN** the guide provides reference material or links to a dedicated
  reference section for that topic

#### Scenario: User operates a served loop
- **WHEN** a user wants a long-lived trigger host
- **THEN** the guide explains `orca serve`, trigger ownership, child-run
  isolation, state persistence, and safe shutdown expectations

### Requirement: README remains a concise loop entry point

The README SHALL introduce loops as a primary Orca authoring path without
becoming the full loop reference.

#### Scenario: Reader scans README loops section
- **WHEN** a reader reaches the README loops section
- **THEN** they see the loop mental model, a compact example, the most important
  commands, and links to the canonical guide

#### Scenario: Reader wants deep loop details
- **WHEN** a reader needs recipes, troubleshooting, or full API details
- **THEN** the README directs them to the canonical loop guide instead of
  duplicating the reference inline

### Requirement: Agent docs preserve loop implementation constraints

Agent-facing docs SHALL preserve loop-specific implementation and documentation
placement rules for future coding agents.

#### Scenario: Agent updates loop docs
- **WHEN** an agent updates README, docs, examples, or skills for loops
- **THEN** the agent docs identify the canonical user guide, where architecture
  rationale belongs, and which deferred paths must not be revived

#### Scenario: Agent authors loop examples
- **WHEN** an agent creates or edits loop examples
- **THEN** the agent docs require Effect-free public authoring, supported backend
  tags only, and no selectable DBOS or Dolt adapter

### Requirement: Skills support both workflows and loop modules

The Orca Agent Skills SHALL distinguish legacy workflow scripts from loop
modules and provide correct authoring and execution guidance for both.

#### Scenario: Author skill creates a loop module
- **WHEN** a user asks for a reusable triggered loop
- **THEN** the author skill can guide creation of an import-safe
  `.orca/loops/<name>.ts` module using `defineLoop()`

#### Scenario: Author skill creates a legacy workflow script
- **WHEN** a user asks for a one-shot saved workflow
- **THEN** the author skill can still guide creation of a self-executing
  `.orca/workflows/<name>.ts` script

#### Scenario: Flow skill runs a loop artifact
- **WHEN** a user asks to run, monitor, or heal a loop module
- **THEN** the flow skill uses the loop CLI shape (`orca run`, `orca serve`, or
  `orca loops`) rather than only the legacy `orca <flow.ts>` command

### Requirement: Examples are verified documentation

Loop examples SHALL act as copyable documentation and be covered by the
appropriate verification gate.

#### Scenario: User copies a loop example
- **WHEN** a user copies a documented loop example into a repo with Orca
- **THEN** the example uses current public APIs and avoids internal engine
  symbols

#### Scenario: Verification runs
- **WHEN** the repository verification suite or targeted documentation checks run
- **THEN** loop examples and skill templates touched by this change are checked
  by typecheck, docs checks, template tests, or an explicit manual smoke path
