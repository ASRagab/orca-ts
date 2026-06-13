# Codegen rules + pre-handoff self-audit

Rules that keep generated orca-ts flows compiling and behaving. Apply every rule
while filling a template; then run the self-audit checklist before handing the
flow back (and before the typecheck gate, when one is reachable).

## Generation rules

1. **Import from `"orca-ts"`** — the package name, not a relative `../src/...`
   path. The standalone binary resolves `orca-ts` through its embedded shim; a
   relative path only works inside this repo. The in-repo examples import from
   `../src/index.ts`; **shipped flows must not**.
2. **One `flow(...)` call wraps everything.** Pass `flowArgs()` (from `orca-ts`)
   — never `process.argv`. The CLI puts the flow path and its own flags
   (`--backend`, …) in `process.argv`; `flowArgs()` returns only the user's task
   tokens (everything after `--`), so `orca flow.ts --backend codex -- fix bug`
   yields `["fix","bug"]`. Call accessors (`fs()`, `git()`, `llm()`, …)
   **inside** the body, never at module scope.
3. **Always narrow `outcome.type`** before touching `outcome.result`. Reading
   `.result.output`/`.structured` on a non-`success` outcome is a type error and
   a runtime bug.
4. **`selectBackend` vs pinned.** Use `selectBackend({ default })` for saved,
   re-runnable workflows so `--backend` works. Use `claude()`/`codex()`/… only
   when the flow must pin one backend; pinned calls ignore `--backend`.
5. **OpenCode shutdown is mandatory.** Whenever a flow can run on OpenCode (any
   `selectBackend` flow, or a pinned `opencode()` flow), wrap the work in
   `try { … } finally { await selected.shutdown?.(); }`. Pinned non-OpenCode
   flows still benefit from the harmless optional-chain.
6. **`fixLoop` issue shape.** The issue type must have `fixable: boolean`.
   Return `ok([])` from `evaluate` to converge; return `ok(issues)` with at
   least one `fixable: true` to trigger a fix round. Provide a `stalled`
   detector to stop on no-progress (rule 8).
7. **`Result` discipline.** Tool/loop calls return a `Result`; use
   `.isErr()` / `.isOk()` / `.value` / `.error`, or `ok(...)`/`err(...)` to
   build them. Import `ok`/`err` (and the `Result` type) **from `"orca-ts"`** —
   never from `"neverthrow"` directly. The standalone binary embeds only the
   `orca-ts` surface; a bare `neverthrow` import crashes a flow in a target repo
   that doesn't happen to have `node_modules/neverthrow`.
8. **No-progress detection.** A `stalled` callback owns its own history (a
   `Set` of normalized failure signatures). Returning `true` stops the loop as
   `stuck`. Normalize signatures (strip line numbers/paths) so a re-emitted
   identical failure is recognized — see `makeStallDetector` in
   `workflows/ai-slop-cleanup.ts`.
9. **Verification gates are commands.** Wire the target repo's real test/lint
   commands through `command().run({ command, args })` and treat
   `result.type !== "success"` as failure. Never hardcode `bun`/`npm` — slot in
   the commands the author skill detected for *this* repo.
10. **Zod for non-native backends.** When a flow may run on `pi` (or OpenCode
    for structured output), wrap brittle fields in `z.preprocess(...)` and be
    ready to parse JSON from `outcome.result.output`.
11. **Standalone typecheck skip.** In a repo with no `tsconfig.json`, the `orca`
    binary **skips** its typecheck pre-flight and warns. The flow still runs;
    correctness rides on this cookbook + the CI-gated templates. Note this in
    the runbook for non-TS targets.
12. **Never destroy or publish unrelated work.** A flow that mutates the repo
    must protect the user's tree: require a clean baseline (or auto-stash and
    restore) before editing; cut a feature branch before commit/push (never
    commit on the base branch); stage only workflow-owned paths; and when
    reverting, revert *only* this iteration's own change. Detect and revert
    off-target edits (files the agent touched but wasn't asked to). Destructive
    or irreversible ops (force-push, history rewrite, `reset --hard`, broad
    `clean -fd`) are never auto-performed — escalate to the user.
13. **Typed-lint repos must ignore the workflow dir.** If the target repo lints
    TypeScript with type information (e.g. ESLint flat config with
    `projectService: true` / `parserOptions.project`, the `typescript-eslint`
    default), a flow saved to `.orca/workflows/*.ts` will make the repo's own
    lint command FAIL on the flow file itself ("not found by the project
    service") — because `.orca/` is gitignored scratch not in any tsconfig. That
    turns the workflow's own lint gate RED at baseline, so every task fails and
    the workflow is dead on arrival. Before relying on a detected lint gate in a
    TS repo, confirm the lint config ignores `.orca/**` (or `.orca/workflows/**`);
    if it doesn't, add it (one line in the ignores list) and note the fix in the
    runbook. This does not affect non-TS targets or untyped lint.

## Pre-handoff self-audit checklist

Before declaring a generated flow done, confirm each:

- [ ] Imports come from `"orca-ts"` (no `../src/...`, no bare `neverthrow`); `ok`/`err`/`Result` from `"orca-ts"`.
- [ ] Exactly one `flow(flowArgs())(async () => { … })`; task input read via `flowArgs()`, not `process.argv`; no accessor calls at module scope.
- [ ] A repo-mutating flow guards the tree: clean-baseline/auto-stash, feature branch before commit/push, iteration-scoped revert, off-target detection; no auto-destructive git ops.
- [ ] Every `awaitResult()` is followed by an `outcome.type` narrow before `.result`.
- [ ] If `selectBackend` (or `opencode()`) is used, `selected.shutdown?.()` runs in a `finally`.
- [ ] Verification commands are the **detected target-repo** commands, not `bun`/`npm` assumptions.
- [ ] At least one test gate **and** one lint gate are wired (the skill refuses an ungated flow).
- [ ] `fixLoop` issues carry `fixable`; a `stalled` detector is supplied for repair loops.
- [ ] Any Zod schema used with `pi`/OpenCode tolerates off-shape output (`z.preprocess`).
- [ ] No dependency on the agent asking the operator a question (autonomous only).
- [ ] If the target repo has no `tsconfig.json`, the runbook records the skipped-typecheck note.
- [ ] In a typed-lint TS target, the lint config ignores `.orca/**` (else the flow's own lint gate is red at baseline).
