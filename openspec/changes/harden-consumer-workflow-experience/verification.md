# Verification: harden-consumer-workflow-experience

Review date: 2026-09-29 (America/Los_Angeles).

The seven findings from the review against `main` are fixed. The final
deterministic gate passes, both gated Claude transports pass, and the compiled
consumer rehearsal passes in one launch. No critical implementation gaps were
found in the selected change. The intermittent extra workflow-harness timeout
and the remaining validation boundaries are recorded below.

## Scope and completeness

- Base: `47bb7bcbc22aa1c465508ec24391d0be4cf71607`. A fresh fetch confirmed
  local `main`, `HEAD`, and `origin/main` agree at that commit.
- Schema: `spec-driven`; proposal, design, seven delta specifications, and
  tasks exist. Strict OpenSpec validation passes.
- Parsed artifacts: **19 requirements, 77 scenarios, 41 completed tasks,
  zero unchecked tasks**. Task checkmarks were checked against implementation
  and verification evidence; checkmarks alone are not the verdict.
- The PR contains the selected change and its implementation. The existing
  `package-lock.json` and `add-cursor-agent-backend` work remain outside it.
- Local ignored `doc-refresh.ts` and `feature-fix-loop.ts` workflows were also
  migrated to terminal monitoring. They are local artifacts, outside the PR.

## Fixed review findings

| Finding | Result and regression evidence |
| --- | --- |
| P1: installer omitted compiler assets | `install.sh` and the setup installer copy checker assets before activating the launcher/runtime. Binary smoke builds a host release, runs the actual installer into a disposable destination, and checks/runs a sibling-importing flow with poisoned preload configuration. |
| P1: artifact checking broke relative imports | `checkArtifact()` uses the original source file as its program root. CLI regressions cover valid siblings, invalid siblings, unchanged source, and temporary-project cleanup. |
| P2: registered names were treated as filenames | `run` and `serve` check the actual modules supplied by loop discovery before importing them. Tests cover a declared name differing from its filename, offline check, and served task arguments; compiled smoke covers named-loop execution. |
| P2: explicit Claude ACP silently ignored model/resume | ACP rejects either unsupported option with a typed, transport-aware failure before spawning. Stream-json retains model/resume behavior. Constructor and fake-protocol tests cover both paths. |
| P2: selector environment discarded inherited process environment | Claude receives inherited process environment plus selector overrides. An observable child-environment regression covers partial selector maps. |
| P2: fresh size validation omitted checker assets | `validate:release` builds declarations/checker assets before measuring. Release builds and npm smoke use it; `verify` validates the completed package after binary smoke builds the checker. Budgets remain unchanged. |
| P2: documented cleanup logs never became terminal | Bundled monitored templates and tracked workflows now call `finalize()` after backend cleanup. Initialization and typed backend failures are captured. A primary failure survives an additional shutdown failure; shutdown-only failures are recorded. |

Additional narrow fixes preserve non-JSON thrown values in diagnostics and
forward post-`--` task arguments to served children. The process-harness kill
test launches its plain hung fixture directly through Bun so its short deadline
tests escalation without racing CLI module loading.

## Correctness and scenario evidence

This mapping covers all seven capability areas. Counts describe specification
scenarios, not a claim that every narrative scenario has a separate automated
test. Operator instructions and recovery boundaries also require source review.

| Capability | Requirements / scenarios | Implementation and verification |
| --- | ---: | --- |
| conversation-backends | 3 / 11 | `src/backends/{claude-run,claude-stream-json,acp-run,select,diagnostics}.ts`; constructor, selector, ACP protocol, and error-presentation tests; gated live stream-json and ACP turns. |
| distribution | 4 / 19 | POSIX `bin/orcats`, installer, offline checker, checker build, release packaging, numeric size manifest; CLI preflight, poisoned-environment, release-budget, actual installer, compiled binary, and packed npm smoke. |
| documentation-website | 3 / 13 | In-repo and website environment, CLI, backend, installation, skills, and monitoring pages; links, source-derived symbols/environment inventory, declaration signatures, static build, and browser inspection. |
| execution-observability | 2 / 6 | Atomic idempotent `WorkflowMonitor.finalize()`, terminal context, initialization capture, typed failures, migrated callers; monitor tests, cleanup lifecycle probes, and guarded codebase-workflow finalization tests. |
| workflow-skill-authoring | 2 / 8 | Mandatory `orcats check`, canonical scratch patterns, Git-local excludes and matching staging pathspecs; no-tsconfig/path-with-spaces behavior tests, linked-worktree and dirty-ignore staging tests, template typecheck. |
| workflow-skill-execution | 4 / 13 | Flow skill distinguishes live progress from terminal evidence, uses final JSON over wrapper text, preserves explicit transport selection, and owns managed backend cleanup; template/monitor tests and source review of recovery instructions. |
| workflow-skill-setup | 1 / 7 | Doctor reports selected transport, static evidence stays unverified, gated live proof promotes readiness; behavior tests cover all four backends, ACP adapter requirements, smoke gates, and failure refusal. |

## Coherence

- Stream-json remains Claude's default; ACP is explicit. No automatic
  transport fallback or new backend tag was introduced.
- Public authoring stays Effect-free. Generated declarations and examples pass
  the facade gate; the packaged checker uses existing public entry points.
- Saved workflows, loop modules, and runbooks remain committable. Runtime
  scratch is excluded through the Git-local path and staging exclusions.
- Both documentation surfaces explain original-file sibling resolution,
  named-module checking, terminal finalization, and inherited selector
  environment. Browser navigation and rendered CLI, backend, and monitoring
  content were inspected through the built site's `/orca-ts/` base path.
- The specialized codebase workflow keeps its deadline/generation publication
  guard. Final monitoring is staged through its existing guarded publisher
  after report/artifact retries, rather than bypassing that contract.

## Verification results

| Check | Result |
| --- | --- |
| `bun run verify` in the isolated PR worktree, with ambient preload and live-smoke variables removed | **Passed, exit 0: 532 pass, 1 skip, 0 fail.** Includes lint, typecheck, website build (34 pages), links (61 files), symbols, fixtures, declarations, signatures, facade gate, compiled/installed-release smoke, and final package allowlist validation. The original checkout also passed 549 tests; its additional 17 tests are in the ignored local `tests/ai-slop-cleanup-workflow.test.ts` and are outside the PR. |
| `bun run smoke:package` | **Passed, exit 0.** Packed installation, public imports, CLI version, environment isolation, and size validation. |
| Direct `bun run scripts/validate-package-artifact.ts` | **Passed, exit 0.** Success is intentionally silent. |
| CLI preflight regressions | **16 pass, 0 fail.** |
| Backend-focused checks | **39 pass**, scoped lint/typecheck/docs pass. |
| Skill consumer behavior | **4 pass**; selected-transport readiness and author checker behavior. |
| Git safety behavior | **2 cases, 34 assertions pass**; actual exclude helper and template staging. |
| Monitor/template checks | **23 pass**; cleanup/revert/eval checks **13 pass**, plus four extracted cleanup lifecycle scenarios. |
| Extra tracked codebase-workflow checks | Source contracts **156 pass**; affected runtime finalization **15 pass**. |
| Hidden artifact-harness isolated rerun | **1 pass, 39 assertions**, invalid-source-ledger rejection preserves input; earlier grouped run timed out, described below. |
| `openspec validate harden-consumer-workflow-experience --strict` | **Passed, exit 0.** |
| `git diff --check main` | **Passed.** |

The live integration test remains skipped in the default deterministic suite.
It was run separately with explicit gates:

| Live check | Result |
| --- | --- |
| Claude default stream-json | **Passed**, 49,958 ms, 13 events. |
| Claude explicit ACP | **Passed**, 39,210 ms, 11 events; reported input 9/output 238 tokens. |
| Compiled-release clean consumer rehearsal | **Passed**, exit 0, 49,399 ms, all eight criteria: poisoned preload isolated, offline default preflight, no target TypeScript project, no target dependencies, live selected-transport readiness, honest no-op, clean Git tree, and one successful terminal monitor with backend/transport/stage/end time. |

Installed versions: Claude **2.1.285**;
`@agentclientprotocol/claude-agent-acp` **0.39.0**. These successful turns do not
establish compatibility for other installed-version pairs or change ACP's
opt-in status.

## Remaining boundaries

- A grouped optional hidden artifact-harness run returned timeout `124` instead
  of the expected validation exit `65`. Its child deadline is 10 seconds; the
  isolated exact test then passed in 7.14 seconds. Cause remains unproven. The
  tested launcher/ledger/test paths have no diff, but that alone does not prove
  baseline equivalence. No product or timeout change was made to hide it.
- The committed size budgets cover the npm compressed and installed payloads.
  Final measurements: 7,904,330 compressed bytes versus an 8,694,784-byte
  maximum; 40,998,789 installed bytes versus a 45,096,960-byte maximum.
  Host release installation is exercised; per-target compiled-binary budgets
  and execution on other OS/architecture combinations are not established by
  this local run.
- Signature verification cannot compare the primitive/function aliases
  `StateHash` and `StateReducer`; it verifies all comparable required types.
- Cooperative finalization covers ordinary returns/errors. An abrupt kill can
  leave no terminal JSON; live process/log evidence remains the recovery signal.
- CI and external review are separate delivery gates. This report records
  local implementation evidence and does not claim the PR merged or published.

## Local evidence

Ephemeral logs are recorded for this session; the repository tests and scripts
above are the reproducible checks:

- `/tmp/orca-fixes-final-verify.log`
- `/tmp/orca-pr-verify.log` (isolated PR worktree)
- `/tmp/orca-fixes-final-package.log`
- `/tmp/orca-fixes-final-package-validation.log`
- `/tmp/orca-fixes-final-openspec.log`
- `/tmp/orca-fixes-live-stream-json.log`
- `/tmp/orca-fixes-live-acp.log`
- `/tmp/orca-fixes-consumer-evidence.json`

The earlier evidence in `tasks.md` is historical. This report is the current
verification record for the review fixes.
