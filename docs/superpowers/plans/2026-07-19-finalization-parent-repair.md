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
```

### Task 1: Prepare Missing Finalization Parents

**Files:**

- Modify: `.orca/workflows/codebase-improvement-contract.test.ts`
- Modify: `.orca/workflows/codebase-improvement-runtime.ts`

**Interfaces:**

- Consumes: `publishFinalizationText(destination, value, runId, context)` and
  `FinalizationContext`.
- Produces: private
  `prepareFinalizationPublicationParent(destination: string): void`.

- [ ] **Step 1: Write the missing-parent RED**

Add `access` and `mkdir` to the existing promise filesystem import. Immediately
before the predictable-symlink test, add this behavior test:

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
    }));
    expect(await readFile(destination, "utf8")).toBe("published\n");
    expect((await lstat(dirname(dirname(destination)))).mode & 0o777).toBe(0o700);
    expect((await lstat(dirname(destination))).mode & 0o777).toBe(0o700);
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

- [ ] **Step 3: Write the symbolic-parent RED**

Create an owner-only external directory, symbolic-link the requested parent to
it, publish `report.json`, and require rejection containing `is not a real
directory`, zero commit calls, and no file below the external directory.

- [ ] **Step 4: Observe the symbolic-parent RED**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication rejects a symbolic-link parent"
```

Expected: the old publisher follows the link, so the test fails before runtime
code changes.

- [ ] **Step 5: Implement the minimal private helper**

Add `mkdirSync` beside the existing synchronous filesystem imports and add the
following helper immediately before `publishFinalizationText`:

```ts
function prepareFinalizationPublicationParent(destination: string): void {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const status = lstatSync(parent, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(parent + " is not a real directory");
  }
}
```

Invoke it as the first statement inside the publisher's existing `try` block.
Do not move `commitPublication`, `renameSync`, return, or cleanup statements.

- [ ] **Step 6: Verify both GREEN behaviors**

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication creates missing owner-only parents|finalization publication rejects a symbolic-link parent"
```

Expected: both tests pass; the missing hierarchy is real `0700` directories,
the output is exact `0600`, and the link test creates no external output.

- [ ] **Step 7: Add mutation proof before changing the AST checker**

Extend the existing secure-publication mutation test with three source mutations:
remove the helper call, replace `mode: 0o700` with `mode: 0o755`, and remove the
symbolic-link predicate. Require each mutation to produce exactly:

```text
finalization publication must create and validate its real owner-only parent before temporary-file creation
```

Run that mutation selection and observe RED before editing the checker.

- [ ] **Step 8: Implement the AST contract**

Require exactly one helper declaration, exactly one
`prepareFinalizationPublicationParent(destination)` call, first position in the
publisher try block, recursive `0700` mkdir, bigint lstat, directory predicate,
and symbolic-link predicate. The checker must emit the Step 7 issue for every
missing or reordered part.

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
commit over the same base-to-current range, then re-reviewed. Do not begin the
 scout/delivery plan until Review 1 literally ends `ZERO FINDINGS`.
