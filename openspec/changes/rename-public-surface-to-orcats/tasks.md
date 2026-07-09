## 1. Package And CLI Identity

- [x] 1.1 Update `package.json`, `bun.lock`, and package self-reference expectations from `@twelvehart/orca-ts` to `@twelvehart/orcats`.
- [x] 1.2 Replace the npm bin entry with `bin.orcats -> ./bin/orcats` and rename the source shim from `bin/orca` to `bin/orcats`.
- [x] 1.3 Update CLI help, version output, diagnostics, and typecheck warning text to use `orcats` and `@twelvehart/orcats`.
- [x] 1.4 Keep `.orca/` artifact directories and existing `ORCA_*` environment variables unchanged unless a test shows a direct package/bin identity conflict.

## 2. Embedded Runtime Fallback

- [x] 2.1 Update the embedded package constants and registry key to use `@twelvehart/orcats`.
- [x] 2.2 Remove fallback shims for `@twelvehart/orca-ts`, `orca-ts`, `orca-ts/loop`, and `orca-ts/model`.
- [x] 2.3 Ensure standalone fallback resolves `@twelvehart/orcats`, `@twelvehart/orcats/loop`, and `@twelvehart/orcats/model`, while continuing to exclude `/testing`.
- [x] 2.4 Update embedded-fallback smoke coverage so zero-project flows import `@twelvehart/orcats`.

## 3. Release Artifacts And Installer

- [x] 3.1 Update build scripts so local compiled output is `dist/orcats`.
- [x] 3.2 Update release binary creation so tarballs are named `orcats-<platform>.tar.gz` and contain a single executable named `orcats`.
- [x] 3.3 Update `SHA256SUMS.txt` generation and release upload assumptions for the renamed tarballs.
- [x] 3.4 Update `install.sh` to download `orcats-*` tarballs and install the executable as `orcats`.
- [x] 3.5 Update setup scripts so an existing `orca` binary does not satisfy the Orcats install check.

## 4. Package And Release Validation

- [x] 4.1 Update `scripts/package-artifact.ts` and `scripts/validate-release.ts` to require `@twelvehart/orcats`, `bin/orcats`, and the new packed file list.
- [x] 4.2 Update `scripts/smoke-package.ts` to install the packed tarball, typecheck imports from all `@twelvehart/orcats` public subpaths, and run installed `orcats --version`.
- [x] 4.3 Update `scripts/smoke-binary.ts` to build `dist/orcats`, assert `orcats --help` and `orcats --version`, and run flows importing `@twelvehart/orcats`.
- [x] 4.4 Update release documentation and workflow notes for npm Trusted Publishing package `@twelvehart/orcats` under repository `ASRagab/orca-ts`.

## 5. Tests, Fixtures, And Examples

- [x] 5.1 Update CLI tests, preflight tests, run-output tests, loop distribution tests, and binary/package smoke expectations from `orca` to `orcats` where they refer to the executable.
- [x] 5.2 Update import-boundary tests, typecheck tests, skill-template tests, and generated probe projects from `@twelvehart/orca-ts` to `@twelvehart/orcats`.
- [x] 5.3 Update examples and active fixtures that represent public user commands/imports to use `orcats` and `@twelvehart/orcats`.
- [x] 5.4 Leave historical archived OpenSpec transcripts and fixtures unchanged unless they are part of an active verification contract.

## 6. Agent Skills

- [x] 6.1 Rename bundled skill directories and metadata to `orcats-setup`, `orcats-author`, and `orcats-flow`.
- [x] 6.2 Update duplicated skill scripts (`orca-run.sh`, `orca-doctor.sh`, setup/typecheck scripts) or rename them consistently if the public script names are changed.
- [x] 6.3 Update author templates to import only from `@twelvehart/orcats` and to document/run `orcats` trigger commands.
- [x] 6.4 Update skill references, gotchas, recipes, and runbooks to remove old package/import/bin compatibility guidance.
- [x] 6.5 Update skill drift tests so duplicated scripts remain byte-identical after the rename.

## 7. Documentation And Website

- [x] 7.1 Update `README.md` and in-repo `docs/` to use `@twelvehart/orcats` and `orcats` for active install, import, CLI, release, troubleshooting, and workflow examples.
- [x] 7.2 Update `website/src/content/docs/` with the same package and CLI rename across quickstart, install, guides, reference, and troubleshooting pages.
- [x] 7.3 Preserve source repository links, release download URLs, edit links, skills install source, and website base as `ASRagab/orca-ts` / `/orca-ts`.
- [x] 7.4 Update docs guard fixtures or expected tokens if any doc checker intentionally looks for the old public surface.

## 8. OpenSpec And Agent Notes

- [x] 8.1 Update main OpenSpec specs after implementation so `distribution`, `documentation-website`, and workflow-skill specs reflect the renamed public surface.
- [x] 8.2 Update `AGENTS.md`, `CONTEXT.md`, or other active agent-facing notes that describe package, CLI, release, or skill contracts.
- [x] 8.3 Do not rewrite archived OpenSpec decisions except where an active spec or docs check incorrectly consumes archived text as current behavior.

## 9. Verification And Release Readiness

- [x] 9.1 Run focused tests for package artifact validation, CLI behavior, embedded fallback, import boundaries, and skill templates.
- [x] 9.2 Run `bun run build:types`, `bun run docs:check`, `bun run docs:symbols`, `bun run docs:signatures`, and `bun run check:facade-gate`.
- [x] 9.3 Run `bun run validate:release`, `bun run smoke:binary`, `bun run smoke:package`, and `bun run verify`.
- [ ] 9.4 Confirm npm Trusted Publishing is configured for `@twelvehart/orcats` before tagging a release.
- [ ] 9.5 After release, verify `npm view @twelvehart/orcats@X.Y.Z`, clean-project import/typecheck, `bunx -p @twelvehart/orcats@X.Y.Z orcats --version`, installer install, and GitHub Release binary assets.
