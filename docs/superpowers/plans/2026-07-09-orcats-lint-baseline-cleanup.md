# Orcats Strict Lint Baseline Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all 79 pre-existing TypeScript ESLint errors without
changing Orcats runtime behavior, public contracts, output bytes, or test
strength, then make lint part of the deterministic CI gate.

**Architecture:** Treat the existing lint output as the RED regression test.
First make the isolated Astro site's generated types reproducible on a fresh
checkout, then fix the five code/test clusters with typed transformations that
retain their existing behavior. Add lint to `verify` only after the full lint
surface is green.

**Tech Stack:** Bun 1.3, TypeScript 5.9, ESLint 9, typescript-eslint 8,
Astro 6, Bun test.

## Global Constraints

- Preserve runtime behavior, public types, diagnostics, serialized events,
  process exit behavior, and output bytes.
- Do not lower or disable an ESLint rule, add an ESLint suppression, add an
  unsafe cast, weaken an assertion, or exclude a currently linted source file.
- Keep the website lockfile isolated. Do not add website packages to the root
  lockfile and do not commit `website/.astro` or `website/node_modules`.
- Keep live backend and model gates closed by default.
- Every task starts with its focused lint failure, preserves the focused
  behavioral tests, runs typecheck, commits, and receives an independent
  review before the next task starts.

---

### Task 1: Bootstrap website lint on fresh checkouts

**Files:**
- Modify: `package.json`
- Verify unchanged: `website/src/content.config.ts`

**Interfaces:**
- Consumes: `website/bun.lock` and Astro's `sync` command.
- Produces: a root lint command with generated `astro:content` types available.

- [ ] **Step 1: Verify RED on a fresh website state**

Move ignored `website/node_modules` and `website/.astro` aside, then run:

```bash
bunx eslint website/src/content.config.ts
```

Expected: exit 1 with exactly nine type-aware errors caused by unresolved
Astro/Starlight imports. Restore the ignored directories after capturing RED.

- [ ] **Step 2: Add the pinned website preparation command**

Set these exact root scripts while preserving every other script:

```json
"docs:site:prepare": "cd website && bun install --frozen-lockfile && bunx astro sync",
"lint": "bun run docs:site:prepare && eslint ."
```

Do not edit `website/src/content.config.ts`.

- [ ] **Step 3: Verify focused GREEN and the remaining baseline**

Run:

```bash
bun run docs:site:prepare
bunx eslint website/src/content.config.ts
bun run lint
```

Expected: preparation and focused website lint exit 0. Full lint reports only
the 70 genuine errors in the remaining 15 files and no website diagnostic.

- [ ] **Step 4: Verify lockfile and generated-file isolation**

Run:

```bash
git status --short
git diff --check
```

Expected: only `package.json` is tracked as changed; neither root nor website
lockfile changes; generated website files remain ignored.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "fix(lint): prepare Astro types before lint"
```

### Task 2: Clean strict diagnostics in diagnostic scripts

**Files:**
- Modify: `scripts/benchmark-acp-backends.ts`
- Modify: `scripts/capture-acp-transcripts.ts`

**Interfaces:**
- Consumes: existing script CLI arguments and environment gates.
- Produces: the same script behavior with explicit strict callback/string types.

- [ ] **Step 1: Verify RED**

```bash
bunx eslint scripts/benchmark-acp-backends.ts scripts/capture-acp-transcripts.ts
```

Expected: seven errors across the two files.

- [ ] **Step 2: Apply the exact behavior-preserving transformations**

In `scripts/benchmark-acp-backends.ts`:

- Change `LlmBackend<BackendTag>` to `LlmBackend`; remove `BackendTag` from the
  import only if it becomes unused.
- Change the rejection callback to `(error: unknown) => { ... }` and retain its
  existing `instanceof Error` narrowing.

In `scripts/capture-acp-transcripts.ts`:

- Remove only the unused `dirname` import.
- Change the PID interpolation to `${String(process.pid)}`.
- Change `String(update.sessionId ?? "")` to `update.sessionId ?? ""`.
- Change the shorthand timer callback to a block that calls `notify(...)`.
- Annotate the rejection callback parameter as `error: unknown` and retain its
  existing narrowing and message.

- [ ] **Step 3: Verify GREEN and type safety**

```bash
bunx eslint scripts/benchmark-acp-backends.ts scripts/capture-acp-transcripts.ts
bun run typecheck
```

Expected: both commands exit 0 with no warnings.

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark-acp-backends.ts scripts/capture-acp-transcripts.ts
git commit -m "fix(lint): tighten diagnostic script types"
```

### Task 3: Correct ACP process and promise contracts

**Files:**
- Modify: `src/backends/acp-client.ts`
- Modify: `src/backends/acp-run.ts`
- Modify: `src/backends/claude-run.ts`
- Modify: `tests/acp-client.test.ts`
- Modify: `tests/claude-backend.test.ts`

**Interfaces:**
- Consumes: `AcpProcess`, `AcpRequestHandler`, default piped Node/Bun child
  process, and Bun promise matchers.
- Produces: unchanged ACP request, response, error, exit, cancellation, stdin,
  stdout, and stderr behavior with accurate type contracts.

- [ ] **Step 1: Verify behavior GREEN and lint RED**

```bash
bun test tests/acp-client.test.ts tests/claude-backend.test.ts
bunx eslint src/backends/acp-client.ts src/backends/acp-run.ts src/backends/claude-run.ts tests/acp-client.test.ts tests/claude-backend.test.ts
```

Expected: tests pass; lint reports 32 errors.

- [ ] **Step 2: Protect the default piped-process behavior**

Add a focused `spawnAcpProcess` test that starts `process.execPath`, writes
`ping` to stdin, collects stdout and stderr, closes stdin, and asserts exact
stdout, exact stderr, and exit code `0`. Narrow optional stderr before reading
it and decode `Uint8Array` chunks without a cast.

- [ ] **Step 3: Correct `acp-client.ts` contracts**

- Declare `AcpRequestHandler` as returning `unknown`; line 199 continues to
  await synchronous values and promises.
- Keep `Deferred<void>` and use context typing with
  `Promise.withResolvers()` without an explicit `<void>`.
- Give the stored resolver arrow a block body.
- Rely on the literal three-pipe spawn overload: remove the impossible
  stdin/stdout guard, always return `stderr: child.stderr`, and call
  `child.stdin.write` and `child.stdin.end` directly.

- [ ] **Step 4: Correct ACP runner callback contracts**

In `src/backends/acp-run.ts`:

- Replace the async initialization callback with a synchronous callback that
  returns `Promise.resolve(createAcpClient(...))`.
- Type the rejection callback parameter as `unknown`.
- Forward prompt activity through `() => { watchdog.markActivity(); }`.
- Delete only the unused `delay` helper.

In `src/backends/claude-run.ts`, collapse the final proven ACP branch and its
identical fallback to one `return "acp"`.

- [ ] **Step 5: Correct test promise assertions without weakening them**

- Replace `await expect(promise).resolves...` with assertions on
  `await promise`.
- Add a helper that awaits a promise, returns the rejection only after
  `error instanceof Error`, and throws if the promise resolves or rejects with
  a non-Error. Assert the same rejection messages through this helper.
- Pass forwarding arrows instead of bare `process.push` and `process.pushRaw`
  methods in `tests/claude-backend.test.ts`.

- [ ] **Step 6: Verify GREEN**

```bash
bunx eslint src/backends/acp-client.ts src/backends/acp-run.ts src/backends/claude-run.ts tests/acp-client.test.ts tests/claude-backend.test.ts
bun test tests/acp-client.test.ts tests/claude-backend.test.ts
bun run typecheck
```

Expected: all commands exit 0 with no warnings.

- [ ] **Step 7: Commit**

```bash
git add src/backends/acp-client.ts src/backends/acp-run.ts src/backends/claude-run.ts tests/acp-client.test.ts tests/claude-backend.test.ts
git commit -m "fix(lint): correct ACP async contracts"
```

### Task 4: Correct baseline promise contracts

**Files:**
- Modify: `src/baseline/index.ts`
- Modify: `tests/baseline.test.ts`

**Interfaces:**
- Consumes: baseline repair callback and `fixLoop` reader contracts.
- Produces: the same repair, strict, and dirty-baseline outcomes using
  `undefined` as the no-result value.

- [ ] **Step 1: Verify behavior GREEN and lint RED**

```bash
bun test tests/baseline.test.ts
bunx eslint src/baseline/index.ts tests/baseline.test.ts
```

Expected: tests pass; lint reports 13 errors.

- [ ] **Step 2: Correct production promise contracts**

- Change the repair result union from `BaselineRepairResult | void` to
  `BaselineRepairResult | undefined`.
- Make the `fixLoop` reader non-async and return `Promise.resolve(ok(...))`.

- [ ] **Step 3: Correct test doubles and rejection assertions**

- Remove the unused `BaselinePolicy` import.
- Replace async callbacks with no await by non-async callbacks returning
  `Promise.resolve(result)` or `Promise.resolve(undefined)`.
- Remove the unused `_issues` parameter.
- Use the same narrowed rejected-Error helper as Task 3 for the two rejection
  assertions, preserving their exact expected messages.

- [ ] **Step 4: Verify GREEN**

```bash
bunx eslint src/baseline/index.ts tests/baseline.test.ts
bun test tests/baseline.test.ts
bun run typecheck
```

Expected: all commands exit 0 with no warnings.

- [ ] **Step 5: Commit**

```bash
git add src/baseline/index.ts tests/baseline.test.ts
git commit -m "fix(lint): correct baseline promise contracts"
```

### Task 5: Correct reporting callbacks and assertions

**Files:**
- Modify: `src/cli/main.ts`
- Modify: `src/monitor/index.ts`
- Modify: `src/run-output/index.ts`
- Modify: `tests/cli-run-output-validation.test.ts`
- Modify: `tests/run-output-integration.test.ts`
- Modify: `tests/run-output.test.ts`

**Interfaces:**
- Consumes: terminal TTY booleans, diagnostic writers, run events, and presenter
  handlers.
- Produces: byte-identical diagnostics and event output with fully awaited
  presenter calls and concrete assertions.

- [ ] **Step 1: Verify behavior GREEN and lint RED**

```bash
bun test tests/cli-run-output-validation.test.ts tests/run-output-integration.test.ts tests/run-output.test.ts
bunx eslint src/cli/main.ts src/monitor/index.ts src/run-output/index.ts tests/cli-run-output-validation.test.ts tests/run-output-integration.test.ts tests/run-output.test.ts
```

Expected: tests pass; lint reports 18 errors.

- [ ] **Step 2: Correct runtime callbacks without changing output**

- In CLI and monitor code, pass `process.stderr.isTTY` directly and wrap
  diagnostic writer calls in block-bodied callbacks.
- At both run-output sites, use
  `options.isTTY ?? process.stderr.isTTY` without comparing to `true`.

- [ ] **Step 3: Replace unsafe test matchers with concrete assertions**

- Add braces around the `expectExitZero(result)` callback.
- Replace `arrayContaining(objectContaining(...))` with three exact
  `toContainEqual({ name, status })` assertions.
- Assert `monitor.toJson()` fields directly; narrow the final event by its
  `type` before checking `artifact`.
- Replace typed-event `objectContaining` arguments with `.some(...)` predicates
  that preserve every existing field check.
- Make presenter tests async and await
  `Promise.resolve(presenter.handle(event))` before each assertion.

- [ ] **Step 4: Verify GREEN**

```bash
bunx eslint src/cli/main.ts src/monitor/index.ts src/run-output/index.ts tests/cli-run-output-validation.test.ts tests/run-output-integration.test.ts tests/run-output.test.ts
bun test tests/cli-run-output-validation.test.ts tests/run-output-integration.test.ts tests/run-output.test.ts
bun run typecheck
```

Expected: all commands exit 0 with no warnings.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts src/monitor/index.ts src/run-output/index.ts tests/cli-run-output-validation.test.ts tests/run-output-integration.test.ts tests/run-output.test.ts
git commit -m "fix(lint): tighten reporting contracts"
```

### Task 6: Make lint part of deterministic verification

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: the now-green root `lint` script.
- Produces: a CI/release `verify` gate that rejects future lint regressions.

- [ ] **Step 1: Verify the standalone lint gate is GREEN**

```bash
bun run lint
```

Expected: exit 0 with zero errors and zero warnings.

- [ ] **Step 2: Prepend lint to `verify`**

Set the script to the existing verification chain prefixed exactly by
`bun run lint && `; do not reorder or remove any existing verifier.

- [ ] **Step 3: Run integration verification**

```bash
bun audit --json
bun run verify
git diff --check
```

Expected: audit returns `{}`; verification and whitespace check exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "ci: enforce lint in verification"
```
