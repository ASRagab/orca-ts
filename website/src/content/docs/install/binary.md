---
title: Standalone Binary
description: Install a release binary for no-node_modules execution.
---

The normal install path is the [npm package](../typed-authoring/). Use the standalone binary only when you want to run a flow on a Unix-like machine without creating a package first.

```bash
curl -fsSL https://github.com/ASRagab/orca-ts/releases/latest/download/install.sh | bash
```

The installer downloads the matching GitHub Release tarball, verifies
`SHA256SUMS.txt`, and installs the public `orcats` launcher plus adjacent private
`orcats-runtime` to `${ORCA_INSTALL_DIR:-$HOME/.local/bin}`. The launcher clears
ambient `BUN_OPTIONS` before entering the compiled runtime.

## Pin a release

```bash
ORCA_VERSION=0.4.0 ORCA_INSTALL_DIR="$HOME/.local/bin" \
  bash <(curl -fsSL https://github.com/ASRagab/orca-ts/releases/download/v0.4.0/install.sh)
```

## How flow imports resolve

The standalone binary can run a flow that imports from `@twelvehart/orcats` even when the flow project has no `node_modules`.

1. Orcats first tries to resolve `@twelvehart/orcats` from the flow file's project.
2. If a project-local package exists, that copy wins.
3. If no project package exists, the CLI registers the embedded API through a temporary `node_modules/@twelvehart/orcats` shim next to the flow.

In a zero-project directory, `orcats check <artifact.ts>` and execution preflight
use bundled offline compiler inputs. They require no target `tsconfig.json`,
TypeScript installation, Orcats dependency, or network access. A failed check
blocks backend startup.

## Supported release artifacts

Release binaries are GitHub Release tarballs for macOS and Linux on arm64 and x64. Windows and musl/Alpine users should build from source for now.
