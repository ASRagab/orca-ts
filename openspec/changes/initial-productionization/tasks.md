## 1. Canonical Repository Setup

- [x] 1.1 Check GitHub CLI authentication and maintainer access to the `ASRagab` organization.
- [x] 1.2 Check whether `ASRagab/orca-ts` already exists and whether local `origin` already points at it.
- [x] 1.3 If the remote repository does not exist, confirm repository visibility and create `ASRagab/orca-ts` with the current project as its source.
- [x] 1.4 Configure local `origin` to point at the canonical repository without overwriting unrelated remotes.
- [x] 1.5 Verify package metadata, homepage, repository URL, and issue URL reference `ASRagab/orca-ts`.

## 2. GitHub Actions CI

- [x] 2.1 Add `.github/workflows/ci.yml` for pull requests and pushes to the default branch.
- [x] 2.2 Configure CI to check out the repository, install Bun, install dependencies from `bun.lock`, and run `bun run verify`.
- [x] 2.3 Ensure the default CI workflow does not set `ORCA_REAL_BACKEND_SMOKE` or require backend credentials.
- [x] 2.4 Document the CI gate and the excluded live-backend smoke path in the README or release docs.

## 3. README Installation and Usage Guide

- [x] 3.1 Rewrite `README.md` with a clear overview, status, prerequisites, installation, and local development setup.
- [x] 3.2 Document CLI usage for local scripts and package entry points, including the default typecheck pre-flight behavior.
- [x] 3.3 Document TypeScript authoring usage with the public flow helpers and backend constructors.
- [x] 3.4 Document supported v1 backends, required local credentials or commands, and the separate gated live-backend smoke command.
- [x] 3.5 Document examples, verification commands, scope cuts, licensing/attribution, and links to deeper docs.

## 4. Verification

- [x] 4.1 Run `openspec validate "initial-productionization"` after artifact and spec updates.
- [x] 4.2 Run `bun run verify` after CI and README changes.
- [x] 4.3 Verify local git remotes and, when authenticated, `gh repo view ASRagab/orca-ts`.
- [x] 4.4 Record any remaining external blockers, such as missing GitHub organization permission or unresolved repository visibility.

External-state note: `ASRagab/orca-ts` exists as a private repository and local `origin` points to it. The remote has no default branch until the first commit is pushed; no auth or repository visibility blocker remains.
