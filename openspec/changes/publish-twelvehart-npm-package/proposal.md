## Why

Orca TS is ready for a first npm distribution path so projects can install a stable authoring package from the `twelvehart` organization instead of depending on a Git URL. npm now strongly favors Trusted Publishing over long-lived publish tokens, so the release path should move to OIDC-based GitHub Actions publishing before the first `0.1.0` package is cut.

The current repo intentionally blocks npm publishing: package metadata is private, release validation enforces deferred publishing, and the release workflow only creates GitHub Release binaries. This change reverses that decision in a controlled way while keeping deterministic CI and the standalone binary release path intact.

## What Changes

- Publish the package as scoped public npm package `@twelvehart/orca-ts` at version `0.1.0`.
- **BREAKING** Change consumer import guidance and package subpaths from `orca-ts` to `@twelvehart/orca-ts`, including `/loop`, `/model`, and `/testing`.
- Add an npm package artifact contract: curated package contents, type declarations, executable `orca` bin, and no internal project archives/tests/docs-site build artifacts in the published tarball.
- Update release CD so a `vX.Y.Z` tag verifies the repo, builds GitHub Release binaries, and publishes `@twelvehart/orca-ts` through npm Trusted Publishing from GitHub Actions.
- Keep token-based npm publishing out of CI; the publish job uses OIDC (`id-token: write`) and npm CLI support for Trusted Publishing.
- Add package smoke validation that packs/installs the npm artifact in a temporary project and proves imports, types, and `orca --version` resolve from the published package shape.
- Update public docs, website docs, release runbook, and in-repo agent skills to install and import `@twelvehart/orca-ts`.
- Preserve GitHub Release binaries and `install.sh` as the zero-dependency install path.
- Capture maintainer setup for npm trust: `@twelvehart/orca-ts` must trust `ASRagab/orca-ts` `.github/workflows/release.yml` before the tag publish can succeed.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `distribution`: Switch the npm authoring package from deferred/unscoped `orca-ts` assumptions to a scoped public `@twelvehart/orca-ts` package published by Trusted Publishing, with package artifact verification and updated install/import documentation.

## Impact

- `package.json`, package export/type metadata, npm publish configuration, and package contents allowlist.
- Release workflow and release validation scripts.
- New or updated npm package smoke test/script.
- CLI embedded package fallback and typecheck warning text if consumer import resolution moves to the scoped package name.
- Tests covering package import boundaries and typecheck setup.
- README, `docs/`, website docs, and agent skill instructions/templates/reference docs.
- OpenSpec `distribution` requirements and any docs/skill specs whose install contract changes.
