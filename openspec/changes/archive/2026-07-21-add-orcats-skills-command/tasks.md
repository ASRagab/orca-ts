## 1. CLI command contract

- [x] 1.1 Extend CLI argument parsing and help text for the `skills` command and
  its allowlisted `--list`, `--skill`, `--all`, `--agent`, `--global`, and
  `--yes` options, including invalid-combination diagnostics.
- [x] 1.2 Add the delegated skills command runner with fixed source
  `ASRagab/orca-ts`, direct `npx` argument-array spawning, inherited stdio,
  exact child exit propagation, and an actionable missing-`npx` diagnostic.
- [x] 1.3 Route the command before flow typecheck, backend environment setup,
  and embedded fallback initialization without changing flow or loop behavior.

## 2. Deterministic verification

- [x] 2.1 Add focused parser and command-mapping tests for interactive, list,
  selected-skill, all-skills, agent, scope, non-interactive, and invalid inputs.
- [x] 2.2 Add command-dispatch tests using a controlled process seam or fake
  `npx` executable to prove inherited delegation, missing-prerequisite handling,
  non-zero exit propagation, and absence of preflight/fallback work.
- [x] 2.3 Extend package and compiled-binary smoke coverage with a deterministic
  fake delegated installer, while preserving the existing curated package
  artifact checks and avoiding live network installation in default verification.

## 3. Documentation

- [x] 3.1 Update the README and add or update the in-repo Agent Skills guide
  with interactive, selected, global, and non-interactive `orcats skills`
  examples plus the equivalent direct `npx skills` fallback.
- [x] 3.2 Update website Agent Skills installation and reference pages with the
  command contract, `npx` prerequisite, and delegated-installation boundary.

## 4. Validation

- [x] 4.1 Run focused CLI and distribution tests, `bun run typecheck`,
  `bun run docs:check`, `bun run docs:symbols`, and the documentation site build.
- [x] 4.2 Run `bun run smoke:binary`, `bun run smoke:package`, and
  `bun run verify`; report any environment-specific limitation without hiding a
  failed check.
