# Session Handoff — Docs Remediation Follow-ups

**Author:** AI · **Date:** 2026-06-18 · **Predecessor:** `docs-remediation-plan.md`, PR #26 (`docs/dual-audience-remediation`)

## Context

PR #26 shipped the dual-audience docs remediation and the mechanical symbol checker. The rubric human/agent delta closed from **6 → ≤1**. All gates green at merge time: `docs:check`, `docs:symbols`, `typecheck`, `lint`, `docs:site:build` (33 pages), `build:types`.

What is **not** closed is listed below as tracked follow-ups, ordered by leverage. Each entry is self-contained: a fresh session should be able to start any of them from this doc alone.

The single most important fact for whoever picks this up: **`scripts/check-doc-symbols.ts` verifies literal/variant sets but NOT field-level signatures.** It will not catch a wrong field name on a documented type. That gap is follow-up #1.

---

## Follow-up 1 — Field-level signature verification (docgen from `.d.ts`)

**Priority:** highest (correctness — the load-bearing dimension for agents).

**Problem.** Reference pages hand-transcribe TypeScript signatures from `src/`. The checker (`docs:symbols`) only verifies enum/union/tag literal sets. A transcribed type with the wrong fields passes the checker. During PR #26 this happened for real: the `RuntimeError` union was transcribed with missing fields on 4 variants (`PushRejected` missing `stderr`, `CommandFailed` missing `stdout`, `StructuredOutputValidationFailed` missing `raw`, `TypecheckFailed` missing `stdout`/`exitCode`). They were caught only by manual spot-checking, not by any gate.

**Why it matters.** For agent consumers, a confidently wrong signature is worse than no signature (rubric, Correctness dimension). The literal checker raised agent Correctness to 4–5; field-level drift keeps human Correctness at 4, not 5.

**Next steps.**
1. Add `scripts/check-doc-signatures.ts` that parses `dist/*.d.ts` (produced by `build:types`) as the source of truth for public type signatures.
2. For each documented type in `website/src/content/docs/reference/*.md`, extract the fenced ```ts block(s) and compare the parsed signature against the `.d.ts` declaration. Use the TypeScript compiler API (`ts.createSourceFile` over the `.d.ts`) or [`ts-morph`](https://ts-morph.ephox.dev/) — no need to reinvent parsing.
3. Start narrow: verify only the types the checker already names (RuntimeError, Outcome, Conversation, LoopBuilder, LoopOutcome, LoopRunOptions, LoopRunError, LoopCycleReport, StateStore, StateHash, StateReducer, LlmBackend, LlmTool, AutonomousRequest, SelectedBackend, the 7 tool interfaces, WorkflowRunLog + its members). Expand later.
4. Tolerate doc simplifications intentionally: allow a doc block to be a *subset* (fewer fields) only where the page explicitly says "key members" — otherwise require field-set equality. Make the strictness mode per-block (a comment marker like `<!-- doc-sig: exact -->` vs `<!-- doc-sig: subset -->`).
5. Wire as `docs:signatures` in `package.json` and add to `verify`. Depends on `build:types` running first.

**Acceptance.**
- `bun run build:types && bun run docs:signatures` exits 0 on the current docs.
- Introduce a deliberate field error in a reference page → the check fails with a diff naming the type and the divergent field.
- The 4 RuntimeError fields corrected in PR #26 are covered (regression guard).

**Files.** new `scripts/check-doc-signatures.ts`; `package.json`; possibly `tsconfig.build.json` if `dist` needs to be in the script's path resolution.

**Effort.** Medium. The compiler-API parsing is the work; the comparison logic is straightforward once declarations are extracted. Half to one day.

---

## Follow-up 2 — Symbol-divergence check between `docs/` and the website

**Priority:** high (drift guard — the F1 root cause is guarded, not cured).

**Problem.** There are two doc surfaces: `docs/` (in-repo deep references) and `website/src/content/docs/` (canonical published reference). PR #26 fixed the current Linear drift and added an `AGENTS.md` process note ("update both"), but process notes do not hold. The `docs:symbols` checker only enforces the canonical reference page (`loop-api.md`) for source/sink kinds; `docs/loops.md` and the website loops guide are not checked for kind-set equality, so they can drift again.

**Why it matters.** F1 (website behind `docs/`) recurred because nothing mechanical compares the two surfaces. The rubric notes agents retrieve from cached/indexed docs, so two sources of truth is a permanent tax.

**Next steps.**
1. Add `scripts/check-doc-divergence.ts` that, for each concept that appears in both surfaces, asserts the documented symbol set agrees. Seed it with the pairs that already exist:
   - source/sink kinds: `docs/loops.md` ↔ `website/.../reference/loop-api.md`
   - reviewer IDs + defaults: `docs/review.md` ↔ (no website equivalent yet — flag the asymmetry)
   - plan signatures: `docs/plans.md` ↔ `website/.../reference/api.md` pointer
2. Reuse the extraction helpers (`cap1`, `literals`, `docTokens`) already in `check-doc-symbols.ts` — factor them into a shared `scripts/doc-check-utils.ts` to avoid duplication.
3. For each pair, fail when one surface names a symbol the other omits (bidirectional), with a per-file diff.
4. Wire as `docs:divergence` in `package.json` and add to `verify`.

**Acceptance.**
- On the current tree, `docs:divergence` exits 0.
- Add a new source kind to `src/` and document it only on the website → check fails naming `docs/loops.md` as the missing surface.
- The shared utils are imported by both `check-doc-symbols.ts` and `check-doc-divergence.ts` (no copy-paste).

**Files.** new `scripts/check-doc-divergence.ts`; new `scripts/doc-check-utils.ts`; refactor `scripts/check-doc-symbols.ts` to import from it; `package.json`.

**Effort.** Small-to-medium. The extraction already exists; this is wiring it to compare two file sets. Half a day.

---

## Follow-up 3 — Auto-generate reference from `.d.ts` (eliminate hand transcription)

**Priority:** medium (structural; supersedes #1 if taken far enough).

**Problem.** Reference pages are hand-transcribed. Even with #1 and #2, humans still write the signatures by hand and the checks only *verify* after the fact.

**Next steps.**
1. Decide the boundary: auto-emit signature blocks only (keep prose/examples human-authored), vs. full docgen pages. Recommend the former — emit a verified ```ts block per public symbol, inject it into the page at a marker (e.g. `<!-- docgen:runtime-errors -->`), keep everything else hand-written.
2. Prototype against one page (`reference/runtime-errors.md`) end-to-end before generalizing.
3. This makes #1's verification automatic by construction (the block is generated, not transcribed).

**Acceptance.** At least one reference page's signature blocks are generated from `dist/*.d.ts` and regenerate cleanly on `build:types` changes; the hand-written prose is untouched.

**Effort.** Medium-large. Defer until #1 is in place (it de-risks by defining the signature-extraction layer #3 reuses).

---

## Follow-up 4 — Merge the two doc surfaces (structural, defer)

**Priority:** low (large, structural; explicitly out of scope per `docs-remediation-plan.md` §7).

**Problem.** Two surfaces = two things to keep in sync. Follow-ups #2 and #3 reduce the cost; only merging removes it.

**Next steps.** Not started. Revisit only if #2/#3 prove insufficient. If attempted, the safest path is to make `docs/` the single source and generate the website reference pages from it (or vice-versa), not to maintain both by hand.

**Effort.** Large. Do not start without a dedicated planning pass.

---

## Minor cleanups (bundle with any of the above)

- `docs/plans.md` links into `website/src/content/docs/reference/runtime-errors.md` (a website source path from an in-repo doc). It passes `docs:check` but is awkward on GitHub. Clean up when surfaces converge (#4) or by adding an in-repo runtime-errors note.
- `website/src/content/docs/reference/examples.md` gained a `linear-ticket-triage.ts` row in PR #26; confirm the example file's imports still resolve against the public surface if the examples gate is extended.
- The `AGENTS.md` drift note says a symbol-divergence check is "a tracked follow-up, not yet wired" — update that line to a pointer once #2 lands.

---

## Quick start for the next session

1. `git checkout docs/dual-audience-remediation` (or `main` after PR #26 merges) and read this file + `docs-remediation-plan.md`.
2. Pick follow-up #1 (highest leverage) unless the surfaces have already drifted again, in which case #2 first.
3. Run `bun run docs:symbols` to confirm the baseline is green before changing anything.
4. The canonical literal sets and extraction helpers live in `scripts/check-doc-symbols.ts` — start there for any new doc-checking script.
