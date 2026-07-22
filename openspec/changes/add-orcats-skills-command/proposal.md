## Why

Orcats ships three reusable Agent Skills, but users must discover and run a
separate `npx skills` command to install them. A first-class Orcats entry point
makes the capability discoverable without taking ownership of the cross-agent
installation behavior that the `skills` CLI already provides.

## What Changes

- Add an `orcats skills` command that lists or installs the skills published by
  `ASRagab/orca-ts` by delegating to the `skills` CLI through `npx`.
- Support explicit list, scope, agent, skill-selection, and non-interactive
  options while preserving the delegated CLI's interactive installation flow.
- Treat the command as an administrative path: it must not typecheck a target
  project, initialize a backend, or load the embedded runtime fallback.
- Document the Orcats command, its `npx` prerequisite, and its relationship to
  the existing direct `npx skills` invocation in the README and public docs.
- Keep skill payloads out of the npm package and do not implement agent-specific
  installation, update, or removal behavior in Orcats.

## Capabilities

### New Capabilities

- `agent-skills-cli-installation`: Discover and install Orcats' bundled Agent
  Skills through the Orcats CLI while delegating placement and interaction to
  the `skills` CLI.

### Modified Capabilities

- `distribution`: Extend the supported `orcats` CLI command surface with the
  delegated Agent Skills administrative path.
- `documentation-website`: Document the Orcats CLI path for Agent Skills
  installation alongside the existing direct installer path.

## Impact

- Affects CLI argument parsing, command dispatch, focused CLI tests, README,
  in-repo documentation, and website installation/reference pages.
- Requires `npx` at execution time; adds no npm runtime dependency and does not
  change the curated npm package payload or release artifacts.
