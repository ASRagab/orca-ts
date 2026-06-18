# Orca TypeScript — Documentation Remediation Plan
**Author:** AI (documentation pass) · **Date:** 2026-06-18 **Goal:** Raise documentation quality against the dual-audience (human + agent) rubric, across all three surfaces: in-repo technical docs (`docs/`), agent-facing docs (`AGENTS.md`, `CONTEXT.md`, `skills/`), and the website (`website/src/content/docs/`).

* * *
## 1. Current state and scores
The project has **three documentation surfaces** that are maintained independently:

| Surface | Role | Current quality |
| --- | --- | --- |
| `README.md` | User entry point; links into `docs/` | Strong, accurate. |
| `docs/*.md` | In-repo deep references (GitHub-rendered) | Mixed: `loops.md`, `backends.md`, `linear.md` are rich and correct; `plans.md` (361 B) and `review.md` (558 B) are stubs. |
| `website/src/content/docs/` | Published Starlight site | Broad page coverage (28 pages); install / CLI / troubleshooting / distribution / examples are accurate. **Reference pages are tables-of-contents, not references.** |
| `AGENTS.md`, `CONTEXT.md` | Contributor + agent context | Strong. Vocabulary is disciplined. |
| `skills/*/SKILL.md` | Agent skills | Solid (out of scope for this pass unless a gap surfaces). |
### Current rubric scores
| Dimension | Human | Agent | Notes |
| --- | --- | --- | --- |
| 1. Correctness | 4   | 3   | What is stated is accurate (verified against `src/`). Agent capped at 3: type contracts and error conditions are routinely absent. |
| 2. Pedagogical value | 4   | 3   | Strong concepts/troubleshooting for humans; no formal type/model anchors for agents. |
| 3. Clarity | 4   | 3   | Terminology is disciplined (no synonym drift). Types are implicit in prose ("the outcome", "selected.backend"). |
| 4. Scope | 4   | 2   | Pages are well-bounded, but reference pages are not self-contained: an agent cannot call `.reason()` or `StateStore.checkpoint()` from the docs alone. |
| 5. Comprehensiveness | 3   | 2   | Large public-API gaps: `RuntimeError`, `Outcome`, `Result`, `Conversation`, 8 `FlowContext` tools, Linear IO, monitoring JSON shapes. |
| 6. Organization | 4   | 4   | Flat, task-named headers; reference vs tutorial separated; no dead links (`docs:check` passes). |
| **Total** | **23/30** | **17/30** | Human: functional. Agent: insufficient as a sole API reference. |

**Human vs. Agent gap flag:** delta = 6 total, with ≥2 on Correctness, Scope, Comprehensiveness. This is the classic **high-human / low-agent** pattern — narrative-strong, contract-light. Fix: add structured reference alongside the narrative.

* * *
## 2. Root-cause findings
### F1 — Two surfaces have drifted; the website is behind `docs/`
`docs/loops.md` (357 lines) is rich and correct: it documents Linear sources/sinks, `result.isErr()`/`ok()`, recipes, troubleshooting, migration. The **website** loops pages (guide 69 lines, reference 40 lines) are thin and **omit Linear entirely**, despite Linear shipping in commit #25. The website `loop-api.md` lists source/sink kinds that are now wrong (missing `linear-issue`, `linear-agent`).
### F2 — No error model is documented anywhere
`RuntimeError` (a discriminated union with 9 `_tag` variants), the `Outcome` union (`success`/`cancelled`/`failed`), the `Conversation` interface, and the `Result` API (`isOk`/`isErr`/`map`/`match`) appear nowhere in any docs surface. `grep -rni "RuntimeError" website/` → 0 hits. This is the single biggest agent-correctness defect: agents cannot pattern-match failures or infer return shapes.
### F3 — Reference pages are TOCs, not references
- `website/.../reference/api.md` lists ~10 exports but omits 8 of 11 `FlowContext` accessors, `fixLoop`, `WorkflowMonitor`, all `tools/*` interfaces, all `model/*` types.
  
- `website/.../reference/loop-api.md` never shows the `LoopBuilder` interface, `LoopOutcome`, `LoopRunError`, `LoopRunOptions`.
  
- `website/.../reference/state-stores.md` lists method names (`load`/`checkpoint`/...) with **no signatures, no** `Result`**/**`StateHash`**/**`RuntimeError` **types**; does not note `createSqliteStore()` returns `Result` (can fail at construction).
  
### F4 — Two `docs/` stubs
`docs/plans.md` and `docs/review.md` are stubs despite `plan()`/`review()` being root exports and the README pointing to them.
### F5 — Shipped feature with no website page
Linear source/sink integration (#25) has a good `docs/linear.md` but **no website page** and no website reference entry.
### F6 — Monitoring JSON shapes undocumented
`guides/monitoring-recovery.md` points agents at `.orca/monitoring/<runId>.json` but never specifies the schema (`WorkflowRunLog`, `OutcomeLog` with 6 `verdict` variants, `CycleProgress`, etc.).
### F7 — Minor correctness/consistency gaps
- `ORCA_DEP_LOOP_COLLAPSE` env var exists in source, undocumented.
  
- Loop stop-reason → exit-code mapping (`exitCodeForStop`) referenced but never shown in `reference/cli.md`.
  
- `ORCA_LOOP_EVENT` payload shape undocumented in `guides/served-loops.md`.
  
- Doctor script path in `troubleshooting/backend-auth.md` hardcodes one of two byte-identical copies.
  
- Cross-references are link-only (no inline summaries) — costs agents a retrieval hop.
  

* * *
## 3. Remediation plan
### Strategy
Make the **website the canonical published reference** and `docs/` **the in-repo deep guides** the README links to — then close the drift. Do **not** merge the two surfaces (too large/risky for this pass). The highest-leverage work is filling reference pages with the real TypeScript signatures that already exist in `src/`, and adding one error-model reference page that serves every operation.

Every reference entry will follow the rubric's dual-audience contract: **name → kind → signature → behavior → defaults → errors/side-effects**, with self-contained sections (no link-only cross-refs).
### P0 — Error model + reference signatures (lifts Correctness, Comprehensiveness, Scope for agents)
**P0a. New website reference page:** `reference/errors-and-results.md` (add to sidebar under Reference) Document, with signatures pulled from `src/`:

- `Result<T, E>` from neverthrow, re-exported as `ok`/`err`/`Result`. List the methods flows actually use: `isOk()`, `isErr()`, `map()`, `mapErr()`, `match()`, `unwrapOr()`, `.value`/`.error`.
  
- `Outcome<B>` discriminated union:
  
  ```ts
  type Outcome<B> =
    | { type: "success"; result: BackendResult<B> }
    | { type: "cancelled"; reason?: string }
    | { type: "failed"; error: RuntimeError };
  ```
  
  State that `awaitResult()` **never rejects** — failures arrive as `{ type: "failed", error }`.
  
- `Conversation<B>` interface: `events()`, `awaitResult()`, `cancel(reason?)`, `signal`, `canAskUser`.
  
- `RuntimeError` discriminated union — enumerate all `_tag` variants: `NothingToCommit`, `BranchAlreadyExists`, `PushRejected`, `CommandFailed`, `StructuredOutputValidationFailed`, `UnsupportedFeature`, `BackendFailed`, `TypecheckFailed`, `FileSystemError`, `IoFailed`. List constructors: `unsupportedFeature`, `backendFailed`, `commandFailed`, `structuredOutputValidationFailed`, `ioFailed`. Include a "which operations produce which tags" table.
  
- A worked example: pattern-matching `outcome.type` and `result.isErr()`.
  

**P0b. Rewrite** `website/.../reference/loop-api.md` to include the real `LoopBuilder<S>` interface with full method signatures, `LoopOutcome<S>`, `LoopRunOptions`, `LoopRunError`, `LoopCycleReport`, `LoopStopReason`, and the exit-code mapping table. Add Linear to the source/sink kind lists (fix F1/F7). Add inline summary before the cross-link to the loops guide.

**P0c. Rewrite** `website/.../reference/state-stores.md` with the `StateStore<S>` port signature (every method `Result`-typed over `RuntimeError`), `StateHash`, `StateReducer<S>`, `createSnapshotStore` vs `createSqliteStore` signatures, and the explicit note that `createSqliteStore` returns `Result<SqliteStore, RuntimeError>` (construction can fail: file/lease).

**P0d. Expand** `website/.../reference/api.md` to enumerate all root exports grouped by module, including the 8 `FlowContext` accessors (`fs`/`git`/`gh`/`linear`/`terminal`/`command`/`plan`/`review`), `fixLoop`, `WorkflowMonitor`, and pointer rows to the per-area reference pages (with one-line inline summaries). State `selectBackend()` returns `SelectedBackend { tag, backend, model?, shutdown? }` synchronously and **throws** on an invalid `ORCA_BACKEND`.

**P0e. Expand** `website/.../reference/backends.md` with constructor signatures: `claude(options?)`, `codex(options?)`, `opencode(options?) → OpenCodeBackend` (extra `shutdown()`), `pi(options?)`, all returning `LlmBackend<B>`; the `LlmBackend.autonomous(request) → Conversation<B>` contract; and the shared timeout defaults (120s inactivity, 600s wall-clock, opencode 30s startup).
### P1 — Fill stubs + Linear site page + FlowContext tools reference
**P1a. Fill** `docs/plans.md` to a real reference: `plan()` accessor → `PlanTool`; `writePlan`/`recoverPlan`/`defaultPlanPath`/`planHash` signatures (all `Result`-typed); `.orca/plan-<hash>.md` path convention; `Plan.interactive` unsupported (and why); `sequentialTaskStrategy` and the deprecated `implementTaskLoop` (`ORCA_DEP_LOOP_COLLAPSE`).

**P1b. Fill** `docs/review.md` to a real reference: `review()` accessor → `ReviewTool`; `ReviewTool.run(options)` signature; reviewer IDs and default set; `fixLoop` generic + issue-list overloads with stop reasons; `reviewAndFixStrategy` and deprecated `runReviewAndFixLoop`; `ReviewIssue`/`ReviewLoopSummary` shapes.

**P1c. New website page:** `guides/linear.md` (add to sidebar under Guides) — port the content of `docs/linear.md` (env vars, webhook verification, `linearIssueSource`/`linearAgentSource`/`linearIssueSink`/`linearAgentSink` usage, Slack composition, reliability notes). This closes F5.

**P1d. Expand** `website/.../reference/api.md` **(or a new** `reference/tools.md`**)** with the `FlowContext` capability tool interfaces and their `Result`-typed methods: `FsTool` (`readText`/`writeText`/`exists`), `GitTool` (`status`/`add`/`commit` → `NothingToCommit`), `GitHubTool` (`createPullRequest`), `LinearTool`, `CommandTool` (`run` → discriminated `success`/`failed`, never throws), `TerminalTool`. This is the largest body of undocumented public API.
### P2 — Monitoring JSON, served-loop payload, consistency
**P2a. Expand** `website/.../guides/monitoring-recovery.md` with the `WorkflowRunLog` schema: `StageLog`, `OutcomeLog` (with the 6 `OutcomeVerdict` values `clean`/`repaired`/`regressed`/`guard-reject`/`declined`/`precondition-skip` and pass/fail/skip semantics), `FailureLog`, `CycleProgress`, `WorkflowRunSummary`. Clarify that `.orca/monitoring/` is a caller convention (`writeLog(logDir)` takes any dir).

**P2b. Expand** `website/.../guides/served-loops.md` with the `ORCA_LOOP_EVENT` payload shape, `defineLoop`/`LoopDefinition`/`LoopEmission` types, and `serve()` supervisor isolation contract.

**P2c. Add the stop-reason → exit-code table** to `website/.../reference/cli.md` (`converged`→0, `unfixable`→1, `stuck`→2, `timeout`→3, `ceiling`→4, `budget-exhausted`→5, `cancelled`→6, build/runtime error→70).

**P2d. Consistency pass:** document `ORCA_DEP_LOOP_COLLAPSE` (in plans/review pages); note the doctor script exists in both skill dirs; add inline summaries to link-only cross-references in the loops guide.
### P3 — Drift guard (process, not content)
Add a one-line note to `AGENTS.md` "Documentation Placement" and `CONTRIBUTING`-style guidance: **when a public symbol or CLI behavior changes, update both** `docs/` **and** `website/src/content/docs/` (or the relevant reference page). Optionally extend `scripts/check-doc-links.ts` later to flag website reference pages that mention fewer symbols than their `docs/` counterpart — out of scope for code this pass, just noted.

* * *
## 4. Files to create / modify
**New website pages (3):**

- `website/src/content/docs/reference/errors-and-results.md` (P0a)
  
- `website/src/content/docs/reference/tools.md` (P1d) — or fold into `api.md`
  
- `website/src/content/docs/guides/linear.md` (P1c)
  

**Rewritten/expanded website pages (7):**

- `reference/api.md` (P0d), `reference/loop-api.md` (P0b), `reference/state-stores.md` (P0c), `reference/backends.md` (P0e), `reference/cli.md` (P2c), `guides/monitoring-recovery.md` (P2a), `guides/served-loops.md` (P2b)
  

**Sidebar update:** `website/astro.config.mjs` — add the 3 new pages under Reference/Guides.

**In-repo docs filled (2):** `docs/plans.md` (P1a), `docs/review.md` (P1b)

**Minor edits (2):** `AGENTS.md` documentation-placement note (P3); `website/.../troubleshooting/backend-auth.md` doctor-script note (P2d).

All signatures will be transcribed from `src/` (the API-surface report already extracted them) — no guessing. Examples will be runnable / labeled pseudocode where not.

* * *
## 5. Verification
1. `bun run docs:check` — internal links and anchors resolve (must stay green; new pages need valid sidebar slugs + cross-links).
  
2. `bun run docs:site:build` — Starlight build succeeds; Pagefind indexes new pages.
  
3. `bun run typecheck` — any inline code blocks that are real TS stay valid (not enforced, but spot-check signatures against `src/`).
  
4. Spot-check: every signature in the new reference pages matches `src/` (manual diff against the API-surface report).
  
5. Re-score against the rubric (Section 6).
  

* * *
## 6. Re-scoring targets (post-remediation)
| Dimension | Human (target) | Agent (target) |
| --- | --- | --- |
| 1. Correctness | 5   | 4–5 |
| 2. Pedagogical value | 4   | 4   |
| 3. Clarity | 4   | 4   |
| 4. Scope | 4   | 4   |
| 5. Comprehensiveness | 4   | 4   |
| 6. Organization | 5   | 5   |
| **Total** | **26–27/30** | **25–26/30** |

Target: **production-ready (≥27) for human; functional-with-minor-gaps (22–26) closing to production-ready for agent**, with the human/agent delta under 6 and under 2 per dimension.

* * *
## 7. Out of scope (noted, not done this pass)
- Merging the `docs/` and `website/` surfaces into one source of truth (large, structural — defer).
  
- Auto-generating reference from `dist/*.d.ts` (would need a docgen pipeline).
  
- Deep audit of `skills/*/SKILL.md` (appear solid; revisit if a gap surfaces).
  
- Translating `AGENTS.md` design-decision content into website explanation pages.
