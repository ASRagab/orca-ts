## Context

The current distribution contract exposes the TypeScript authoring API as `@twelvehart/orca-ts` and the executable as `orca`. That split appears in package metadata, release validation, release binary names, installer behavior, standalone embedded fallback, README/docs, website docs, OpenSpec specs, examples, skill templates, and smoke tests.

The requested target is a hard public rename to `@twelvehart/orcats` and `orcats`. The npm organization remains `twelvehart`, and the GitHub source repository remains `ASRagab/orca-ts`. Backward compatibility for old package imports or the old `orca` executable is not required.

## Goals / Non-Goals

**Goals:**

- Make `@twelvehart/orcats` the only documented and verified npm package/import identity.
- Make `orcats` the only documented and verified executable identity.
- Keep `ASRagab/orca-ts` as the canonical source repository for package metadata, release downloads, installer URL, docs edit links, and skill installation source.
- Remove old embedded runtime aliases instead of extending compatibility shims.
- Update all active specs, docs, website docs, skills, examples, templates, tests, release validation, package smoke, binary smoke, installer behavior, and release artifacts to enforce the new public surface.
- Preserve deterministic CI and release gates.

**Non-Goals:**

- Rename the GitHub repository, GitHub Pages base path, source checkout directory guidance, or skills install source from `ASRagab/orca-ts`.
- Maintain compatibility for `@twelvehart/orca-ts`, `orca-ts`, or `orca`.
- Rename `.orca/` artifact directories.
- Rename existing `ORCA_*` runtime, backend, monitoring, loop-event, or installer environment variables.
- Change backend behavior, loop semantics, package exports, runtime APIs, or TypeScript declaration contents except where specifier names appear.

## Decisions

### Use `@twelvehart/orcats` as the package contract

The npm package name and all public import specifiers move from `@twelvehart/orca-ts` to `@twelvehart/orcats`.

Subpaths move in lockstep:

- `@twelvehart/orcats/loop`
- `@twelvehart/orcats/model`
- `@twelvehart/orcats/testing`
- `@twelvehart/orcats/package.json`

Alternative considered: publish unscoped `orcats`. Rejected because the user clarified that `twelvehart` remains the organization, and the current release trust model already uses the scoped package pattern.

Alternative considered: keep `@twelvehart/orca-ts` as an alias package. Rejected because backward compatibility is explicitly out of scope for this rename.

### Use `orcats` as the executable and release binary name

The package bin map becomes `bin.orcats -> ./bin/orcats`. Source and build outputs should follow the same executable name:

- source shim: `bin/orcats`
- local bundled output: `dist/orcats`
- compiled release tarball contents: `orcats`
- release tarballs: `orcats-darwin-arm64.tar.gz`, `orcats-darwin-x64.tar.gz`, `orcats-linux-arm64.tar.gz`, `orcats-linux-x64.tar.gz`
- user command examples: `orcats`, `orcats run`, `orcats serve`, `orcats loops`
- one-shot package execution: `bunx -p @twelvehart/orcats orcats ...`

No `bin.orca`, `bin/orca`, `dist/orca`, or `orca-*` release artifact should remain in active release validation.

Alternative considered: keep `orca` as a secondary bin during transition. Rejected because the desired migration is replacing the CLI on `PATH`, not maintaining old command compatibility.

### Keep repository and docs deployment identity unchanged

The source repository remains `ASRagab/orca-ts`, so package metadata, GitHub Release downloads, `install.sh` URL, skill install commands, docs edit links, and `website/astro.config.mjs` should keep that repository identity.

The docs site can keep the GitHub Pages base `/orca-ts` because that path is tied to the repository name, not the package or executable name.

Alternative considered: move the repo or docs base to `orcats`. Rejected because the user explicitly allowed the repo to remain `orca-ts`, and changing repository identity would add hosting, release URL, skill install, and trust-configuration churn unrelated to package/CLI naming.

### Keep `.orca/` directories and `ORCA_*` environment variables

`.orca/` remains the artifact/state directory for workflows, loops, monitoring, and persistent plans.

Existing `ORCA_*` variables remain the runtime and installer contract:

- backend/runtime variables such as `ORCA_BACKEND`, `ORCA_BACKEND_MODEL`, `ORCA_FLOW_ARGS`, `ORCA_LOOP_EVENT`, and backend-specific variables;
- verification/eval variables such as `ORCA_REAL_BACKEND_SMOKE`, `ORCA_REAL_BACKEND`, `ORCA_MONITOR_DIR`, and `ORCA_VALIDATE_TARGET_REPO`;
- installer variables `ORCA_VERSION` and `ORCA_INSTALL_DIR`.

This change does not add `ORCATS_*` aliases. These names are runtime configuration names, not package import specifiers or executable names, and renaming them would create a second breaking migration with little value.

Alternative considered: rename all env vars to `ORCATS_*`. Rejected as unnecessary scope expansion.

### Replace embedded fallback with the new package only

The standalone fallback should register temporary shims only for:

- `@twelvehart/orcats`
- `@twelvehart/orcats/loop`
- `@twelvehart/orcats/model`

It should continue to omit `/testing`.

The previous fallback aliases for `@twelvehart/orca-ts`, `orca-ts`, `orca-ts/loop`, and `orca-ts/model` should be removed. Smoke tests should prove a zero-project flow works with `@twelvehart/orcats` and fails to rely on old compatibility assumptions.

### Update specs and verification before release

The implementation should first update OpenSpec delta requirements, then update code/docs/tests to match. The release validation and smoke tests are load-bearing because they prevent partial renames from publishing:

- package artifact validation must require `@twelvehart/orcats`, `bin/orcats`, and `bin/orcats` in packed files;
- package smoke must install the packed tarball, typecheck imports from all public subpaths, and run installed `orcats --version`;
- binary smoke must build `dist/orcats`, verify help/version text, and run a zero-project flow importing `@twelvehart/orcats`;
- docs checks and skill-template typecheck must fail if active docs/templates still use the old package/import command.

## Risks / Trade-offs

- npm Trusted Publishing is configured for the old package name -> configure trust for `@twelvehart/orcats` before tagging and verify `npm view @twelvehart/orcats` remains available.
- Old `orca` executable may remain on user machines -> installer and setup skill must install/verify `orcats`; docs should tell users to replace the command on `PATH`.
- Search-and-replace may corrupt repository URLs or docs base paths -> explicitly preserve `ASRagab/orca-ts`, GitHub Release URLs, skills install source, and website base `/orca-ts`.
- Old import aliases removed from embedded fallback -> generated templates and docs must all import `@twelvehart/orcats`; no old flow should be treated as supported after this change.
- Keeping `ORCA_*` variables may look inconsistent next to `orcats` -> document them as stable runtime configuration names and avoid adding duplicate `ORCATS_*` variants.
- Package and binary jobs can drift -> release artifact validation must check both package bin and compiled binary names.

## Migration Plan

1. Update OpenSpec requirements for distribution, documentation website, and workflow skills.
2. Rename package metadata, bin shim, build outputs, release artifact naming, installer target, embedded fallback package constants, and user-facing CLI strings to `@twelvehart/orcats`/`orcats`.
3. Update smoke tests, release validation, package artifact validation, import-boundary tests, typecheck warnings, and skill-template tests.
4. Update README, `docs/`, website docs, examples, skill references, templates, and active OpenSpec text to use the new public surface.
5. Regenerate lockfiles if package or website workspace names change.
6. Configure npm Trusted Publishing for `@twelvehart/orcats` against `ASRagab/orca-ts/.github/workflows/release.yml`.
7. Run `bun run verify` and `bun run smoke:package`.
8. Install the new release and confirm `orcats --version` from both npm and GitHub Release paths.

Rollback before publish is a normal code revert. After npm publish, rollback means deprecating the bad `@twelvehart/orcats` version and fixing forward with the next version; the old `@twelvehart/orca-ts` package is not republished as part of this change.

## Open Questions

- Should the old `@twelvehart/orca-ts` npm package be explicitly deprecated after the new package is published?
- Should stale local `orca` binaries be removed by `install.sh`, or should the installer only place `orcats` and report the resolved path?
