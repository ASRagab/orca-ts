## 1. Package Contract

- [x] 1.1 Update `package.json` to publish as `@twelvehart/orca-ts`, remove `private: true`, add public npm publish configuration, and keep version `0.1.0`.
- [x] 1.2 Add explicit package entry metadata so root, `/loop`, `/model`, and `/testing` expose generated declaration files and Bun-runtime TypeScript sources.
- [x] 1.3 Define an npm package contents allowlist that includes runtime source, declarations, CLI bin, README, license, and notice files.
- [x] 1.4 Update source import-boundary tests and package self-reference assumptions from `orca-ts` to `@twelvehart/orca-ts`.
- [x] 1.5 Update the standalone embedded fallback to resolve `@twelvehart/orca-ts`, `/loop`, and `/model` for zero-project binary flows.
- [x] 1.6 Resolve whether to keep a one-release embedded fallback alias for legacy `orca-ts` imports and capture the decision in code/docs.

## 2. Package Verification

- [x] 2.1 Update `scripts/validate-release.ts` so it enforces the scoped public npm package contract instead of deferred publishing.
- [x] 2.2 Add package artifact validation that fails if the npm tarball includes tests, fixtures, website files, OpenSpec archives, `.github`, local workflow files, build caches, or release tarballs.
- [x] 2.3 Add a package smoke script that packs the package, installs it into a temporary TypeScript project, typechecks imports from all public subpaths, and runs the installed `orca --version`.
- [x] 2.4 Wire the package smoke into the deterministic verification path or the release publish path so npm publish cannot run without it.

## 3. Trusted Publishing Workflow

- [x] 3.1 Update `.github/workflows/release.yml` with an npm publish job that depends on verification, uses a GitHub-hosted runner, sets `id-token: write`, sets up Node 24/npm for `https://registry.npmjs.org`, and runs `npm publish --access public`.
- [x] 3.2 Keep the existing GitHub Release binary job intact and ensure npm and binary release jobs both verify tag/package version parity before publishing artifacts.
- [x] 3.3 Document and dry-run the one-time trusted publisher setup for `@twelvehart/orca-ts` against `ASRagab/orca-ts` and `.github/workflows/release.yml`.
- [x] 3.4 Resolve the repository visibility/provenance prerequisite before tagging `v0.1.0`.

## 4. Documentation And Agent Skills

- [x] 4.1 Update `README.md`, `docs/distribution.md`, `docs/release.md`, and related `docs/` pages to install and import `@twelvehart/orca-ts`.
- [x] 4.2 Update website docs under `website/src/content/docs/` with scoped package install, import, `bunx`, troubleshooting, and release guidance.
- [x] 4.3 Update agent skills, templates, and reference docs under `skills/` so generated workflows import from `@twelvehart/orca-ts`.
- [x] 4.4 Keep standalone binary install documentation on GitHub Release assets and clarify how it relates to the npm package authoring path.
- [x] 4.5 Update any OpenSpec or agent notes that still state npm publishing is deferred.

## 5. Verification And Release

- [x] 5.1 Run focused checks for package metadata, import boundaries, embedded fallback, and package smoke.
- [x] 5.2 Run docs gates affected by install/import text changes: `bun run docs:check`, `bun run docs:symbols`, and `bun run docs:signatures` after `bun run build:types`.
- [x] 5.3 Run `bun run validate:release`, `bun run smoke:binary`, and `bun run verify`.
- [x] 5.4 Push the release change, confirm CI green on `main`, then push tag `v0.1.0`.
- [ ] 5.5 Post-release, verify `npm view @twelvehart/orca-ts@0.1.0`, install/import smoke from a clean project, `bunx -p @twelvehart/orca-ts@0.1.0 orca --version`, and GitHub Release binary assets.
