---
title: Distribution And Release
description: npm package, GitHub Release binaries, installer behavior, and tag-driven releases.
---

Orca ships `@twelvehart/orcats` on npm for normal project use and GitHub Release binaries for no-`node_modules` execution.

## NPM package

```bash
npm i @twelvehart/orcats
npm i -D typescript
bunx -p @twelvehart/orcats orcats --version
```

The package provides the public TypeScript API and a POSIX `orcats` launcher
that clears `BUN_OPTIONS` before entering Bun.

## Release assets

| Asset | Platform |
| --- | --- |
| `orcats-darwin-arm64.tar.gz` | macOS Apple Silicon |
| `orcats-darwin-x64.tar.gz` | macOS Intel |
| `orcats-linux-arm64.tar.gz` | Linux arm64 glibc |
| `orcats-linux-x64.tar.gz` | Linux x64 glibc |

Each tarball contains the public POSIX `orcats` launcher and adjacent private
`orcats-runtime`, plus the offline compiler assets in `checker/`. Keep all three
together. `SHA256SUMS.txt` covers each complete tarball.

## Installer

```bash
curl -fsSL https://github.com/ASRagab/orca-ts/releases/latest/download/install.sh | bash
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `ORCA_VERSION` | Install a specific GitHub Release version without the `v` prefix. |
| `ORCA_INSTALL_DIR` | Destination directory for the executable. |

The installer places the launcher, runtime, and checker assets in that directory.
The installed CLI can check and run artifacts without project dependencies.

See the canonical [Environment Variables](../environment/) reference for
installer formats and every other supported `ORCA_*` setting.

## Release process

Releases are tag-driven. A `vX.Y.Z` tag runs the release workflow, verifies the repo, publishes GitHub Release binaries plus `install.sh`, and publishes `@twelvehart/orcats@X.Y.Z` to npm through Trusted Publishing.

The npm package is published from GitHub Actions with OIDC. The workflow does not use `NPM_TOKEN`; maintainers configure npm trust for `ASRagab/orca-ts` and `.github/workflows/release.yml` before tagging.

Release builds and npm package smoke build checker assets before checking package
size budgets. Each maximum is capped at 110% of its recorded baseline, rounded up
to the next KiB. Binary smoke runs the installer, checks an artifact offline, and
executes it with a poisoned `BUN_OPTIONS` to verify launcher isolation.
