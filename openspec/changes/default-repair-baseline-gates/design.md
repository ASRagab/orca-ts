## Context

Authored mutating workflows currently tend to treat baseline validation as a
precondition: a clean tree and green gates are required before the first backend
turn. That is conservative for attribution, but it prevents Orca from fixing the
most obvious defect in the repository: existing failing lint, tests, or verify
commands.

The desired invariant is that a mutating Orca workflow starts by making the
repository valid. The exception is user-owned local edits: accepting a dirty tree
can modify or reinterpret work the user has not committed, so it needs explicit
operator intent and an auditable snapshot.

## Goals / Non-Goals

**Goals:**

- Make red baseline gate repair the default for generated mutating workflows.
- Preserve a clean worktree as the default safety boundary.
- Provide an explicit setting for strict fail-fast behavior.
- Provide an explicit setting for dirty-baseline acceptance with snapshotting.
- Ensure baseline repair is bounded, monitored, and validation-preserving.

**Non-Goals:**

- Automatically changing arbitrary hand-written TypeScript flows that do not use
  the shared baseline policy helper.
- Making destructive git recovery automatic.
- Treating dirty user work as safe by default.

## Decisions

### Decision: Use a baseline policy with `repair` as the default

Generated mutating artifacts will use a shared baseline policy:

- `repair`: default; require a clean worktree, then repair failing baseline gates
  before main workflow stages.
- `strict`: require a clean worktree and green baseline gates; fail immediately on
  red gates.
- `accept-dirty`: allow a dirty worktree, snapshot the baseline, then repair
  failing gates before main workflow stages.

Alternative considered: make dirty acceptance part of the default repair mode.
Rejected because dirty user changes are not equivalent to red gates. Red gates are
repository state to repair; dirty changes may be unpublished user intent.

### Decision: Route policy through generated workflow args and local config

Generated runbooks will document an explicit runtime override, for example:

```bash
orca .orca/workflows/name.ts --backend codex -- --baseline=strict
orca .orca/workflows/name.ts --backend codex -- --baseline=accept-dirty
```

Templates may also accept `ORCA_BASELINE_POLICY` or a workflow-local setting, but
the precedence must be deterministic: run argument, environment/config, template
default.

Alternative considered: add a hard global CLI flag to `orca`. Rejected as the
only mechanism because baseline behavior is workflow semantics; the runner cannot
force arbitrary TypeScript to run gates unless the artifact participates.

### Decision: Snapshot dirty baselines before agent edits

`accept-dirty` must persist a baseline artifact before any backend turn:

- `git status --porcelain=v1`
- tracked staged diff
- tracked unstaged diff
- untracked file list
- initial gate outputs

The snapshot gives the user a way to audit what existed before Orca began. It
does not authorize destructive cleanup or broad resets.

### Decision: Main workflow stages start only after baseline convergence

When baseline repair is needed, it runs as its own monitored stage. The workflow
MUST NOT plan features, cleanup files, commit, publish, or run final smoke until
the baseline gate converges. Non-convergence exits with the latest validation
evidence.

Alternative considered: proceed with feature work while carrying known baseline
failures as context. Rejected because it makes later failures ambiguous and hides
the invariant that the repository should become valid first.

## Risks / Trade-offs

- More token spend before feature work -> bounded baseline repair iterations and
  clear monitoring output.
- Baseline failures may be broad or unrelated -> fail on non-convergence before
  downstream stages.
- Dirty-baseline mode may touch user work -> require explicit opt-in and persist
  a snapshot before edits.
- Some legacy workflows will not inherit the behavior -> update bundled templates
  and high-value checked workflows first; document the helper for custom flows.

## Migration Plan

1. Add or update a shared baseline policy helper used by generated mutating
   workflow templates.
2. Update bundled workflow templates and runbooks so `repair` is the default.
3. Update `orca-ts-flow` guidance to classify red baseline gates as an in-flow
   repair stage by default.
4. Add tests for policy parsing, clean red-gate repair, strict failure, and dirty
   snapshot behavior.
5. Update docs and website references for the new baseline policy setting.
