---
title: Standalone Binary
description: Install a release binary for no-node_modules execution.
---

The normal install path is the [npm package](../typed-authoring/). Use the standalone binary only when you want to run a flow on a Unix-like machine without creating a package first.

```bash
curl -fsSL https://github.com/ASRagab/orca-ts/releases/latest/download/install.sh | bash
```

The installer downloads the matching GitHub Release tarball, verifies `SHA256SUMS.txt`, and installs `orcats` to `${ORCA_INSTALL_DIR:-$HOME/.local/bin}`.

## Pin a release

```bash
ORCA_VERSION=0.2.2 ORCA_INSTALL_DIR="$HOME/.local/bin" \
  bash <(curl -fsSL https://github.com/ASRagab/orca-ts/releases/download/v0.2.2/install.sh)
```

## How flow imports resolve

The standalone binary can run a flow that imports from `@twelvehart/orcats` even when the flow project has no `node_modules`.

1. Orcats first tries to resolve `@twelvehart/orcats` from the flow file's project.
2. If a project-local package exists, that copy wins.
3. If no project package exists, the CLI registers the embedded API through a temporary `node_modules/@twelvehart/orcats` shim next to the flow.

In a zero-project directory with no `tsconfig.json`, the standalone binary skips the typecheck guard and emits a warning before running.

## Supported release artifacts

Release binaries are GitHub Release tarballs for macOS and Linux on arm64 and x64. Windows and musl/Alpine users should build from source for now.
