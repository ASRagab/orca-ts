# Finalization Parent Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make atomic final evidence publication work when its destination
parent does not yet exist, without weakening publication security.

**Architecture:** Prepare and validate the final parent before opening the
same-directory temporary file. Keep the existing identity, permission, flush,
cleanup, commit-decision, and rename sequence unchanged.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9, Zod 4, Bun test, Node filesystem
primitives.

## Global Constraints

- Create missing destination parents before temporary-file creation.
- Use owner-only mode `0o700` for newly created directories.
- Reject a final parent component that is not a directory or is a symbolic
  link.
- Keep the destination file at mode `0o600`.
- Call `context.commitPublication()` exactly once, immediately before rename.
- Perform no fallible operation after rename.
- Preserve primary publication errors and attach cleanup errors second.
- Do not run preflight, a live proving run, or any remote operation. Do not
  push, create a PR, or merge.
- Capture and preserve every pre-existing dirty path before staging anything.
- Import the ignored proving artifacts and both July 19 plans in one reviewed
  baseline commit so every later freeze input exists in `HEAD`.
- Use the repository's `orca-typecheck-flow.sh` for ignored workflow TypeScript.
  Root `typecheck` excludes `.orca/**`; do not claim that it covers this work.
- Use the pre-edit ESLint suppressions snapshot for the three ignored production
  workflow files. Root `lint` excludes `.orca/**`; no new unsuppressed workflow
  diagnostic is allowed.

## Plan Dependency

This plan is implementation Task 1 of 4. Complete and commit it first, then run
the independent Review 1 gate at the end of this plan. Do not enter
`docs/superpowers/plans/2026-07-19-scoped-scout-fanout.md`, which implements
Tasks 2-4, until Review 1 reports zero findings.

## File Map

| File | Responsibility |
|---|---|
| `.orca/workflows/codebase-improvement-runtime.ts` | Secure parent preparation and atomic publication. |
| `.orca/workflows/codebase-improvement-contract.test.ts` | Behavioral and mutation proof for publication ordering. |

---

## Execution Gate 0: Preserve And Import The Frozen Baseline

Run this gate before Task 1. It records the complete dirty tree with NUL-safe
path lists, freezes pre-edit workflow lint debt, and makes every ignored
artifact needed by the later `HEAD` freeze real and reviewable. The index is
known clean at plan-authoring time; if it is not clean at execution time, stop
instead of absorbing staged user work.

- [ ] **Gate 0.1: Capture the complete dirty baseline**

```bash
test ! -e /tmp/orcats-execution-baseline.root
git diff --cached --quiet
baseline_root=$(mktemp -d /tmp/orcats-execution-baseline.XXXXXX)
(set -o noclobber; printf '%s\n' "$baseline_root" \
  > /tmp/orcats-execution-baseline.root)
repo_root=$(git rev-parse --show-toplevel)
repair_base=$(git rev-parse HEAD)
printf '%s\n' "$repo_root" > "$baseline_root/repo-root.txt"
printf '%s\n' "$repair_base" > "$baseline_root/repair-base.txt"
git status --porcelain=v2 -z --untracked-files=all \
  > "$baseline_root/status.porcelain-v2.z"
git diff --binary --full-index --no-ext-diff \
  > "$baseline_root/unstaged.patch"
git diff --cached --binary --full-index --no-ext-diff \
  > "$baseline_root/staged.patch"
git diff --name-only -z > "$baseline_root/tracked-dirty.z"
git diff --cached --name-only -z > "$baseline_root/tracked-staged.z"
git ls-files --others --exclude-standard -z \
  > "$baseline_root/untracked-nonignored.z"
while IFS= read -r -d '' path; do
  if [[ -e "$path" || -L "$path" ]]; then
    printf '%s\0' "$path"
  fi
done < "$baseline_root/tracked-dirty.z" \
  > "$baseline_root/tracked-dirty-present.z"
cmp "$baseline_root/tracked-dirty.z" \
  "$baseline_root/tracked-dirty-present.z"
tar -cf "$baseline_root/tracked-dirty.tar" --null \
  -T "$baseline_root/tracked-dirty-present.z"
while IFS= read -r -d '' path; do
  mode=$(stat -f '%Lp' "$path")
  digest=$(shasum -a 256 "$path" | awk '{print $1}')
  printf '%s\0%s\0%s\0' "$path" "$mode" "$digest"
done < "$baseline_root/tracked-dirty-present.z" \
  > "$baseline_root/tracked-dirty-manifest.z"
```

Expected: every command exits zero; `tracked-staged.z` and `staged.patch` are
empty. The baseline currently contains fifteen tracked dirty paths. Do not
replace this dynamic capture with a hand-written allowlist.

- [ ] **Gate 0.2: Freeze existing workflow lint debt before production edits**

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
workflow_sources=(
  .orca/workflows/codebase-improvement.ts
  .orca/workflows/codebase-improvement-lib.ts
  .orca/workflows/codebase-improvement-runtime.ts
)
bunx eslint --no-ignore \
  --parser-options '{"projectService":{"allowDefaultProject":[".orca/workflows/*.ts"]}}' \
  --suppress-all \
  --suppressions-location "$baseline_root/workflow-eslint-suppressions.json" \
  "${workflow_sources[@]}"
test -s "$baseline_root/workflow-eslint-suppressions.json"
```

Expected: exit zero and a non-empty suppression file created before any
production edit. This is a baseline, not an exemption for new diagnostics.
The four legacy workflow test files are compiled and executed by their focused
Bun tests; their pre-existing strict-TypeScript and ESLint debt is outside this
repair.

- [ ] **Gate 0.3: Force-add and inspect the exact retained baseline/context**

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
git add -f -- \
  .orca/improvement-loop/issues.jsonl \
  .orca/workflows/codebase-improvement-artifacts.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement-lib.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement.config.json \
  .orca/workflows/codebase-improvement.sh \
  .orca/workflows/codebase-improvement.ts \
  docs/superpowers/plans/2026-07-19-finalization-parent-repair.md \
  docs/superpowers/plans/2026-07-19-scoped-scout-fanout.md
git diff --cached --name-only -z > "$baseline_root/import-staged.z"
git diff --cached --check
git ls-files --stage -- \
  .orca/improvement-loop/issues.jsonl \
  .orca/workflows/codebase-improvement-artifacts.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement-lib.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement.config.json \
  .orca/workflows/codebase-improvement.sh \
  .orca/workflows/codebase-improvement.ts \
  docs/superpowers/plans/2026-07-19-finalization-parent-repair.md \
  docs/superpowers/plans/2026-07-19-scoped-scout-fanout.md
git diff --cached -- \
  .orca/improvement-loop/issues.jsonl \
  .orca/workflows/codebase-improvement-artifacts.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement-lib.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement.config.json \
  .orca/workflows/codebase-improvement.sh \
  .orca/workflows/codebase-improvement.ts \
  docs/superpowers/plans/2026-07-19-finalization-parent-repair.md \
  docs/superpowers/plans/2026-07-19-scoped-scout-fanout.md
```

Expected staged paths are exactly the twelve literal paths above. Require mode
`100755` for `codebase-improvement.sh` and `100644` for the other eleven.
Neither the fifteen tracked dirty paths nor the clean July 19 design may appear
in the cached diff.

- [ ] **Gate 0.4: Commit the retained baseline/context separately**

```bash
git commit -m "chore(workflow): retain proving artifacts and repair plans"
```

Expected: one twelve-path import commit. Re-run the NUL status capture and
require it to match the pre-import baseline exactly:

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
git status --porcelain=v2 -z --untracked-files=all \
  > "$baseline_root/status.after-import.z"
cmp "$baseline_root/status.porcelain-v2.z" \
  "$baseline_root/status.after-import.z"
```

---

### Task 1 of 4: Prepare Missing Finalization Parents

**Files:**

- Modify: `.orca/workflows/codebase-improvement-contract.test.ts:1-12`
- Modify: `.orca/workflows/codebase-improvement-contract.test.ts:5822-5920`
- Modify: `.orca/workflows/codebase-improvement-contract.test.ts:9949-10227`
- Modify: `.orca/workflows/codebase-improvement-runtime.ts:1-13`
- Modify: `.orca/workflows/codebase-improvement-runtime.ts:758-833`

**Interfaces:**

- Consumes: `publishFinalizationText(destination, value, context)` and the
  existing `FinalizationContext` commit contract.
- Produces:
  `prepareFinalizationPublicationParent(destination: string): void` as a private
  runtime helper.

- [ ] **Step 1: Write the missing-parent failing test**

Add only `access` and `mkdir` to the existing `node:fs/promises` import;
`lstat` is already imported. Use this complete import block:

```ts
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
```

Place this test immediately before the existing predictable-symlink test:

```ts
test("finalization publication creates missing owner-only parents", async () => {
  const source = await Bun.file(path).text();
  const publish = await loadFinalizationTextPublisher(source);
  const root = await mkdtemp(join(tmpdir(), "orcats-finalization-parent-"));
  const firstParent = join(root, "missing");
  const parent = join(firstParent, "nested");
  const destination = join(parent, "report.json");
  const controller = new AbortController();
  let commitCalls = 0;
  try {
    await publish(destination, "published\n", "run", {
      signal: controller.signal,
      attempt: 1,
      remainingMs: () => 1_000,
      isCurrent: () => true,
      commitPublication: () => {
        commitCalls += 1;
        return { remainingMs: 1_000 };
      },
    });

    expect(await readFile(destination, "utf8")).toBe("published\n");
    const firstParentStatus = await lstat(firstParent);
    const parentStatus = await lstat(parent);
    const destinationStatus = await lstat(destination);
    expect(firstParentStatus.isDirectory()).toBe(true);
    expect(firstParentStatus.mode & 0o777).toBe(0o700);
    expect(parentStatus.isDirectory()).toBe(true);
    expect(parentStatus.mode & 0o777).toBe(0o700);
    expect(destinationStatus.isFile()).toBe(true);
    expect(destinationStatus.mode & 0o777).toBe(0o600);
    expect(commitCalls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication creates missing owner-only parents"
```

Expected: FAIL with `ENOENT` for a `report.json.tmp-...` path. The commit counter
must remain zero because temporary-file opening fails first.

- [ ] **Step 3: Write the symbolic-parent failing test**

Place this test immediately after the missing-parent test, before changing the
runtime:

```ts
test("finalization publication rejects a symbolic-link parent", async () => {
  const source = await Bun.file(path).text();
  const publish = await loadFinalizationTextPublisher(source);
  const root = await mkdtemp(join(tmpdir(), "orcats-finalization-parent-link-"));
  const external = join(root, "external");
  const linkedParent = join(root, "linked");
  const destination = join(linkedParent, "report.json");
  const controller = new AbortController();
  let commitCalls = 0;
  try {
    await mkdir(external, { mode: 0o700 });
    await symlink(external, linkedParent);

    await expect(
      publish(destination, "published\n", "run", {
        signal: controller.signal,
        attempt: 1,
        remainingMs: () => 1_000,
        isCurrent: () => true,
        commitPublication: () => {
          commitCalls += 1;
          return { remainingMs: 1_000 };
        },
      }),
    ).rejects.toThrow("is not a real directory");

    expect(commitCalls).toBe(0);
    await expect(access(join(external, "report.json"))).rejects.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run the symbolic-parent test and verify RED**

Run:

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication rejects a symbolic-link parent"
```

Expected: FAIL because publication resolves through the symbolic-link parent
instead of rejecting. This is the second observed RED before production code.

- [ ] **Step 5: Implement minimal parent preparation**

Add only `mkdirSync` to the existing `node:fs` import; `lstatSync` is already
imported. Use this complete import block:

```ts
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
```

Add this helper immediately before `publishFinalizationText()`:

```ts
function prepareFinalizationPublicationParent(destination: string): void {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const status = lstatSync(parent, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${parent} is not a real directory`);
  }
}
```

Call it as the first statement inside the publisher's existing `try` block:

```ts
  try {
    prepareFinalizationPublicationParent(destination);
    descriptor = openSync(
```

Do not move or change the existing `commitPublication`, `renameSync`, return, or
cleanup statements.

- [ ] **Step 6: Run the missing-parent test and verify GREEN**

Run:

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication creates missing owner-only parents"
```

Expected: PASS; both newly created nested directories are `0700`, the
destination file is `0600`, content is exact, and commit is called once.

- [ ] **Step 7: Run the symbolic-parent test and verify GREEN**

Run:

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication rejects a symbolic-link parent"
```

Expected: PASS with zero commit calls and no file created through the link.

- [ ] **Step 8: Write the mutation assertions before the AST checker**

In the existing `finalization publication rejects stale and terminal-order
mutants` test, place this complete block immediately after the
`insecureCreationMutations` loop:

```ts
  const parentPreparationMutations = [
    runtimeSource.replace(
      "    prepareFinalizationPublicationParent(destination);\n",
      "",
    ),
    runtimeSource.replace("mode: 0o700", "mode: 0o755"),
    runtimeSource.replace(
      "  if (!status.isDirectory() || status.isSymbolicLink()) {",
      "  if (!status.isDirectory()) {",
    ),
  ];
  for (const mutation of parentPreparationMutations) {
    expect(mutation).not.toBe(runtimeSource);
    expect(secureFinalizationPublicationContractIssues(mutation)).toContain(
      "finalization publication must create and validate its real owner-only parent before temporary-file creation",
    );
  }
```

- [ ] **Step 9: Run the mutation test and verify RED**

Run:

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication rejects stale and terminal-order mutants"
```

Expected: FAIL because `secureFinalizationPublicationContractIssues()` does
not yet return this exact issue for the new mutations:

```text
finalization publication must create and validate its real owner-only parent before temporary-file creation
```

This observed RED must occur before adding the AST checker code.

- [ ] **Step 10: Add the complete AST checker**

In `secureFinalizationPublicationContractIssues()`, replace the existing
`tryStatement` and `tryStatements` declarations with this complete block:

```ts
  const tryStatement = publisher?.body?.statements.find(ts.isTryStatement);
  const tryStatements = tryStatement?.tryBlock.statements ?? [];
  const parentPreparers = functionDeclarationsNamed(
    sourceFile,
    "prepareFinalizationPublicationParent",
  );
  const parentPreparer = parentPreparers[0];
  const parentText = parentPreparer?.getText(sourceFile) ?? "";
  const prepareCalls =
    publisher === undefined
      ? []
      : callsNamed(publisher, "prepareFinalizationPublicationParent");
  const prepareCall = prepareCalls[0];
  const firstTryStatement = tryStatements[0];
  if (
    parentPreparers.length !== 1 ||
    prepareCalls.length !== 1 ||
    prepareCall?.getText(sourceFile) !==
      "prepareFinalizationPublicationParent(destination)" ||
    firstTryStatement === undefined ||
    !ts.isExpressionStatement(firstTryStatement) ||
    firstTryStatement.expression !== prepareCall ||
    !parentText.includes(
      "mkdirSync(parent, { recursive: true, mode: 0o700 });",
    ) ||
    !parentText.includes("lstatSync(parent, { bigint: true })") ||
    !parentText.includes("!status.isDirectory()") ||
    !parentText.includes("status.isSymbolicLink()")
  ) {
    issues.push(
      "finalization publication must create and validate its real owner-only parent before temporary-file creation",
    );
  }
```

- [ ] **Step 11: Run the mutation test and verify GREEN**

Run:

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication rejects stale and terminal-order mutants"
```

Expected: PASS; all three parent mutations produce the exact contract issue.

- [ ] **Step 12: Run all publication and cleanup contract tests**

Run:

```bash
bun test .orca/workflows/codebase-improvement-contract.test.ts \
  --test-name-pattern "finalization publication|finalization cleanup"
```

Expected: every selected test passes with no warnings.

- [ ] **Step 13: Run the complete deterministic workflow test set**

Run:

```bash
bun test .orca/workflows/codebase-improvement-lib.test.ts \
  .orca/workflows/codebase-improvement-runtime.test.ts \
  .orca/workflows/codebase-improvement-contract.test.ts \
  .orca/workflows/codebase-improvement-artifacts.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 14: Typecheck and lint the ignored production workflow**

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
bash skills/orcats-author/scripts/orca-typecheck-flow.sh \
  .orca/workflows/codebase-improvement.ts
bunx eslint --no-ignore \
  --parser-options '{"projectService":{"allowDefaultProject":[".orca/workflows/*.ts"]}}' \
  --suppressions-location "$baseline_root/workflow-eslint-suppressions.json" \
  --pass-on-unpruned-suppressions \
  .orca/workflows/codebase-improvement-runtime.ts
```

Expected: `typecheck OK` and ESLint exit zero with no unsuppressed diagnostic.
The official flow checker reaches the runtime through the workflow import graph.

- [ ] **Step 15: Stage and inspect only Task 1 files**

```bash
git add -- .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement-contract.test.ts
git diff --cached --name-only
git diff --cached --check
git diff --cached -- \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement-contract.test.ts
```

Expected: `git diff --cached --name-only` lists exactly these two paths and no
others:

```text
.orca/workflows/codebase-improvement-contract.test.ts
.orca/workflows/codebase-improvement-runtime.ts
```

Expected: `git diff --cached --check` prints nothing. Inspect the staged diff
and require only the behavior tests, parent helper, publisher call, mutation
assertions, and AST contract changes specified above.

- [ ] **Step 16: Commit Task 1 in a separate final step**

```bash
git commit -m "fix(workflow): create finalization evidence parents"
```

Expected: one commit containing exactly the two paths inspected in Step 15.

- [ ] **Review 1: Independently review the finalization-parent task range**

```bash
baseline_root=$(cat /tmp/orcats-execution-baseline.root)
review_root="$baseline_root/task-reviews"
mkdir -p -m 0700 "$review_root"
review_file="$review_root/review-1-finalization-parent.txt"
base_file="$review_root/review-1-finalization-parent.base.txt"
if [[ ! -e "$base_file" ]]; then
  initial_head=$(git rev-parse HEAD)
  test "$(git show -s --format='%s' "$initial_head")" = \
    'fix(workflow): create finalization evidence parents'
  initial_base=$(git rev-parse "$initial_head^")
  test "$(git show -s --format='%s' "$initial_base")" = \
    'chore(workflow): retain proving artifacts and repair plans'
  (set -o noclobber; printf '%s\n' "$initial_base" > "$base_file")
fi
task_base=$(cat "$base_file")
approved_head=$(git rev-parse HEAD)
git merge-base --is-ancestor "$task_base" "$approved_head"
test "$(git rev-list --count "$task_base..$approved_head")" -ge 1
test "$(git log --format='%s' "$task_base..$approved_head" | \
  awk '$0 == "fix(workflow): create finalization evidence parents" { n += 1 } END { print n + 0 }')" -eq 1
git diff --check "$task_base..$approved_head"
git diff "$task_base..$approved_head" -- \
  .orca/workflows/codebase-improvement-runtime.ts \
  .orca/workflows/codebase-improvement-contract.test.ts
```

Give a fresh reviewer this plan, the approved July 19 repair design, the exact
task-range diff, and the recorded RED/GREEN/typecheck/lint evidence. A clean
verbatim response at `$review_file` must begin with these exact two lines and end
with literal `ZERO FINDINGS`:

```text
Base: <task_base>
Approved-Head: <approved_head>
...
ZERO FINDINGS
```

After saving the response, run:

```bash
test -s "$review_file"
test "$(sed -n '1p' "$review_file")" = "Base: $task_base"
test "$(sed -n '2p' "$review_file")" = "Approved-Head: $approved_head"
test "$(tail -n 1 "$review_file")" = 'ZERO FINDINGS'
test "$(git rev-parse HEAD)" = "$approved_head"
```

Require zero findings for correctness, security, test ordering, publication
ordering, and scope. On a finding, do not write or retain an approved review
file and never amend, rebase, squash, or rewrite the existing task commit.
Repair only the two Task 1 paths, rerun the focused checks, and add a new commit
named `fix(review): repair finalization-parent task`. Preserve `base_file`, then
repeat Review 1 over the full unchanged `task_base..HEAD` range. Only a clean,
commit-bound Review 1 authorizes scoped Task 1.
