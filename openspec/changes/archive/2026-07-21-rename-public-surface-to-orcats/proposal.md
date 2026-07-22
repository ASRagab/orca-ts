## Why

The public name currently splits the product across `@twelvehart/orca-ts` for typed authoring and `orca` for execution. Renaming both public entry points to `orcats` gives the package, CLI, docs, installer, and generated artifacts one unambiguous user-facing name while keeping the GitHub repository at `ASRagab/orca-ts`.

## What Changes

- **BREAKING** Rename the npm package from `@twelvehart/orca-ts` to `@twelvehart/orcats`.
- **BREAKING** Rename the executable from `orca` to `orcats`, including the npm bin, source shim, compiled binary, installer output, release tarball contents, and documented commands.
- **BREAKING** Remove legacy runtime import aliases from the standalone embedded fallback; generated and documented flows must import from `@twelvehart/orcats`.
- Keep the npm organization `twelvehart` unchanged.
- Keep the canonical source repository `ASRagab/orca-ts` unchanged, including package metadata, release downloads, installer URL, skills install source, and website edit links.
- Keep existing `.orca/` project artifact directories and `ORCA_*` environment variables unless a specific variable is tied to package, binary, or installer identity.
- Update release validation, package smoke tests, binary smoke tests, docs checks, website content, OpenSpec specs, examples, skill templates, skill scripts, and runtime embedded fallback checks to enforce the new public name.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `distribution`: Change the published package, executable, release artifacts, installer contract, embedded fallback, and release validation from `@twelvehart/orca-ts`/`orca` to `@twelvehart/orcats`/`orcats`.
- `documentation-website`: Update install, quickstart, reference, troubleshooting, and release pages to present `@twelvehart/orcats` and `orcats` as the supported public surface while preserving `ASRagab/orca-ts` as the repo and GitHub Pages base.
- `workflow-skill-setup`: Update setup and doctor guidance to install, locate, and verify `orcats`.
- `workflow-skill-authoring`: Update generated templates, typecheck rules, references, and runbooks to import `@twelvehart/orcats` and trigger artifacts through `orcats`.
- `workflow-skill-execution`: Update run, monitor, and healing guidance/scripts to invoke `orcats` for workflows and loop modules.

## Impact

- Public API/imports: package specifier changes to `@twelvehart/orcats`, including `/loop`, `/model`, and `/testing`.
- CLI: command name changes to `orcats`; existing `orca` command compatibility is not required.
- NPM release: package name and Trusted Publishing configuration must move to `@twelvehart/orcats` under the same `twelvehart` organization and same `ASRagab/orca-ts` workflow.
- GitHub Release assets: compiled binary output, tarball names, tarball contents, checksums, installer install target, and smoke tests must use `orcats`.
- Embedded runtime fallback: temporary `node_modules` shims should resolve `@twelvehart/orcats`, `@twelvehart/orcats/loop`, and `@twelvehart/orcats/model`; old aliases are intentionally out of scope.
- Documentation: README, `docs/`, website pages, OpenSpec specs, skill references, and examples must use the new public names while retaining source repo links to `ASRagab/orca-ts`.
- Verification: `bun run verify`, `bun run smoke:package`, package artifact validation, binary smoke, docs checks, docs symbol/signature checks, skill template typecheck, and release validation must fail if old public names remain in active contracts.
