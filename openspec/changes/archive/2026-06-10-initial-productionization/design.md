## Context

The TypeScript port now has a complete local verification gate, package metadata that already names `ASRagab/orca-ts`, and concise docs for backends, parity, plans, review, distribution, and release checks. It does not yet have a remote GitHub repository configured as the canonical upstream, a GitHub Actions workflow, or a README that a new user can follow from installation through first run.

This phase is initial productionization: make the project hostable and verifiable in GitHub, then make the README good enough to serve as the package front door.

## Goals / Non-Goals

**Goals:**

- Establish `ASRagab/orca-ts` as the canonical GitHub remote for the project.
- Add CI that runs deterministic verification on push and pull request events.
- Improve `README.md` with installation, CLI usage, authoring usage, backend setup, examples, verification commands, and v1 limitations.
- Keep docs consistent with the existing package metadata, Bun runtime, and deterministic verification gate.

**Non-Goals:**

- Publishing to npm or creating release tags.
- Enabling live backend credentials in CI.
- Changing runtime APIs, backend behavior, or package exports.
- Implementing unsupported v1 features such as `ask_user`, live approvals, or `Plan.interactive`.

## Decisions

### Use `ASRagab/orca-ts` as the canonical upstream

The implementation should first check whether `ASRagab/orca-ts` already exists and whether the local `origin` remote points to it. If the remote repository does not exist, create it in the `ASRagab` organization and set the local `origin` remote to that URL.

Alternatives considered:

- Use a user-owned repository instead of the organization: rejected because the request explicitly names the `ASRagab` org.
- Defer remote setup until release: rejected because CI and package metadata need a canonical repository before the README can give reliable installation and issue links.

Repository visibility is the only detail that may need confirmation before execution if the repository does not already exist.

Implementation resolution: GitHub reports `ASRagab` as the authenticated user account rather than an organization. Because visibility was not specified and repository creation publishes external state, the repository was created as private by default and configured as `origin`.

### Make CI deterministic and credential-free

The GitHub Actions workflow should run on pull requests and pushes to the default branch, install Bun, install dependencies from `bun.lock`, and run the same deterministic verification gate used locally. It should not run the gated real-backend smoke because that requires local credentials and can consume model credits.

Alternatives considered:

- Run only `bun test`: rejected because release readiness also depends on type declarations, fixture validation, release metadata, and binary smoke.
- Run live backend smoke in CI: rejected because credentials and usage costs do not belong in default CI.

### Treat README as the first-run guide

The README should be expanded from a status note into a practical guide: what Orca TypeScript is, prerequisites, installation paths, CLI usage, TypeScript authoring usage, backend setup, examples, verification, docs links, and scope cuts. It should keep details concise and link to existing docs for deeper reference.

Alternatives considered:

- Put all documentation in `docs/` and keep README short: rejected because package and repository visitors need a complete first-run path without hunting through internal docs.
- Duplicate all docs in README: rejected because backend, parity, plan, review, and release details already have dedicated docs.

### Keep publishing out of scope

This phase should stop at repository setup, CI, and README quality. npm publishing, GitHub releases, and release automation can be specified later after the repository has passed CI.

Alternatives considered:

- Include npm publish automation now: rejected because credentials, package ownership, and release policy are separate production decisions.

## Risks / Trade-offs

- Repository creation may fail because of missing GitHub authentication or organization permissions. Mitigation: check `gh auth status` and `gh repo view ASRagab/orca-ts` before creating anything, and report the exact blocker.
- CI can fail if the workflow uses a Bun or action setup that does not match the local environment. Mitigation: use the official Bun setup action, honor `bun.lock`, and run `bun run verify` locally before relying on CI.
- Binary smoke may behave differently on GitHub-hosted runners than on the local machine. Mitigation: keep the workflow focused on one supported runner first and document any platform limits.
- README can drift from implementation commands. Mitigation: list commands that are already backed by package scripts and keep live backend smoke explicitly separate from default verification.

## Open Questions

- None.
