# Distribution

Orcats ships a scoped public npm package for normal project use and GitHub Release binaries for no-`node_modules` execution.

## NPM Package

For source-controlled flows, install the scoped package. Add TypeScript when you want editor feedback and the CLI typecheck preflight:

```bash
npm i @twelvehart/orcats
npm i -D typescript
bunx -p @twelvehart/orcats orcats flow.ts
```

The npm package provides the public TypeScript API and `bin.orcats`, a Bun shim that imports `src/cli/main.ts`. Bun `>=1.3.0` must be on `PATH` when running that shim.

## Standalone Binaries

Release binaries are built with `bun build --compile` and uploaded as tarballs:

| Asset | Platform |
| --- | --- |
| `orcats-darwin-arm64.tar.gz` | macOS Apple Silicon |
| `orcats-darwin-x64.tar.gz` | macOS Intel |
| `orcats-linux-arm64.tar.gz` | Linux arm64 glibc |
| `orcats-linux-x64.tar.gz` | Linux x64 glibc |

Each tarball contains a single executable named `orcats`. `SHA256SUMS.txt` contains one checksum line per tarball.

Windows and musl/Alpine users should build from source for now.

## Installer

`install.sh` detects OS and architecture, downloads the matching release tarball and `SHA256SUMS.txt`, verifies the checksum with `sha256sum` or `shasum`, and installs `orcats` to `${ORCA_INSTALL_DIR:-$HOME/.local/bin}`.

```bash
curl -fsSL https://github.com/ASRagab/orca-ts/releases/latest/download/install.sh | bash
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `ORCA_VERSION` | Install a specific GitHub Release version, with or without the `v` prefix |
| `ORCA_INSTALL_DIR` | Destination directory for the `orcats` executable |

Release installs do not execute `bin/orcats`; they install the compiled standalone binary built from `src/cli/main.ts`.

## Embedded Library Resolution

Standalone binaries can run a flow that imports `@twelvehart/orcats` without a local `node_modules` install:

1. The CLI first resolves `@twelvehart/orcats` from the flow file's directory.
2. If a project-local package exists, it wins. This avoids version skew and gives one flow context implementation.
3. If no project package exists, the CLI registers the binary's embedded runtime API through a temporary `node_modules/@twelvehart/orcats` shim next to the flow and removes it on process exit.

`orcats --version` reports the embedded library version used by the fallback path.

The embedded shim covers runtime imports from `@twelvehart/orcats`, `@twelvehart/orcats/loop`, and `@twelvehart/orcats/model`. It does not provide `@twelvehart/orcats/testing` or legacy package aliases. Projects that need typechecking, editor types, or `@twelvehart/orcats/testing` should add a local `@twelvehart/orcats` package dependency.

Standalone zero-project flows without `tsconfig.json` skip the CLI typecheck guard. Project typechecking needs `typescript`, `tsconfig.json`, and a local `@twelvehart/orcats` package dependency so the flow imports and runtime APIs resolve from the same project setup.

Run progress from both `orcats <flow.ts>` and `orcats run <loop>` is written to stderr from structured run-output events. Stdout remains reserved for explicit flow output and loop sink payloads, so scripts can capture payloads without parsing progress diagnostics.

## Run Output Dogfood

The black-box validation fixture can be run against any local git checkout without hard-coding the path in tests:

```bash
ORCA_VALIDATE_TARGET_REPO=/path/to/repo \
  bun ./bin/orcats run --no-typecheck tests/fixtures/repo-health-loop.ts \
  > /tmp/orca-health.stdout \
  2> /tmp/orca-health.stderr
```

Stdout should contain only the JSON health report: target path, discovered package scripts, check results, and `checkedAt`. Stderr should contain the operational transcript: preflight, run start, stage progress for script discovery / git status / package checks, loop cycle progress, and final summary. A healthy run exits `0`; a timeout or nonzero exit should be inspected with the captured command, exit code, signal, duration, stdout, and stderr evidence from `tests/helpers/cli-process.ts`.

To validate supervisor lifecycle, run the same fixture through `serve` and stop it after the child firing prints the report:

```bash
ORCA_VALIDATE_TARGET_REPO=/path/to/repo \
  bun ./bin/orcats serve --no-typecheck tests/fixtures/repo-health-loop.ts
```

`serve` writes the supervisor startup line on stderr, then inherits the child firing's stdout report and stderr progress. Press `Ctrl-C` after the report appears; shutdown should complete without a forced kill.

On this workstation, `/Users/aragab/Dev/repos/cursor-agents-sdk-ts` is a useful manual target when it exists:

```bash
test -d /Users/aragab/Dev/repos/cursor-agents-sdk-ts && \
  ORCA_VALIDATE_TARGET_REPO=/Users/aragab/Dev/repos/cursor-agents-sdk-ts \
  bun ./bin/orcats run --no-typecheck tests/fixtures/repo-health-loop.ts
```

## Verification

`bun run smoke:binary` is the load-bearing binary distribution check. It builds `dist/orcats`, checks `--help` and `--version`, then runs a flow from a temporary directory that imports `@twelvehart/orcats` with no project setup.

`bun run smoke:package` is the npm artifact check. It builds declarations, packs the npm package, installs the tarball into a temporary TypeScript project, typechecks imports from all public subpaths, and runs the installed `orcats --version` binary.
