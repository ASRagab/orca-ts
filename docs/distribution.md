# Distribution

Orca currently ships through GitHub Release binaries for common Unix platforms.

## Typed Project Authoring

For editor and project typecheck support in source-controlled flows, add an Orca package dependency plus TypeScript, then run with the standalone `orca` binary:

```bash
bun add -d git+https://github.com/ASRagab/orca-ts.git typescript
orca flow.ts
```

## Standalone Binaries

Release binaries are built with `bun build --compile` and uploaded as tarballs:

| Asset | Platform |
| --- | --- |
| `orca-darwin-arm64.tar.gz` | macOS Apple Silicon |
| `orca-darwin-x64.tar.gz` | macOS Intel |
| `orca-linux-arm64.tar.gz` | Linux arm64 glibc |
| `orca-linux-x64.tar.gz` | Linux x64 glibc |

Each tarball contains a single executable named `orca`. `SHA256SUMS.txt` contains one checksum line per tarball.

Windows and musl/Alpine users should build from source for now.

## Installer

`install.sh` detects OS and architecture, downloads the matching release tarball and `SHA256SUMS.txt`, verifies the checksum with `sha256sum` or `shasum`, and installs `orca` to `${ORCA_INSTALL_DIR:-$HOME/.local/bin}`.

```bash
curl -fsSL https://github.com/ASRagab/orca-ts/releases/latest/download/install.sh | bash
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `ORCA_VERSION` | Install a specific GitHub Release version, with or without the `v` prefix |
| `ORCA_INSTALL_DIR` | Destination directory for the `orca` executable |

`bin/orca` is the Bun shim used by source checkouts and Git/source dependencies. Release installs do not execute that file; they install the compiled standalone binary built from `src/cli/main.ts`.

## Embedded Library Resolution

Standalone binaries can run a flow that imports `orca-ts` without a local `node_modules` install:

1. The CLI first resolves `orca-ts` from the flow file's directory.
2. If a project-local package exists, it wins. This avoids version skew and gives one flow context implementation.
3. If no project package exists, the CLI registers the binary's embedded runtime API through a temporary `node_modules/orca-ts` shim next to the flow and removes it on process exit.

`orca --version` reports the embedded library version used by the fallback path.

The embedded shim covers runtime imports from `orca-ts`, `orca-ts/loop`, and `orca-ts/model`. Projects that need typechecking, editor types, or `orca-ts/testing` should add a local `orca-ts` Git/source dependency.

Standalone zero-project flows without `tsconfig.json` skip the CLI typecheck guard. Project typechecking needs `typescript`, `tsconfig.json`, and a local `orca-ts` Git/source dependency so the flow imports and runtime APIs resolve from the same project setup.

## Verification

`bun run smoke:binary` is the load-bearing distribution check. It builds `dist/orca`, checks `--help` and `--version`, then runs a flow from a temporary directory that imports `orca-ts` with no project setup.
