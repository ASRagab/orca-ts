# Native Release Artifact Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace bypassable release-source validation with a verify-blocking smoke that builds and runs one host-native binary through the real release entrypoint.

**Architecture:** A pure options module owns supported targets, host mapping, and strict smoke-argument parsing. The release script keeps its no-argument four-target behavior and accepts a paired native-only smoke mode. The existing binary smoke invokes that exact entrypoint, runs its unarchived artifact against the repository `typescript` import flow, and cleans only its own temporary directory.

**Tech Stack:** Bun 1.3.x, TypeScript 5.9.x, `bun:test`, Node filesystem/path APIs.

## Global Constraints

- No-argument `build:release` still rebuilds all four existing targets under `dist/release`.
- Smoke mode requires both `--only-target=<target>` and `--release-dir=<path>`.
- Smoke mode accepts one of the four existing Bun release targets only.
- Explicit release directory must not exist; release builder never removes it.
- Unknown, duplicate, partial, empty, or unsupported arguments fail before filesystem mutation.
- Default CI stays deterministic and credential-free.
- No live backend, push, PR, CI wait, or merge occurs while implementing this plan.
- Preserve unrelated changes and both retained proving worktrees.

## File Map

- Create `scripts/release-build-options.ts`: pure target list, CLI parser, host-to-target mapping.
- Create `tests/release-build-options.test.ts`: parser and host-mapping contracts.
- Modify `scripts/build-release-binaries.ts`: consume parsed options and protect explicit output directories.
- Modify `scripts/smoke-binary.ts`: build and execute the host-native release artifact.
- Modify `scripts/validate-release.ts`: remove source-syntax behavior claim.
- Delete `scripts/release-build-validation.ts`: superseded AST validator.
- Delete `tests/release-build-validation.test.ts`: superseded mutation fixtures.
- Modify the three Correction 40 tracked documents and ignored runbook with final proof counts.

---

### Task 1: Strict release smoke options

**Files:**
- Create: `scripts/release-build-options.ts`
- Create: `tests/release-build-options.test.ts`

**Interfaces:**
- Produces: `ReleaseTargets`, `ReleaseTarget`, `ReleaseBuildOptions`, `parseReleaseBuildOptions(args, defaultReleaseDir?)`, and `releaseTargetForHost(platform?, arch?)`.
- Consumes: only `node:path` and process host facts.

- [ ] **Step 1: Write the failing parser and host-mapping tests**

```typescript
import { describe, expect, test } from "bun:test";
import {
  parseReleaseBuildOptions,
  releaseTargetForHost,
  ReleaseTargets,
} from "../scripts/release-build-options.ts";

describe("release build options", () => {
  test("no arguments preserve the four-target release", () => {
    const options = parseReleaseBuildOptions([], "dist/release-test");
    expect(options.targets).toEqual(ReleaseTargets);
    expect(options.releaseDir).toBe("dist/release-test");
    expect(options.replaceReleaseDir).toBe(true);
  });

  test("paired smoke arguments select one fresh directory", () => {
    const options = parseReleaseBuildOptions([
      "--only-target=bun-darwin-arm64",
      "--release-dir=/tmp/orcats-release-proof",
    ]);
    expect(options.targets).toEqual(["bun-darwin-arm64"]);
    expect(options.releaseDir).toBe("/tmp/orcats-release-proof");
    expect(options.replaceReleaseDir).toBe(false);
  });

  test("rejects partial smoke arguments", () => {
    for (const args of [
      ["--only-target=bun-darwin-arm64"],
      ["--release-dir=/tmp/orcats-release-proof"],
    ]) {
      expect(() => parseReleaseBuildOptions(args)).toThrow("smoke mode requires");
    }
  });

  test("rejects unknown, duplicate, empty, and unsupported arguments", () => {
    for (const args of [
      ["--wat=value", "--release-dir=/tmp/orcats-release-proof"],
      ["--only-target=bun-darwin-arm64", "--only-target=bun-linux-x64"],
      ["--release-dir=/tmp/a", "--release-dir=/tmp/b"],
      ["--only-target=", "--release-dir=/tmp/orcats-release-proof"],
      ["--only-target=bun-windows-x64", "--release-dir=/tmp/orcats-release-proof"],
    ]) {
      expect(() => parseReleaseBuildOptions(args)).toThrow();
    }
  });

  test("maps supported hosts and rejects every other host", () => {
    expect(releaseTargetForHost("darwin", "arm64")).toBe("bun-darwin-arm64");
    expect(releaseTargetForHost("darwin", "x64")).toBe("bun-darwin-x64");
    expect(releaseTargetForHost("linux", "arm64")).toBe("bun-linux-arm64");
    expect(releaseTargetForHost("linux", "x64")).toBe("bun-linux-x64");
    expect(() => releaseTargetForHost("darwin", "ppc64")).toThrow(
      "unsupported release smoke host: darwin/ppc64",
    );
    expect(() => releaseTargetForHost("win32", "x64")).toThrow(
      "unsupported release smoke host: win32/x64",
    );
  });
});
```

- [ ] **Step 2: Run the focused test and observe RED**

Run: `bun test tests/release-build-options.test.ts`

Expected: FAIL because `scripts/release-build-options.ts` does not exist.

- [ ] **Step 3: Implement the pure options module**

```typescript
import { join } from "node:path";

export const ReleaseTargets = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
] as const;

export type ReleaseTarget = (typeof ReleaseTargets)[number];

export interface ReleaseBuildOptions {
  readonly targets: readonly ReleaseTarget[];
  readonly releaseDir: string;
  readonly replaceReleaseDir: boolean;
}

const Usage =
  "smoke mode requires --only-target=<target> and --release-dir=<path>";

function isReleaseTarget(value: string): value is ReleaseTarget {
  return ReleaseTargets.includes(value as ReleaseTarget);
}

export function parseReleaseBuildOptions(
  args: readonly string[],
  defaultReleaseDir = join("dist", "release"),
): ReleaseBuildOptions {
  if (args.length === 0) {
    return {
      targets: ReleaseTargets,
      releaseDir: defaultReleaseDir,
      replaceReleaseDir: true,
    };
  }

  const values = new Map<"only-target" | "release-dir", string>();
  for (const arg of args) {
    const match = /^--(only-target|release-dir)=(.+)$/.exec(arg);
    const key = match?.[1];
    const value = match?.[2];
    if (
      (key !== "only-target" && key !== "release-dir") ||
      value === undefined ||
      values.has(key)
    ) {
      throw new Error(Usage);
    }
    values.set(key, value);
  }

  const target = values.get("only-target");
  const releaseDir = values.get("release-dir");
  if (values.size !== 2 || target === undefined || releaseDir === undefined) {
    throw new Error(Usage);
  }
  if (!isReleaseTarget(target)) {
    throw new Error(`unsupported release target: ${target}`);
  }

  return {
    targets: [target],
    releaseDir,
    replaceReleaseDir: false,
  };
}

export function releaseTargetForHost(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): ReleaseTarget {
  const candidate = `bun-${platform}-${arch}`;
  if (isReleaseTarget(candidate)) {
    return candidate;
  }
  throw new Error(`unsupported release smoke host: ${platform}/${arch}`);
}
```

- [ ] **Step 4: Run focused test, typecheck, and lint**

Run:

```bash
bun test tests/release-build-options.test.ts
bun run typecheck
bunx eslint scripts/release-build-options.ts tests/release-build-options.test.ts
```

Expected: 5 tests pass, 19 assertions; typecheck and lint exit 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/release-build-options.ts tests/release-build-options.test.ts
git commit -m "test(release): lock native smoke options"
```

---

### Task 2: Execute the real native release artifact

**Files:**
- Modify: `scripts/build-release-binaries.ts`
- Modify: `scripts/smoke-binary.ts`
- Modify: `scripts/validate-release.ts`
- Delete: `scripts/release-build-validation.ts`
- Delete: `tests/release-build-validation.test.ts`

**Interfaces:**
- Consumes: `parseReleaseBuildOptions(process.argv.slice(2))` and `releaseTargetForHost()` from Task 1.
- Produces: unchanged default release assets plus a paired host-only smoke mode.

- [ ] **Step 1: Wire strict options into the release entrypoint**

Replace the release script's target and directory setup with:

```typescript
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runQuiet, type QuietProcResult } from "../src/tools/process.ts";
import { parseReleaseBuildOptions } from "./release-build-options.ts";

const options = parseReleaseBuildOptions(process.argv.slice(2));
const releaseDir = options.releaseDir;
if (options.replaceReleaseDir) {
  await rm(releaseDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
} else {
  await mkdir(releaseDir);
}

const checksums: string[] = [];
const assets: string[] = [];

for (const target of options.targets) {
  const asset = target.replace(/^bun-/, "orcats-");
  const outDir = join(releaseDir, asset);
  const outFile = join(outDir, "orcats");
  const tarball = join(releaseDir, `${asset}.tar.gz`);

  await mkdir(outDir, { recursive: true });
  await mustRun("bun", [
    "build",
    "src/cli/main.ts",
    "--compile",
    "--compile-autoload-package-json",
    `--target=${target}`,
    `--outfile=${outFile}`,
  ]);
  await mustRun("tar", ["-czf", tarball, "-C", outDir, "orcats"]);

  const hash = new Bun.CryptoHasher("sha256");
  hash.update(await readFile(tarball));
  checksums.push(`${hash.digest("hex")}  ${asset}.tar.gz`);
  assets.push(tarball);
}

await writeFile(join(releaseDir, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`);

for (const asset of [...assets, join(releaseDir, "SHA256SUMS.txt")]) {
  console.log(asset);
}

async function mustRun(
  command: string,
  args: readonly string[],
): Promise<QuietProcResult> {
  const result = await runQuiet(command, args);
  if (result.isErr()) {
    throw new Error(
      `command failed: ${command} ${args.join(" ")}\n${JSON.stringify(result.error)}`,
    );
  }
  return result.value;
}
```

- [ ] **Step 2: Add the release artifact to the existing repository-flow smoke**

Import `releaseTargetForHost` and, inside the existing `repoFlowDir` `try`
block after the local binary assertion, add:

```typescript
  const releaseParent = await mkdtemp(
    join(tmpdir(), "orcats-release-binary-smoke-"),
  );
  try {
    const target = releaseTargetForHost();
    const releaseDir = join(releaseParent, "release");
    await mustRun("bun", [
      "run",
      "scripts/build-release-binaries.ts",
      `--only-target=${target}`,
      `--release-dir=${releaseDir}`,
    ]);
    const asset = target.replace(/^bun-/, "orcats-");
    const releaseBinary = resolve(releaseDir, asset, "orcats");
    const releaseFlow = await mustRun(releaseBinary, [
      "--no-typecheck",
      join(repoFlowDir, "flow.ts"),
    ]);
    expectIncludes(
      releaseFlow.stdout,
      "orcats-binary-repo-self-smoke-ok typescript=",
      "release binary repository workflow output with a project package import",
    );
  } finally {
    await rm(releaseParent, { recursive: true, force: true });
  }
```

Add this import:

```typescript
import { releaseTargetForHost } from "./release-build-options.ts";
```

- [ ] **Step 3: Remove the superseded syntax proof**

Delete `scripts/release-build-validation.ts` and
`tests/release-build-validation.test.ts`. In `scripts/validate-release.ts`,
remove:

```typescript
import { releaseBuildLoadsRuntimePackageJson } from "./release-build-validation.ts";
```

Remove the `releaseBinarySource` read and this check:

```typescript
if (!releaseBuildLoadsRuntimePackageJson(releaseBinarySource)) {
  failures.push("release binaries must enable runtime package.json loading");
}
```

- [ ] **Step 4: Run focused GREEN checks**

Run:

```bash
bun test tests/release-build-options.test.ts
bun run typecheck
bunx eslint scripts/release-build-options.ts tests/release-build-options.test.ts scripts/build-release-binaries.ts scripts/smoke-binary.ts scripts/validate-release.ts
bun run validate:release
bun run smoke:binary
git diff --check
```

Expected: 5 focused tests pass with 19 assertions; every other command exits 0.

- [ ] **Step 5: Prove the release smoke catches the original defect**

Temporarily remove only this release argv element with `apply_patch`:

```typescript
    "--compile-autoload-package-json",
```

Run: `bun run smoke:binary`

Expected: nonzero exit from the host-native release artifact with
`Cannot find package 'typescript'` while importing the repository flow.

Restore the exact element with `apply_patch`, then rerun:

```bash
bun run smoke:binary
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit Task 2**

```bash
git add package.json scripts/build-release-binaries.ts scripts/smoke-binary.ts scripts/validate-release.ts scripts/release-build-options.ts tests/release-build-options.test.ts
git commit -m "fix(release): smoke native release binary"
```

Confirm the deleted AST files are absent from `git status`; they were untracked
intermediate work and must not enter the commit.

---

### Task 3: Record and freeze the final proof

**Files:**
- Modify: `.orca/workflows/codebase-improvement.run.md`
- Modify: `docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md`
- Modify: `docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md`
- Modify: `docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md`

**Interfaces:**
- Consumes: final focused and full verification output from Tasks 1-2.
- Produces: one consistent Correction 40 proof record; ledger bytes remain unchanged.

- [ ] **Step 1: Run fresh deterministic verification**

Run: `bun run verify`

Expected: 466 pass, 1 gated skip, 0 fail, 1,336 assertions. The compiled binary
smoke must build and execute both local and host-native release binaries.

- [ ] **Step 2: Update only Correction 40 proof text**

In all four files, replace Correction 40's stale `461 tests` / `1,317
assertions` result with `466 tests` / `1,336 assertions`. Record that the
host-native release smoke replaced source-syntax validation and passed the
autoload-removal mutation proof. Keep every earlier correction's historical
counts unchanged.

- [ ] **Step 3: Verify documentation and immutable ledger facts**

Run:

```bash
bun run docs:check
git diff --check
wc -l .orca/improvement-loop/issues.jsonl
shasum -a 256 .orca/improvement-loop/issues.jsonl
```

Expected: doc links and diff check exit 0; ledger remains exactly 124 lines with
SHA-256 `fcd8e718290c2d15facac74bb1641fa3a94c60432af2b57e48caa95e4dc04758`.

- [ ] **Step 4: Rerun final verification after documentation changes**

Run: `bun run verify`

Expected: 466 pass, 1 gated skip, 0 fail, 1,336 assertions.

- [ ] **Step 5: Commit Task 3**

```bash
git add -f .orca/workflows/codebase-improvement.run.md docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md
git commit -m "docs: record native release proof"
```
