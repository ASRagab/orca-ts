## Context

The current release path is deliberately binary-only. `package.json` is private, release validation enforces deferred npm publishing, docs point typed authoring at a Git dependency, and `.github/workflows/release.yml` creates GitHub Release assets without npm registry access.

The new target is a scoped public npm package, `@twelvehart/orca-ts`, published at `0.1.0` by GitHub Actions using npm Trusted Publishing. npm's current guidance requires OIDC-capable hosted CI, `id-token: write`, npm CLI support for Trusted Publishing, and `--access public` for first-time scoped public package publication. Provenance guidance also expects package repository metadata to match the public source repository.

## Goals / Non-Goals

**Goals:**

- Publish `@twelvehart/orca-ts@0.1.0` from the tag-driven release workflow.
- Use npm Trusted Publishing/OIDC instead of `NPM_TOKEN` or long-lived publish tokens.
- Keep GitHub Release binaries and `install.sh` as supported zero-dependency distribution.
- Make the npm tarball intentionally small and auditable.
- Verify the package artifact before publish by installing it into a temporary project.
- Update public docs, website docs, and agent-skill guidance to use the scoped package.

**Non-Goals:**

- Move the GitHub repository from `ASRagab/orca-ts` to a `twelvehart` GitHub organization.
- Publish from local machines or token-backed CI.
- Add Node-compatible compiled JavaScript for the runtime. The package remains Bun-oriented for `0.1.0`.
- Publish the docs website, tests, OpenSpec archive, or internal workflow files to npm.
- Change live backend behavior or package runtime semantics beyond the package name/import path.

## Decisions

### Publish the scoped package as the public contract

`@twelvehart/orca-ts` becomes the npm package name and public import specifier. Runtime imports move from:

```ts
import { flow } from "orca-ts";
```

to:

```ts
import { flow } from "@twelvehart/orca-ts";
```

Subpaths move in the same way: `@twelvehart/orca-ts/loop`, `/model`, and `/testing`.

Alternative considered: publish unscoped `orca-ts` while assigning ownership to the npm organization. Rejected because the user explicitly wants installation as `@twelvehart/orca-ts`, and the scoped name also makes package ownership obvious before the project is broadly ready.

### Keep the GitHub repository identity unchanged for this change

Package metadata, trusted-publisher setup, source links, GitHub Releases, and docs links continue to point at `ASRagab/orca-ts`. The npm organization scope and GitHub repository owner do not have to match.

Alternative considered: move the repository to `twelvehart/orca-ts` first. Rejected for this change because it would expand the blast radius to installer URLs, GitHub Pages, repository permissions, existing workflow history, and agent skill install commands. A future repo move can be a separate migration.

### Publish a Bun-oriented source package with generated declarations

The `0.1.0` npm artifact should include:

- `package.json`
- `README.md`
- `LICENSE`
- `NOTICE`
- `bin/orca`
- `src/**`
- generated `dist/**/*.d.ts` and `.d.ts.map`

The artifact should exclude tests, fixtures, website source/build output, OpenSpec archives, `.github`, local workflow/dogfood files, ignored build caches, and release tarballs.

The runtime entry points can keep pointing at TypeScript source because the CLI requires Bun and the bin shim uses `#!/usr/bin/env bun`. Type declarations come from `dist/` so editor and `tsc` consumers do not depend on source inference.

Alternative considered: compile JavaScript library modules into `dist/` and publish JS only. Rejected for `0.1.0` because it changes the runtime packaging model and module-resolution assumptions more than necessary. It remains a future hardening option if Node consumers become in scope.

### Add npm package smoke before publish

`bun run verify` should keep deterministic repo checks. A new package-specific gate should:

1. Build declarations.
2. Run `npm pack --dry-run` or `npm pack --json`.
3. Assert the file list includes required public artifacts and excludes internal paths.
4. Install the packed tarball into a temporary project.
5. Typecheck imports from `@twelvehart/orca-ts`, `/loop`, `/model`, and `/testing`.
6. Run the package `orca --version` entry and assert it matches `package.json.version`.

This catches packaging regressions that binary smoke cannot see.

### Publish from the existing tag-driven release workflow

The release workflow remains tag-driven by `vX.Y.Z`. It should have:

- a verify job that checks tag/package version parity and runs `bun run verify`;
- a binary release job that keeps the current GitHub Release behavior;
- an npm publish job that runs after verification, builds package artifacts, runs the package smoke, sets up Node 24/npm with `registry-url: https://registry.npmjs.org`, grants `id-token: write`, and runs `npm publish --access public`.

No workflow should require `NPM_TOKEN` for publishing. The maintainer must configure npm trust for package `@twelvehart/orca-ts`, repository `ASRagab/orca-ts`, workflow `release.yml`, and allowed action `npm publish` before pushing the release tag.

Alternative considered: publish from a separate `publish.yml` workflow. Rejected because the repo already has tag-driven release semantics, and a single release workflow avoids split-brain versioning between GitHub assets and npm.

### Update docs and agent skills together

All user-facing install and import examples should use `@twelvehart/orca-ts`. The standalone binary docs should remain available and explain that zero-project binary flows can import the package through the embedded fallback. Agent skill templates and references should generate scoped imports so saved workflows typecheck against the npm package.

## Risks / Trade-offs

- First publish/trusted-publisher bootstrap may fail if npm requires a pre-existing package or different org permissions -> document and test `npm trust github @twelvehart/orca-ts --repo ASRagab/orca-ts --file release.yml --allow-publish` before tagging; use npm UI setup if CLI setup is unavailable.
- Current GitHub repository is private, while npm provenance docs require a public matching repository -> decide before release whether to make `ASRagab/orca-ts` public, accept a publish/provenance limitation, or split repository-publication into a prerequisite task.
- Renaming import specifiers is breaking for existing local flows -> update templates/docs/tests, and consider a one-release embedded fallback alias for old `orca-ts` imports if the implementation cost stays small.
- Publishing TypeScript source keeps the package Bun-oriented -> document Bun as the npm package runtime requirement and defer Node-compatible JS builds.
- Release job may publish npm but fail GitHub asset creation, or the reverse -> keep both jobs dependent on verification, document failed-release cleanup, and require post-release checks for npm and GitHub assets.

## Migration Plan

1. Update package metadata and publish configuration for `@twelvehart/orca-ts`.
2. Add package artifact validation and smoke tests.
3. Update runtime/package import assumptions, tests, docs, website docs, and agent skills.
4. Update release workflow for Trusted Publishing and package smoke.
5. Configure npm trusted publisher for `@twelvehart/orca-ts` against `ASRagab/orca-ts/.github/workflows/release.yml`.
6. Run deterministic verification locally and in CI.
7. Push `v0.1.0`, then verify npm install/imports and GitHub Release assets.

Rollback before first publish is a normal code revert. After npm publish, the version cannot be reused; rollback means deprecating the bad `0.1.0`, fixing forward with `0.1.1`, and replacing or deleting GitHub Release assets as appropriate.

## Open Questions

- Must `ASRagab/orca-ts` be made public before the first npm publish to satisfy trusted-publishing provenance, or will npm allow the publish without public provenance?
- Should the embedded standalone fallback support both `orca-ts` and `@twelvehart/orca-ts` imports for one release?
- Should the release workflow use direct `npm publish --access public` or `npm stage publish` plus manual approval once the first package is live?
