# Finalization Parent Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and validate owner-only finalization parents without weakening
atomic evidence publication or the active-ready/delivery contract.

**Architecture:** Preserve the existing same-directory exclusive temporary-file,
identity, flush, commit-decision, rename, and cleanup sequence. Add a private
parent-preparation helper as the first fallible operation in the publisher. This
task is independent of scout and delivery behavior, but uses their rebaselined
active clock and finalization protections.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, Zod 4, Bun test, Node filesystem
primitives.

## Global Constraints

- The retained baseline commit is `18cbac02f5a77174ec92066066d768a00a997b21`.
  It contains exactly the twelve retained workflow artifacts and plans; the
  fifteen pre-existing tracked edits remain unstaged and byte-preserved.
- Active success ends at ready PR. Delivery, CI polling, and SHA-locked merge
  are separate work defined by the July 20 rebaseline design.
- Simple scout is 15 seconds gather, 120 seconds shared fan-out/settlement, and
  20 seconds validation. Nothing in this task reinstates sequential scouting.
- New parents are `0700`; the final file is `0600`; every parent component is a
  real directory, never a symbolic link.
- `commitPublication()` executes once, immediately before rename; no fallible
  operation follows rename.
- Preserve the primary publication error and attach cleanup errors second.
- Run no preflight, backend, push, PR, CI watch, merge, or GitHub mutation.
- Use `skills/orcats-author/scripts/orca-typecheck-flow.sh` and the existing
  `/tmp/orcats-execution-baseline.root` ESLint suppressions. Root lint/typecheck
  do not cover `.orca/**`.

## Retained Dirty-Baseline Gate

Before every task commit, every additive review-repair commit, and the final
freeze, run this exact comparator from the implementation worktree. It consumes
the captured NUL path list and tar copy; it fails if any retained path's bytes,
file type, symbolic-link target, or permission mode changed. It deliberately
does not require the working tree to contain no new task paths.

```bash
verify_retained_dirty_baseline() (
  set -euo pipefail
  baseline_root=$(cat /tmp/orcats-execution-baseline.root)
  comparison_root=$(mktemp -d "${TMPDIR:-/tmp}/orca-dirty-baseline.XXXXXX")
  trap 'rm -rf "$comparison_root"' EXIT
  tar -xf "$baseline_root/tracked-dirty.tar" -C "$comparison_root"
  python3 - "$baseline_root/tracked-dirty.z" "$comparison_root" "$PWD" <<'PY'
import os
import stat
import sys
from pathlib import Path

listed = Path(sys.argv[1]).read_bytes().split(b"\0")
paths = [os.fsdecode(item) for item in listed if item]
archive_root = Path(sys.argv[2])
worktree_root = Path(sys.argv[3])
if not paths or len(paths) != len(set(paths)):
    raise SystemExit("captured retained-dirty NUL list is empty or duplicated")
for path in paths:
    parts = Path(path).parts
    if Path(path).is_absolute() or ".." in parts:
        raise SystemExit(f"unsafe retained-dirty path: {path}")
    expected = archive_root / path
    actual = worktree_root / path
    if not expected.exists() and not expected.is_symlink():
        raise SystemExit(f"archive omits retained path: {path}")
    if not actual.exists() and not actual.is_symlink():
        raise SystemExit(f"retained path is missing: {path}")
    expected_stat = os.lstat(expected)
    actual_stat = os.lstat(actual)
    if stat.S_IFMT(expected_stat.st_mode) != stat.S_IFMT(actual_stat.st_mode):
        raise SystemExit(f"retained file type changed: {path}")
    if stat.S_IMODE(expected_stat.st_mode) != stat.S_IMODE(actual_stat.st_mode):
        raise SystemExit(f"retained mode changed: {path}")
    if stat.S_ISREG(expected_stat.st_mode):
        if expected.read_bytes() != actual.read_bytes():
            raise SystemExit(f"retained contents changed: {path}")
    elif stat.S_ISLNK(expected_stat.st_mode):
        if os.readlink(expected) != os.readlink(actual):
            raise SystemExit(f"retained link target changed: {path}")
    else:
        raise SystemExit(f"unsupported retained file type: {path}")
PY
  printf '%s\n' 'retained dirty baseline: OK'
)
```

## Prerequisite Evidence

Before editing, require the captured baseline files, empty index, and retained
baseline commit:

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
test "$(git rev-parse HEAD)" = 18cbac02f5a77174ec92066066d768a00a997b21
git diff --cached --quiet
test -s "$baseline_root/tracked-dirty.z"
test -s "$baseline_root/workflow-eslint-suppressions.json"
test -f "$baseline_root/tracked-dirty.tar"
verify_retained_dirty_baseline
```

### Task 1: Prepare Missing Finalization Parents

**Files:**

- Modify: `.orca/workflows/codebase-improvement-contract.test.ts`
- Modify: `.orca/workflows/codebase-improvement-runtime.ts`

**Interfaces:**

- Consumes: `publishFinalizationText(destination, value, runId, context)` and
  `FinalizationContext`.
- Produces: private
  `prepareFinalizationPublicationParent(destination, publicationRoot): void`,
  where `publicationRoot` is the already-selected owner-only run directory.

- [ ] **Step 1: Write the missing-parent RED**

Add `access`, `mkdir`, and `chmod` to the existing promise filesystem import.
Add an `expectRealOwnerOnlyDirectory()` helper that requires `isDirectory()`,
`isSymbolicLink() === false`, and mode `0700`. Immediately before the
predictable-symlink test, add this behavior test:

```ts
test("finalization publication creates missing owner-only parents", async () => {
  const publish = await loadFinalizationTextPublisher(await Bun.file(path).text());
  const root = await mkdtemp(join(tmpdir(), "orcats-finalization-parent-"));
  const destination = join(root, "missing", "nested", "report.json");
  let commits = 0;
  try {
    await publish(destination, "published\n", "run", finalizationContext(() => {
      commits += 1;
      return { remainingMs: 1_000 };
    }, { publicationRoot: root }));
    expect(await readFile(destination, "utf8")).toBe("published\n");
    await expectRealOwnerOnlyDirectory(join(root, "missing"));
    await expectRealOwnerOnlyDirectory(join(root, "missing", "nested"));
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    expect(commits).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Observe RED**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication creates missing owner-only parents"
```

Expected: `ENOENT` opening the same-directory temporary file and zero commit
calls.

- [ ] **Step 3: Write direct and intermediate symbolic-parent RED tests**

Keep the direct symbolic-parent test. Add a second test that creates owner-only
`root/managed` and external directories, symbolic-links
`root/managed/intermediate` to the external directory, then targets
`root/managed/intermediate/nested/report.json`. Both tests require rejection
containing `is not a real owner-only directory`, zero commit calls, and no file
below the external directory. The intermediate test must fail against an
implementation that validates only `dirname(destination)`.

- [ ] **Step 4: Observe both symbolic-parent RED tests**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication rejects a (direct|intermediate) symbolic-link parent"
```

Expected: the old publisher follows the intermediate link before its final-parent
check, so the new intermediate test fails before runtime code changes.

- [ ] **Step 5: Implement the minimal private helper**

Add `mkdirSync`, `isAbsolute`, `relative`, `resolve`, and `sep` beside the existing synchronous
filesystem imports. Add the following helpers immediately before
`publishFinalizationText`; callers pass their already-selected run directory as
`publicationRoot`, never an ambient filesystem ancestor:

```ts
function assertRealOwnerOnlyDirectory(path: string): void {
  const status = lstatSync(path, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink() ||
      (status.mode & 0o777n) !== 0o700n) {
    throw new Error(path + " is not a real owner-only directory");
  }
}

function prepareFinalizationPublicationParent(
  destination: string,
  publicationRoot: string,
): void {
  const root = resolve(publicationRoot);
  const parent = resolve(dirname(destination));
  const suffix = relative(root, parent);
  if (suffix.startsWith("..") || isAbsolute(suffix)) {
    throw new Error(parent + " is outside its publication root");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertRealOwnerOnlyDirectory(root);
  let component = root;
  for (const segment of suffix.split(sep).filter(Boolean)) {
    component = join(component, segment);
    try {
      lstatSync(component, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(component, { mode: 0o700 });
    }
    assertRealOwnerOnlyDirectory(component);
  }
}
```

Invoke it as the first statement inside the publisher's existing `try` block.
The component-by-component `lstatSync` must happen before creation of the next
component, so an intermediate symbolic link cannot receive a nested write. Do
not move `commitPublication`, `renameSync`, return, or cleanup statements.

- [ ] **Step 6: Verify both GREEN behaviors**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication creates missing owner-only parents|finalization publication rejects a (direct|intermediate) symbolic-link parent"
```

Expected: both tests pass; the missing hierarchy is real `0700` directories,
the output is exact `0600`, and neither link test creates external output.

- [ ] **Step 7: Add mutation proof before changing the AST checker**

Extend the existing secure-publication mutation test with four source mutations:
remove the helper call, replace `mode: 0o700` with `mode: 0o755`, and remove the
symbolic-link predicate. Add a fourth mutation that changes the component loop
to validate only the final parent. Require each mutation to produce exactly:

```text
finalization publication must create and validate its real owner-only parent before temporary-file creation
```

Run that mutation selection and observe RED before editing the checker.

- [ ] **Step 8: Implement the AST contract**

Require exactly one helper declaration, exactly one
`prepareFinalizationPublicationParent(destination, context.publicationRoot)`
call, first position in the
publisher try block, owner-only publication root, component-by-component
non-recursive `0700` mkdir, bigint lstat before each next component, directory
predicate, symbolic-link predicate, and `0700` mode predicate. The checker must
emit the Step 7 issue for every missing or reordered part.

- [ ] **Step 9: Verify GREEN and the focused publication family**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication|finalization cleanup"
```

Expected: all selected tests pass, including every prior ordering and cleanup
case.

- [ ] **Step 10: Run supported workflow checks**

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
/bin/bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
bunx eslint --no-ignore \
  --parser-options '{"projectService":{"allowDefaultProject":[".orca/workflows/*.ts"]}}' \
  --suppressions-location "$baseline_root/workflow-eslint-suppressions.json" \
  --pass-on-unpruned-suppressions \
  .orca/workflows/codebase-improvement-runtime.ts
```

Expected: `typecheck OK` and no new unsuppressed runtime diagnostic.

- [ ] **Step 11: Commit only the reviewed task paths**

```bash
verify_retained_dirty_baseline
git add -- .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement-contract.test.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "fix(workflow): create finalization evidence parents"
```

Expected cached paths: exactly the two paths above. Do not stage any preserved
dirty documentation or source file.

## Review 1

Bind a fresh correctness reviewer to the retained baseline commit and the final
Task 1 head. Supply the exact range diff, both observed RED outputs, GREEN
outputs, typecheck/lint evidence, and the July 20 active/delivery design. Save
the verbatim response under `$baseline_root/task-reviews/` with these exact first
lines and final line:

```text
Base: <retained-baseline-commit>
Approved-Head: <task-1-head>
...
ZERO FINDINGS
```

Any finding is repaired with a new `fix(review): repair finalization-parent task`
commit over the same base-to-current range after
`verify_retained_dirty_baseline`, then re-reviewed. Do not begin the
scout/delivery plan until Review 1 literally ends `ZERO FINDINGS`.
