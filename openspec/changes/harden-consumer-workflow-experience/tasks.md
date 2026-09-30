## 1. Lock Consumer Regressions

- [x] 1.1 Add failing source-checkout, package, and release smoke cases that
  launch the public `orcats` entry with a deliberately crashing
  `BUN_OPTIONS=--preload` value and then run a repository child.
- [x] 1.2 Add failing CLI cases for valid and invalid workflow and loop modules
  in a temporary non-TypeScript repository with no network, `tsconfig.json`, or
  installed dependencies.
- [x] 1.3 Add failing monitor cases for a successful run, a stage failure, and a
  backend initialization failure, asserting the required terminal fields are
  written before failure propagates.
- [x] 1.4 Add failing Claude selection and diagnostic cases proving stream-json
  is the default, ACP is explicit, and a failure names transport, phase, user
  artifact location, and recovery command.
- [x] 1.5 Add failing skill behavior cases for selected-transport readiness,
  non-TypeScript author checking, git-local scratch exclusion, and final monitor
  status taking precedence over wrapper echo text.

## 2. Harden Package And Release Launchers

- [x] 2.1 Replace the source/npm Bun-shebang entry point with a POSIX launcher
  that removes only `BUN_OPTIONS` and execs the CLI source through Bun.
- [x] 2.2 Package each compiled release as the public POSIX launcher plus a
  private adjacent runtime, and update archive checksums and release metadata.
- [x] 2.3 Update `install.sh` and the setup installer copy to stage checker
  assets before activating the launcher/runtime pair and verify `orcats --version`
  entry point.
- [x] 2.4 Extend npm pack/install and compiled-release smokes to prove poisoned
  preload isolation, argument/exit propagation, unrelated environment
  preservation, and repository-child isolation.
- [x] 2.5 Record numeric compressed and installed baselines and maxima in
  `scripts/release-size-baselines.json`; cap each maximum at 110% of baseline
  rounded up to the next KiB, require a rationale, and reject oversize artifacts.

## 3. Add Offline Artifact Typechecking

- [x] 3.1 Package the TypeScript compiler runtime, required standard-library
  files, and generated public Orcats declarations under `dist/checker/` without
  adding target-repository or network requirements.
- [x] 3.2 Implement an isolated temporary compiler project for one workflow or
  loop module, including cleanup and stable user-facing diagnostics.
- [x] 3.3 Add `orcats check <artifact.ts>` parsing, help, exit behavior, and tests
  proving loop checks do not import or fire the module.
- [x] 3.4 Replace project-wide CLI preflight with the same artifact checker,
  retaining the explicit `--no-typecheck` metadata path and removing the
  missing-project skip contract.
- [x] 3.5 Cover valid public imports, syntax/type failures, target-repository
  package-manager isolation, offline execution, temporary-file cleanup, and the
  selected backend never starting after a failed check.

## 4. Restore Reliable Claude Defaults And Diagnostics

- [x] 4.1 Change `claude()` and `selectBackend()` to use stream-json by default
  while preserving constructor and `ORCA_CLAUDE_TRANSPORT=acp` opt-in behavior.
- [x] 4.2 Preserve bounded ACP lifecycle and stderr evidence, and normalize
  backend failures with backend, transport, phase, user artifact location, and
  safe transport-specific recovery guidance.
- [x] 4.3 Make CLI presentation lead with the user artifact frame and actionable
  context while retaining typed failure data and secondary debug detail.
- [x] 4.4 Update deterministic Claude/ACP/Codex tests so Claude default and ACP
  opt-in are locked without changing Codex's subprocess default.
- [x] 4.5 Update `AGENTS.md` and backend decision notes to supersede the
  ACP-default contract and state the explicit criteria for reconsidering it.

## 5. Finalize Machine-Readable Monitoring

- [x] 5.1 Extend monitor run metadata with terminal status, end time, final and
  failed stage, selected transport, and normalized terminal error while keeping
  older monitor logs readable.
- [x] 5.2 Add an idempotent atomic finalization path for success and failure and
  ensure ordinary terminal failures persist before rethrow or exit.
- [x] 5.3 Migrate every bundled monitored template and checked workflow to
  finalize exactly once on both terminal paths.
- [x] 5.4 Test failed backend context, ambiguous wrapper exit text, duplicate
  finalization, serialization, and successful usage/cost preservation.

## 6. Align Packaged Skills And Generated Git Safety

- [x] 6.1 Update the shared doctor to resolve and report the selected transport,
  check the executable that transport needs, keep static evidence unverified,
  and promote to usable only after a consent-gated bounded live turn.
- [x] 6.2 Keep doctor and run-script copies byte-identical across their
  self-contained skill directories and add stubbed shell behavior tests for all
  backend/transport status paths.
- [x] 6.3 Replace `orcats-author`'s project-dependent checker and skipped
  self-audit path with mandatory `orcats check`, including generated runbooks.
- [x] 6.4 Define the canonical runtime-scratch pattern set and idempotently add
  it to the path returned by `git rev-parse --git-path info/exclude`, preserving
  existing content and linked-worktree behavior.
- [x] 6.5 Update mutating templates to stage intended paths with matching
  runtime-scratch exclusions, while leaving `.orca/workflows/`, `.orca/loops/`,
  and their runbooks committable.
- [x] 6.6 Update `orcats-flow` to use stderr/heartbeat, plan, state, and Git as
  live signals; use final JSON as the durable terminal result; and keep
  transport changes behind explicit operator intent.
- [x] 6.7 Add skill/template tests for `accept-dirty` with tracked `.gitignore`
  changes, local-exclude preservation, linked worktrees, scratch-free staged
  diffs, transport-specific recovery, and wrapper/status disagreement.

## 7. Align CLI And Documentation Surfaces

- [x] 7.1 Update CLI help, README, `docs/backends.md`, distribution,
  monitoring/typecheck troubleshooting, and skill guidance for the launcher,
  `orcats check`, Claude transports, readiness proof, and terminal monitoring.
- [x] 7.2 Add the canonical website environment reference with purpose, values,
  default/precedence, and security or spending notes for every supported
  operator-facing `ORCA_*` variable.
- [x] 7.3 Update website backend setup/reference, workflow monitoring,
  troubleshooting, CLI, and Agent Skills pages to match runtime and packaged
  skill behavior.
- [x] 7.4 Replace the four-name documentation check with a source-derived
  environment inventory and explicit public/diagnostic/internal classification;
  require public and diagnostic variables on both documentation surfaces.
- [x] 7.5 Run `bun run docs:check`, `bun run docs:symbols`,
  `bun run docs:signatures`, and the static website build, fixing all divergence.

## 8. End-To-End Verification

- [x] 8.1 Run focused CLI, backend, ACP client, monitor, skill-template, package,
  release, and documentation tests, including `git diff --check`.
- [x] 8.2 Run `bun run verify` and `bun run smoke:package` with no live backend
  credentials or network-dependent test behavior in the deterministic gate.
- [x] 8.3 Run gated live Claude smoke through default stream-json and explicit
  ACP, recording installed Claude/adapter versions and transport outcomes.
- [x] 8.4 Rehearse the original workflow shape in a clean non-TypeScript
  temporary consumer repository: poisoned ambient preload, offline check,
  selected-transport readiness, honest no-op, clean tree, and terminal monitor
  evidence must all pass in one launch.
- [x] 8.5 Run `openspec validate harden-consumer-workflow-experience --strict`
  and confirm only this change directory is added; preserve unrelated
  `package-lock.json` and `add-cursor-agent-backend` work.

## Current review-fix evidence

Current review-fix evidence: [verification report](verification.md). The seven
review findings are fixed; the final deterministic gate passes with 549 tests
passing, one gated live test skipped, and zero failures. Fresh gated live checks
pass through both Claude transports, and the compiled clean-consumer rehearsal
passes all eight criteria in one launch. The report records the intermittent
extra artifact-harness timeout and its passing isolated rerun.

## Earlier implementation-pass evidence (historical)

The whole suite, both smokes, and the website build pass. The blocker earlier in
this pass was the sandbox's ambient `BUN_OPTIONS=--preload .../lapdog/claude_intercept.mjs`
— a live instance of the exact poisoned-preload this change hardens against. Its
`patchedSpawn` broke child spawns (`runQuiet`, `bun --compile`) and derailed
`bun test` into re-running the `test` script. Running gates through
`env -u BUN_OPTIONS` (the same isolation the shipped `bin/orcats` launcher
performs) resolves all of it.

Verified green:
- Full test suite: `env -u BUN_OPTIONS bun test` → 529 pass, 1 skip, 0 fail
  (62 files, incl. CLI, backend, ACP client, monitor, skill-template, package,
  release, docs) plus `git diff --check` (8.1).
- Every `bun run verify` component (eslint, `tsc --noEmit`,
  `tsc -p tsconfig.build.json`, website `astro build`, docs:check/symbols/
  signatures, validate:fixtures/adr/release/package, facade-gate, smoke:binary)
  and `smoke:package` (8.2).
- `openspec validate --strict` (8.5).
- Gated live Claude smoke on the installed CLIs — claude 2.1.218 +
  `claude-agent-acp` — through both transports (8.3): default stream-json →
  success (7 events, ~53s); explicit `ORCA_CLAUDE_TRANSPORT=acp` → success
  (5 events, ~60s, usage input=38355 output=271). ACP no longer stalls on this
  adapter version, but stream-json stays the default until that compatibility
  is formally proven (design open question).

Fixes applied this pass to reach green:
- `resolveClaudeTransport` returned `stream-json` unconditionally — ACP was
  unreachable even via `transport:"acp"`/`ORCA_CLAUDE_TRANSPORT=acp`. Fixed to
  honor the explicit opt-in (real product bug behind the design's ACP contract).
- `describeRuntimeError(undefined)` returned `undefined` (JSON.stringify quirk),
  dropping the value from bare-`throw undefined` diagnostics; now preserved.
- Deterministic tests aligned to the new behavior: ACP tests opt in explicitly,
  a new test locks the stream-json default, `BackendFailed` assertions tolerate
  the additive transport/phase/artifact/recovery context, monitor uses the new
  human-readable failure line, and CLI tests invoke the POSIX launcher directly
  (not `bun ./bin/orcats`, now a shell script).

8.4 single-launch clean-consumer rehearsal (compiled release binary, fresh
non-TypeScript temp repo, poisoned `BUN_OPTIONS=--preload=/nonexistent`, one
launch, no `--no-typecheck`): exit 0 with all six criteria in the one launch —
ambient preload isolated (no crash), `preflight typecheck passed` offline with
no tsconfig/node_modules/network, live stream-json readiness turn succeeded,
honest no-op (`no repository changes made`), clean tree (`git status` empty), and
terminal monitor JSON `{status:succeeded, transport:stream-json, endedAt set,
finalStage:readiness, backend:claude}`. This reproduces the report's original
three-launch failure as a single-launch success.

Note: running the same flow from a *source* checkout resolves `@twelvehart/orcats`
via bun auto-install to the published 0.3.0 (which predates `finalize`), masking
the working tree — a local release-timing artifact, not a defect. The compiled
binary (the real release path) is sealed against auto-install and resolves the
embedded shim baked from the working tree, so it exercises the change faithfully.

The lapdog Claude Code plugin that injected `BUN_OPTIONS` was disabled in
`~/.claude/settings.json` (`lapdog@lapdog: false`; backup at
`settings.json.bak-lapdog`), so new sessions no longer carry the ambient preload.

Scope note on 2.5: the size-budget manifest and validation are implemented and
green, scoped to the npm package (compressed + installed) — the artifact that
carries the bundled offline checker and is deterministically measurable offline
via `npm pack --dry-run`. A host `bun --compile` was attempted but the sandbox
spawn interceptor blocked it, so per-target release-binary budgets are
intentionally not fabricated; record them from a real multi-target
`bun run build:release` in CI.
