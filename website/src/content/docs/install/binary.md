---
title: Standalone Binary
description: Install and use the release binary without a package setup.
---

Use the standalone binary when you want to run a flow on a Unix-like machine without creating a package first.

```bash
curl -fsSL https://raw.githubusercontent.com/ASRagab/orca-ts/main/install.sh | bash
```

The installer downloads the matching GitHub Release tarball, verifies `SHA256SUMS.txt`, and installs `orca` to `${ORCA_INSTALL_DIR:-$HOME/.local/bin}`.

## Pin a release

```bash
ORCA_VERSION=0.1.0 ORCA_INSTALL_DIR="$HOME/.local/bin" \
  bash <(curl -fsSL https://raw.githubusercontent.com/ASRagab/orca-ts/main/install.sh)
```

## How flow imports resolve

The standalone binary can run a flow that imports from `orca-ts` even when the flow project has no `node_modules`.

1. Orca first tries to resolve `orca-ts` from the flow file's project.
2. If a project-local package exists, that copy wins.
3. If no project package exists, the CLI registers the embedded API through a temporary `node_modules/orca-ts` shim next to the flow.

In a zero-project directory with no `tsconfig.json`, the standalone binary skips the typecheck guard and emits a warning before running.

## Supported release artifacts

Release binaries are GitHub Release tarballs for macOS and Linux on arm64 and x64. Windows and musl/Alpine users should build from source for now.
