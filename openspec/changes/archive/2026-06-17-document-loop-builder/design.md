## Context

The archived `add-loop-builder` change introduced a new loop authoring model:
`loop()`, preset termination archetypes, bounded fan-out/fan-in, state adapters,
`defineLoop()`, and `orca run/serve/loops`. The implementation is complete, but
the learning surface is split across README text, AGENTS implementation notes,
archived OpenSpec rationale, migration notes, examples, and Agent Skill
instructions that still primarily describe legacy `.orca/workflows/` scripts.

The documentation refresh has two audiences:

- Human users who need a clear path from "what is a loop?" to a working loop
  module they can run or serve.
- Coding agents that need durable rules for authoring loop modules without
  leaking Effect internals, reviving deferred adapters, or confusing legacy
  workflow scripts with loop definitions.

## Goals / Non-Goals

**Goals:**

- Provide one canonical loop guide that includes tutorial, concept guide,
  recipes, reference, operations, troubleshooting, and migration guidance.
- Keep the README concise and user-first while still making loops discoverable.
- Update agent docs and skills so generated Orca artifacts can intentionally
  choose `.orca/workflows/` or `.orca/loops/`.
- Make examples and skill templates serve as verified documentation, not stale
  snippets.
- Preserve the architecture decisions from the archived loop-builder change in
  the right place: agent docs and deep reference, not the README quick path.

**Non-Goals:**

- No runtime, CLI, backend, dependency, release, or public API behavior changes.
- No revival of Gemini, DBOS, Dolt, or framework-adoption paths.
- No replacement of legacy `.orca/workflows/` guidance; loops are added as a
  first-class authoring path, not made the only path.
- No npm publishing or release-process changes.

## Decisions

### D1 - Use one canonical loop guide, with README as the entry point

Create or refresh `docs/loops.md` as the canonical source for loop usage. It
will contain:

- a short mental model;
- a first-loop tutorial;
- a concept guide for termination, presets, guards, state, fan-out/fan-in, and
  sources/sinks;
- recipes for common loop shapes;
- API and CLI reference tables;
- operations and troubleshooting guidance;
- migration notes from legacy `fixLoop` wrappers and `.orca/workflows/`.

The README keeps a compact "Loops" section with a minimal example and links to
the guide. This avoids a giant README while keeping loops visible in the primary
onboarding path.

Alternatives considered:

- Put all loop material in README: rejected because the README would become a
  reference manual and bury quickstart/backend setup.
- Split tutorial/reference/recipes into many files immediately: rejected for now
  because the surface is easier to maintain as one cohesive guide until the
  guide becomes too large.

### D2 - Separate user guidance, agent constraints, and archived rationale

User-facing docs explain how to use loops. `AGENTS.md` preserves durable
implementation constraints and documentation placement rules. Archived OpenSpec
design remains the historical rationale and should be linked only when useful,
not copied into user docs.

This keeps docs from drifting into three competing sources of truth:

- README: entry point and quick examples.
- `docs/loops.md`: canonical user guide and reference.
- `AGENTS.md` plus skills: agent authoring constraints and maintenance rules.

### D3 - Teach skills to choose between workflow scripts and loop modules

Update `orca-ts-author` so it can generate either:

- a legacy self-executing flow under `.orca/workflows/<name>.ts`; or
- an import-safe loop module under `.orca/loops/<name>.ts` that exports a
  `defineLoop()` definition and is runnable by `orca run`, listable by
  `orca loops`, and hostable by `orca serve`.

Update `orca-ts-flow` so run/monitor guidance covers both artifact shapes.
Update setup guidance only where cross-links or command examples would otherwise
be misleading.

The skill cookbook and templates must continue to be self-contained per skill
directory. Shared scripts remain duplicated only where the existing drift tests
expect it.

### D4 - Make examples executable documentation

Examples should cover the loop shapes users are likely to copy:

- minimal preset loop;
- verification-gated task loop;
- fan-out/fan-in loop;
- persisted-state loop;
- served trigger loop.

Examples must compile or be covered by the existing verification path. Snippets
in docs should either be sourced from examples/templates or be small enough to
audit manually during `docs:check` review.

### D5 - Keep deferred and compatibility boundaries explicit

The guide and skills must say what exists now:

- supported backend tags remain `claude`, `codex`, `opencode`, and `pi`;
- Gemini stays cut;
- DBOS and Dolt stay deferred and unselectable;
- Effect stays internal and absent from public authoring;
- deprecated loop wrappers remain compatibility paths for one release;
- `Plan.interactive` remains unsupported.

This avoids accidental user promises that the runtime does not keep.

## Risks / Trade-offs

- Documentation duplication -> Mitigation: README links to `docs/loops.md`
  instead of repeating reference details.
- Stale examples -> Mitigation: use checked examples/templates and run the
  narrowest typecheck/docs gate that covers touched files.
- Skills overfit to loop modules and regress legacy workflows -> Mitigation:
  keep the workflow-vs-loop choice explicit in the author skill.
- Comprehensive guide becomes too large -> Mitigation: start as one canonical
  file and split later only when a concrete maintenance problem appears.
- Archived design details leak into user docs -> Mitigation: move rationale to
  AGENTS/deep reference and keep user docs task-oriented.

## Migration Plan

1. Inventory current loop mentions in README, docs, examples, AGENTS, and
   skills.
2. Write `docs/loops.md` as the canonical tutorial/reference/operations guide.
3. Trim README loop content to a concise entry point that links to the guide.
4. Update `AGENTS.md` documentation-placement and loop-authoring rules.
5. Update `orca-ts-author` reference, templates, runbooks, and self-audit rules
   for loop modules.
6. Update `orca-ts-flow` run/monitor/heal guidance for `orca run/serve/loops`.
7. Refresh examples so each major loop path has a checked sample.
8. Run the narrowest meaningful verification first, then `bun run verify` before
   PR if the implementation touches templates/examples broadly.

Rollback is documentation-only: revert the changed docs, examples, and skill
files. No runtime state or migration is involved.

## Open Questions

- Should the canonical guide remain one file for the first pass, or should
  implementation split tutorial/reference/recipes if the final document becomes
  hard to navigate?
- Which existing examples already cover loop paths well enough to reuse instead
  of adding new files?
