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

The package provides the public TypeScript API and a Bun-backed `orcats` CLI shim.

## Release assets

| Asset | Platform |
| --- | --- |
| `orcats-darwin-arm64.tar.gz` | macOS Apple Silicon |
| `orcats-darwin-x64.tar.gz` | macOS Intel |
| `orcats-linux-arm64.tar.gz` | Linux arm64 glibc |
| `orcats-linux-x64.tar.gz` | Linux x64 glibc |

Each tarball contains a single executable named `orcats`. `SHA256SUMS.txt` contains one checksum line per tarball.

## Installer

```bash
curl -fsSL https://github.com/ASRagab/orca-ts/releases/latest/download/install.sh | bash
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `ORCA_VERSION` | Install a specific GitHub Release version without the `v` prefix. |
| `ORCA_INSTALL_DIR` | Destination directory for the executable. |

## Release process

Releases are tag-driven. A `vX.Y.Z` tag runs the release workflow, verifies the repo, publishes GitHub Release binaries plus `install.sh`, and publishes `@twelvehart/orcats@X.Y.Z` to npm through Trusted Publishing.

The npm package is published from GitHub Actions with OIDC. The workflow does not use `NPM_TOKEN`; maintainers configure npm trust for `ASRagab/orca-ts` and `.github/workflows/release.yml` before tagging.
