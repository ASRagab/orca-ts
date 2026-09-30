# Distribution

Orcats ships a scoped public npm package for normal project use and GitHub Release binaries for no-`node_modules` execution.

## NPM Package

For source-controlled flows, install the scoped package. Add TypeScript only for editor feedback:

```bash
npm i @twelvehart/orcats
npm i -D typescript
bunx -p @twelvehart/orcats orcats flow.ts
```

The npm package provides the public TypeScript API and a POSIX `bin.orcats`
launcher. It unsets ambient `BUN_OPTIONS`, then enters Bun through
`src/cli/main.ts`; Bun `>=1.3.0` must be on `PATH`.

## Standalone Binaries

Release binaries are built with `bun build --compile` and uploaded as tarballs:

| Asset | Platform |
| --- | --- |
| `orcats-darwin-arm64.tar.gz` | macOS Apple Silicon |
| `orcats-darwin-x64.tar.gz` | macOS Intel |
| `orcats-linux-arm64.tar.gz` | Linux arm64 glibc |
| `orcats-linux-x64.tar.gz` | Linux x64 glibc |

Each tarball contains the public POSIX `orcats` launcher, its adjacent private
`orcats-runtime` executable, and the `checker/` compiler assets. Keep all three
together. The launcher clears `BUN_OPTIONS` before entering
the compiled runtime. `SHA256SUMS.txt` covers each complete tarball.

Windows and musl/Alpine users should build from source for now.

## Installer

`install.sh` detects OS and architecture, downloads the matching release tarball and `SHA256SUMS.txt`, verifies the checksum with `sha256sum` or `shasum`, and installs the launcher, runtime, and checker assets to `${ORCA_INSTALL_DIR:-$HOME/.local/bin}`.

```bash
curl -fsSL https://github.com/ASRagab/orca-ts/releases/latest/download/install.sh | bash
```

Environment variables:

| Variable | Meaning |
| --- | --- |
| `ORCA_VERSION` | Install a specific GitHub Release version, with or without the `v` prefix |
| `ORCA_INSTALL_DIR` | Destination directory for the `orcats` executable |

Release installs do not execute `bin/orcats`; they install the release launcher
private compiled runtime, and checker assets together.

## Embedded Library Resolution

Standalone binaries can run a flow that imports `@twelvehart/orcats` without a local `node_modules` install:

1. The CLI first resolves `@twelvehart/orcats` from the flow file's directory.
2. If a project-local package exists, it wins. This avoids version skew and gives one flow context implementation.
3. If no project package exists, the CLI registers the binary's embedded runtime API through a temporary `node_modules/@twelvehart/orcats` shim next to the flow and removes it on process exit.

`orcats --version` reports the embedded library version used by the fallback path.

The embedded shim covers runtime imports from `@twelvehart/orcats`, `@twelvehart/orcats/loop`, and `@twelvehart/orcats/model`. It does not provide `@twelvehart/orcats/testing` or legacy package aliases. Projects that need editor types or `@twelvehart/orcats/testing` should add a local `@twelvehart/orcats` package dependency.

`orcats check <artifact.ts>` typechecks one workflow or import-safe loop with
bundled TypeScript and public Orcats declarations. It works offline without a
target `tsconfig.json`, package dependency, or package-manager state, cleans its
temporary compiler project, and never imports or fires the artifact. Execution
uses the same check before backend startup unless `--no-typecheck` is explicit.

Relative imports resolve from the original artifact, so sibling helpers are
checked too. For a registered loop name, `run` and `serve` check every discovered
module before importing it; the loop name can differ from its filename.

Run progress from both `orcats <flow.ts>` and `orcats run <loop>` is written to stderr from structured run-output events. Stdout remains reserved for explicit flow output and loop sink payloads, so scripts can capture payloads without parsing progress diagnostics.

## Run Output Dogfood

The black-box validation fixture can be run against any local git checkout without hard-coding the path in tests:

```bash
ORCA_VALIDATE_TARGET_REPO=/path/to/repo \
  ./bin/orcats run --no-typecheck tests/fixtures/repo-health-loop.ts \
  > /tmp/orca-health.stdout \
  2> /tmp/orca-health.stderr
```

Stdout should contain only the JSON health report: target path, discovered package scripts, check results, and `checkedAt`. Stderr should contain the operational transcript: preflight, run start, stage progress for script discovery / git status / package checks, loop cycle progress, and final summary. A healthy run exits `0`; a timeout or nonzero exit should be inspected with the captured command, exit code, signal, duration, stdout, and stderr evidence from `tests/helpers/cli-process.ts`.

To validate supervisor lifecycle, run the same fixture through `serve` and stop it after the child firing prints the report:

```bash
ORCA_VALIDATE_TARGET_REPO=/path/to/repo \
  ./bin/orcats serve --no-typecheck tests/fixtures/repo-health-loop.ts
```

`serve` writes the supervisor startup line on stderr, then inherits the child firing's stdout report and stderr progress. Press `Ctrl-C` after the report appears; shutdown should complete without a forced kill.

On this workstation, `/Users/aragab/Dev/repos/cursor-agents-sdk-ts` is a useful manual target when it exists:

```bash
test -d /Users/aragab/Dev/repos/cursor-agents-sdk-ts && \
  ORCA_VALIDATE_TARGET_REPO=/Users/aragab/Dev/repos/cursor-agents-sdk-ts \
  ./bin/orcats run --no-typecheck tests/fixtures/repo-health-loop.ts
```

## Verification

`bun run smoke:binary` builds the binary and a host release, runs the real installer against that release, then checks and executes a flow from a temporary directory with no project setup. It also verifies that ambient `BUN_OPTIONS` does not reach the installed runtime or its child processes.

`bun run smoke:package` is the npm artifact check. It builds checker assets, enforces size budgets, packs the npm package, installs the tarball into a temporary TypeScript project, typechecks imports from all public subpaths, and runs the installed `orcats --version` binary.

`bun run validate:release` builds checker assets before measuring package size.
Release builds and npm package smoke run this gate against the completed payload;
the recorded maxima cannot exceed 110% of each baseline rounded up to a KiB.
