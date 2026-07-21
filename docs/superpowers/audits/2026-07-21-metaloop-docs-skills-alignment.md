# PR #41 Documentation and Skill Alignment Audit

Date: 2026-07-21
Range: `e0adc73..1b760b8`
PR: [#41](https://github.com/ASRagab/orca-ts/pull/41)
Merge commit: `1b760b8b2488489ddf8c76c58a81a718f3b55846`

## Scope capture

Command evidence:

- `gh pr view 41 --json number,title,mergedAt,mergeCommit,baseRefName,headRefName,url`
  → `number=41`, `title="Meta/codebase improvement loop"`,
  `mergedAt=2026-07-21T17:52:54Z`, `baseRefName=main`,
  `headRefName=meta/codebase-improvement-loop`,
  `mergeCommit=1b760b8b2488489ddf8c76c58a81a718f3b55846`
- `git diff --name-status e0adc73..1b760b8`
  → 53 changed files
- `git diff --stat e0adc73..1b760b8`
  → 68,021 insertions, 251 deletions

## Fixed audit matrix

| ID | Source evidence | Class | Contract | Required surface | Decision |
| --- | --- | --- | --- | --- | --- |
| R1 | `src/model/backend-config.ts:7-13,25-27`; `docs/backends.md:25-30`; `website/src/content/docs/reference/backends.md:32-37`; `tests/jsonl-backends.test.ts:48-67` | public runtime | Codex reasoning effort forwards all six declared values without a local model catalog. | backend docs, website, test | retain |
| R2 | `src/conversation/conversation.ts:22-29,123-193`; `docs/backends.md:9-11`; `website/src/content/docs/reference/backends.md:122-123`; `website/src/content/docs/reference/errors-and-results.md:104-113`; `tests/jsonl-backends.test.ts:69-105` | public runtime | Backend timeouts fail without aborting `Conversation.signal`; cancellation resolves only after cleanup and rejects on cleanup failure. | backend/error docs, website, test | retain |
| R3 | `scripts/build-release-binaries.ts:25-33`; `docs/distribution.md:47`; `tests/release-build-options.test.ts:5-43` | release implementation | `bun build --compile --compile-autoload-package-json` preserves the existing packaged binary contract. | release smoke/validation | no public-doc change |
| M1 | `.orca/workflows/codebase-improvement.ts:292,436-447,460-510,555-580,659-698`; `.orca/workflows/codebase-improvement.run.md:277-314`; `skills/orcats-flow/SKILL.md:20-155` | repo-local workflow | Run completion and delivery are separate states and need explicit operator guidance for ready/blocked/delivered continuation evidence. | local runbook, flow skill | update |

## Findings

### R1 — retained public contract

`src/model/backend-config.ts` declares six `CodexReasoningEffort` literals:
`low`, `medium`, `high`, `xhigh`, `max`, `ultra`.

`docs/backends.md` and
`website/src/content/docs/reference/backends.md` both document the same six
values plus the compatibility caveat:

> Orcats forwards all six declared values to Codex without a local model
> catalog.

`tests/jsonl-backends.test.ts` locks both behaviors:

- every value forwards to `codex exec -c model_reasoning_effort="..."`
- both doc surfaces contain the same compatibility sentence

Result: already aligned across runtime, docs, website, and tests. Keep.

### R2 — retained public contract

`src/conversation/conversation.ts` exposes:

- `signal: AbortSignal`
- `cancel(reason?): Promise<void>`
- cancellation success path at `123-163`
- cancellation-cleanup failure path at `176-193`

The public docs now match the runtime:

- `docs/backends.md:9-11`
- `website/.../backends.md:122-123`
- `website/.../errors-and-results.md:104-113`

Locked test coverage in `tests/jsonl-backends.test.ts` asserts:

- timeout docs must not claim signal abortion
- cancellation docs must include cleanup-failure semantics
- lifecycle promises are distinct from `Result`-typed APIs

Result: already aligned across runtime, docs, website, and tests. Keep.

### R3 — release change stays internal to release validation

`scripts/build-release-binaries.ts:25-33` adds
`--compile-autoload-package-json` to the existing `bun build --compile`
release build.

`docs/distribution.md:47` still describes the same published contract:
release installs ship the compiled standalone binary from `src/cli/main.ts`.

`tests/release-build-options.test.ts` covers the release-smoke option parser,
which is the public validation layer coupled to this packaging path.

Result: this is implementation/supporting validation, not a new user-facing
install command. Do not add new public docs for it.

### M1 — local runbook is authoritative; skill still lags

The workflow implementation and runbook now distinguish delivery state from
local completion:

- `deliveryStatus: "pending" | "blocked" | "delivered"` in the run report
- `lockedHeadSha` persistence and validation
- merge confirmation requires `state=MERGED`
- `.orca/workflows/codebase-improvement.run.md:277-314` defines completion as
  validated head SHA + green Verify check + squash merge at same head SHA

`skills/orcats-flow/SKILL.md` covers generic monitoring/healing, but it does
not teach an operator how to read or continue this workflow’s delivery-state
evidence (`deliveryStatus`, `lockedHeadSha`, ready-vs-merged distinction, or
`MERGED` confirmation).

Result: update the flow skill, not the public website/README.

## Scope boundaries

- Do not add `codebase-improvement` to `README.md`, package exports, or the
  published website: the workflow is repo-local and not part of the npm
  package surface.
- Do not copy volatile correction hashes, issue ledgers, or proof transcripts
  into user-facing documentation.
- Do not document `--compile-autoload-package-json` as a new install command:
  it preserves the existing standalone binary behavior.

## Changed-file inventory (all 53 files)

| Path | Class | Surface decision |
| --- | --- | --- |
| `.orca/improvement-loop/issues.jsonl` | repo-private evidence | keep private |
| `.orca/workflows/codebase-improvement-artifacts.test.ts` | repo-local workflow test | keep private |
| `.orca/workflows/codebase-improvement-contract.test.ts` | repo-local workflow test | keep private |
| `.orca/workflows/codebase-improvement-lib.test.ts` | repo-local workflow test | keep private |
| `.orca/workflows/codebase-improvement-lib.ts` | repo-local workflow runtime | keep private |
| `.orca/workflows/codebase-improvement-runtime.test.ts` | repo-local workflow test | keep private |
| `.orca/workflows/codebase-improvement-runtime.ts` | repo-local workflow runtime | keep private |
| `.orca/workflows/codebase-improvement.config.json` | repo-local workflow config | keep private |
| `.orca/workflows/codebase-improvement.run.md` | repo-local operator runbook | local-only |
| `.orca/workflows/codebase-improvement.sh` | repo-local workflow launcher | keep private |
| `.orca/workflows/codebase-improvement.ts` | repo-local workflow runtime | keep private |
| `.superpowers/sdd/progress.md` | task-tracking artifact | keep private |
| `docs/backends.md` | public deep-reference docs | retain current contract |
| `docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md` | internal plan | keep private |
| `docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md` | internal plan | keep private |
| `docs/superpowers/plans/2026-07-16-release-artifact-proof.md` | internal plan | keep private |
| `docs/superpowers/plans/2026-07-19-finalization-parent-repair.md` | internal plan | keep private |
| `docs/superpowers/plans/2026-07-19-scoped-scout-fanout.md` | internal plan | keep private |
| `docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md` | internal spec | keep private |
| `docs/superpowers/specs/2026-07-19-codebase-improvement-scout-fanout-repair-design.md` | internal spec | keep private |
| `docs/superpowers/specs/2026-07-20-codebase-improvement-active-delivery-rebaseline.md` | internal spec | keep private |
| `eslint.config.js` | repo tooling | no doc change |
| `fixtures/tier1/codex/file-change-legacy/events.json` | fixture | no doc change |
| `fixtures/tier1/codex/file-change-legacy/input.jsonl` | fixture | no doc change |
| `fixtures/tier1/codex/file-change-legacy/outcome.json` | fixture | no doc change |
| `fixtures/tier1/codex/file-change/events.json` | fixture | no doc change |
| `fixtures/tier1/codex/file-change/input.jsonl` | fixture | no doc change |
| `package.json` | package metadata | no doc change |
| `scripts/build-release-binaries.ts` | release implementation | no public-doc change |
| `scripts/release-build-options.ts` | release validation helper | no public-doc change |
| `scripts/smoke-binary.ts` | release smoke | no public-doc change |
| `scripts/validate-release.ts` | release validation | no public-doc change |
| `src/backends/claude-run.ts` | public runtime implementation | covered by retained docs/tests |
| `src/backends/codex-jsonl.ts` | public runtime implementation | covered by retained docs/tests |
| `src/backends/codex-run.ts` | public runtime implementation | covered by retained docs/tests |
| `src/backends/codex.ts` | public runtime implementation | covered by retained docs/tests |
| `src/backends/pi-run.ts` | public runtime implementation | covered by retained docs/tests |
| `src/backends/select.ts` | public runtime implementation | no audit action |
| `src/backends/subprocess-run.ts` | public runtime implementation | covered by retained docs/tests |
| `src/backends/subprocess-termination.ts` | public runtime implementation | no audit action |
| `src/conversation/conversation.ts` | public runtime implementation | covered by retained docs/tests |
| `src/conversation/settlement-reservation.ts` | public runtime implementation | covered by retained docs/tests |
| `src/model/backend-config.ts` | public runtime type contract | covered by retained docs/tests |
| `tests/claude-backend.test.ts` | test | no doc change |
| `tests/codex-backend.test.ts` | test | no doc change |
| `tests/conversation.test.ts` | test | no doc change |
| `tests/import-boundary.test.ts` | test | no doc change |
| `tests/jsonl-backends.test.ts` | contract/doc lock test | retain |
| `tests/pi-backend.test.ts` | test | no doc change |
| `tests/release-build-options.test.ts` | release validation test | no public-doc change |
| `tests/typecheck/branded-types.ts` | typecheck fixture | no doc change |
| `website/src/content/docs/reference/backends.md` | published reference docs | retain current contract |
| `website/src/content/docs/reference/errors-and-results.md` | published reference docs | retain current contract |

## Verification

- `bun test tests/jsonl-backends.test.ts`
  → 21 pass, 0 fail
- `bun test tests/release-build-options.test.ts`
  → 5 pass, 0 fail

## Task outputs consumed downstream

- R1 → no further public-doc work required; preserve current docs/tests.
- R2 → no further public-doc work required; preserve current docs/tests.
- R3 → treat as release-validation-only; no new public docs.
- M1 → update `skills/orcats-flow/SKILL.md` to teach delivery-state evidence
  and continuation handling for `codebase-improvement`.
