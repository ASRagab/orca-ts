## 1. Baseline Policy Runtime Support

- [ ] 1.1 Add a shared `BaselinePolicy` parser with `repair` as the default and support for `strict` and `accept-dirty`
- [ ] 1.2 Add a baseline gate runner that requires a clean worktree for `repair` and `strict`
- [ ] 1.3 Add bounded baseline gate repair for `repair` and `accept-dirty` without weakening validation commands
- [ ] 1.4 Add dirty-baseline snapshot capture for `accept-dirty` before any backend turn or file edit
- [ ] 1.5 Ensure baseline repair records monitor outcomes, validation logs, convergence reason, usage, and snapshot path when available

## 2. Authoring Templates And Runbooks

- [ ] 2.1 Update mutating workflow templates to call the shared baseline policy helper before main workflow stages
- [ ] 2.2 Update loop-module templates that mutate repositories to use the same baseline policy behavior
- [ ] 2.3 Update generated runbooks to document default `repair` and explicit `strict` / `accept-dirty` override syntax
- [ ] 2.4 Update the local `feature-fix-loop` workflow to use the shared baseline helper instead of bespoke preflight repair logic

## 3. Execution Skill And Documentation

- [ ] 3.1 Update `orca-ts-flow` guidance to classify red baseline gates as default baseline-repair progress
- [ ] 3.2 Update `orca-ts-flow` guidance to require explicit operator intent before retrying with `accept-dirty`
- [ ] 3.3 Update in-repo docs and website docs for baseline policy behavior and override syntax
- [ ] 3.4 Update `AGENTS.md` or runbook guidance only if needed to keep durable workflow vocabulary in sync

## 4. Verification

- [ ] 4.1 Add unit tests for baseline policy parsing and default `repair` behavior
- [ ] 4.2 Add tests for clean red-gate baseline repair before main work begins
- [ ] 4.3 Add tests for `strict` failing immediately on red gates
- [ ] 4.4 Add tests for dirty worktree rejection under `repair`
- [ ] 4.5 Add tests for `accept-dirty` snapshot contents and pre-edit ordering
- [ ] 4.6 Run template typecheck, targeted tests, docs checks, and `bun run verify`
