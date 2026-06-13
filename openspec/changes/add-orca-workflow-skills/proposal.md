## Why

Orca TypeScript is a capable runtime, but turning it into a real workflow for a
given repository is still tribal knowledge: install the binary, prove a backend
is authenticated, learn the flow DSL, hand-write a `.ts` flow, wire in the
target repo's own test/lint gates, then run it and babysit it when a backend
stalls or an auth token expires. Today a coding agent dropped into an arbitrary
git repository has no guided path through any of that. We want installable,
host-agnostic skills that take a user from "I have an idea for a workflow" to a
saved, re-runnable, self-validating workflow — and that keep it running when
things break.

This must work for **any git-backed repository**, not just TypeScript projects.
The flow files Orca runs are TypeScript, but the repositories they operate on
can be Python, Go, Rust, Scala, or plain files. The skills must detect and wire
the *target* repo's toolchain rather than assume a Node/TS stack.

## What Changes

- Add three installable, host-agnostic Agent Skills, versioned in this repo
  under `skills/`, that compose into a setup → author → run pipeline:
  - **`orca-ts-setup`**: install the `orca` binary, then verify that at least
    one supported backend (`claude`/`codex`/`opencode`/`pi`) is on `PATH`,
    authenticated, and usable — asking the user which backend(s) to enable —
    and troubleshoot install/auth/config failures.
  - **`orca-ts-author`**: read the target repository to detect its stack and
    real verification commands, interview the user (adaptively, one decision at
    a time on hosts without structured prompts) to fix the workflow shape, help
    them author a flow, and **enforce verification gates** (at minimum the
    repo's tests and linters) so a "vibe" becomes a productized workflow. Save
    the flow to a stack-agnostic location and emit a runbook.
  - **`orca-ts-flow`**: execute a saved (or just-authored) workflow, monitor it
    for progress (detect stalls/stuck loops), and diagnose, resolve, and where
    safe self-heal runtime failures (backend crash, expired auth, validation
    failures, non-convergence).
- Establish a stack-agnostic convention for saved workflows: flows live under
  the target repo's `.orca/workflows/<name>.ts`, are triggered through the
  `orca` binary (which embeds the API and skips the project typecheck guard in
  non-TS repos), and ship with a runbook plus an optional thin shell wrapper —
  no dependency on the target repo's package manager.
- Bundle a reusable backend doctor used by both `orca-ts-setup` (preflight) and
  `orca-ts-flow` (runtime re-verification/healing).
- Bundle TypeScript flow templates (archetypes) plus a reference cookbook (DSL,
  backend matrix, codegen gotchas, recipes) so generated flows typecheck on the
  first try.
- Add a CI check that typecheck-gates the bundled templates so they cannot drift
  from the runtime API they target.

## Capabilities

### New Capabilities
- `workflow-skill-setup`: behavior of the `orca-ts-setup` skill — installing the
  `orca` binary and verifying/troubleshooting at least one chosen backend.
- `workflow-skill-authoring`: behavior of the `orca-ts-author` skill — target
  repo discovery, adaptive interview, stack-agnostic flow generation with
  enforced verification gates, and saving a re-runnable workflow.
- `workflow-skill-execution`: behavior of the `orca-ts-flow` skill — running a
  saved workflow, monitoring progress/stall, and diagnosing/resolving/healing
  failures.

### Modified Capabilities
<!-- None. The skills consume the existing flow-runtime, conversation-backends,
     distribution, and execution-observability capabilities without changing
     their requirements. -->

## Impact

- **New**: `skills/orca-ts-setup/`, `skills/orca-ts-author/`,
  `skills/orca-ts-flow/` (each with `SKILL.md`, bundled `scripts/`, `assets/`,
  and `reference/` as needed). A shared backend-doctor script. A CI test
  (e.g. `tests/skill-templates.test.ts`) that typecheck-gates bundled templates.
- **Convention**: target repos gain an `.orca/workflows/` directory for saved
  flows (alongside the existing `.orca/plan-*.md` and `.orca/monitoring/`).
- **Consumes (unchanged)**: the standalone-binary embedded-import path and
  typecheck-skip behavior (`distribution`), the backend SPI and
  `selectBackend()` (`conversation-backends`, `shared-backend-config`), the flow
  DSL (`flow-runtime`), and `--monitor`/`.orca/monitoring` plus
  `scripts/summarize-run.ts` (`execution-observability`).
- **Docs**: README/AGENTS gain a short pointer to the skills; detailed skill
  guidance stays inside each `SKILL.md`.
- No changes to the runtime's public API or the deterministic `bun run verify`
  contract beyond the additive template-gate test.
