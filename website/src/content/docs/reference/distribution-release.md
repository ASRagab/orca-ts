---
title: Distribution And Release
description: GitHub Release binaries, installer behavior, and tag-driven releases.
---

Orca currently ships through GitHub Release binaries. npm publishing is deferred.

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
curl -fsSL https://raw.githubusercontent.com/ASRagab/orca-ts/main/install.sh | bash
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `ORCA_VERSION` | Install a specific GitHub Release version without the `v` prefix. |
| `ORCA_INSTALL_DIR` | Destination directory for the executable. |

## Release process

Releases are tag-driven. A `vX.Y.Z` tag runs the release workflow, verifies the repo, and publishes GitHub Release binaries plus `install.sh`.

Do not add an `NPM_TOKEN` recovery path. If npm publishing returns, it should use Trusted Publishing to a private `@twelvehart` package.
