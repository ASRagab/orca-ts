## Why

Orca TypeScript now has enough surface area that the README is doing too much:
it must introduce the runtime, teach first use, explain Agent Skills, document
loops, and point at deeper references. A GitHub Pages documentation website gives
new and advanced users a navigable path through the same material without
turning the README back into a manual.

## What Changes

- Add a documentation website for Orca TypeScript, deployed to GitHub Pages.
- Organize the site around user journeys: motivation, concepts, quickstart,
  installation, Agent Skills, flows, loops, backend configuration, operations,
  troubleshooting, guides, and reference.
- Build the site from a dedicated docs-site app so runtime package behavior,
  CLI behavior, and release artifacts stay unchanged.
- Seed content from the existing README, `docs/`, `skills/`, examples, and
  project terminology while keeping implementation-only notes out of user docs.
- Add deterministic verification for the docs site build and internal links.
- Plan implementation as parallel subagent workstreams for site infrastructure,
  information architecture/content migration, technical accuracy, and visual QA.

## Capabilities

### New Capabilities

- `documentation-website`: Public GitHub Pages documentation site, including
  structure, content requirements, deployment, verification, and maintenance
  expectations.

### Modified Capabilities

None.

## Impact

- Adds a docs-site app, dependencies, build scripts, and a GitHub Pages workflow.
- Adds or reorganizes user-facing documentation pages without changing runtime
  APIs, backend adapters, CLI behavior, release binaries, or Agent Skill
  execution semantics.
- Extends repository verification so documentation changes can fail CI when the
  site does not build or internal links are broken.
