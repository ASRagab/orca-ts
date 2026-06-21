---
title: Distribution And Release
description: GitHub Release binaries, installer behavior, and tag-driven releases.
---

Orca ships `@twelvehart/orca-ts` for typed authoring and GitHub Release binaries for zero-dependency execution.

## Release assets

| Asset | Platform |
| --- | --- |
| `orca-darwin-arm64.tar.gz` | macOS Apple Silicon |
| `orca-darwin-x64.tar.gz` | macOS Intel |
| `orca-linux-arm64.tar.gz` | Linux arm64 glibc |
| `orca-linux-x64.tar.gz` | Linux x64 glibc |

Each tarball contains a single executable named `orca`. `SHA256SUMS.txt` contains one checksum line per tarball.

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

Releases are tag-driven. A `vX.Y.Z` tag runs the release workflow, verifies the repo, publishes GitHub Release binaries plus `install.sh`, and publishes `@twelvehart/orca-ts@X.Y.Z` to npm through Trusted Publishing.

The npm package is published from GitHub Actions with OIDC. The workflow does not use `NPM_TOKEN`; maintainers configure npm trust for `ASRagab/orca-ts` and `.github/workflows/release.yml` before tagging.
