# Codebase Improvement Runbook

## Prerequisites

- Use Orcats 0.2.3 from this repository and install its locked dependencies
  with Bun. Confirm `bun --version`, then run `bun install --frozen-lockfile`.
- The launcher builds and pins a clean archive of source HEAD on every
  invocation with Git replacement objects disabled, so tracked or untracked
  source-worktree changes and local `refs/replace` entries cannot affect the
  proof runtime. It ignores a global Orcats installation and records the runtime
  path, source HEAD, binary SHA-256, and version in `latest.json`.
- Confirm Codex authentication with `codex login status`.
- Confirm GitHub authentication and repository access with `gh auth status`.
- Protect `main` with strict required status check `Verify`, pinned to GitHub
  Actions app ID `15368`, from workflow `CI`; enforce the rule for
  administrators. Preflight validates classic branch protection, live mode
  revalidates it before claiming the attestation, and the workflow reads it
  again immediately before merge.
- Start from the source checkout that owns the `origin` remote. The launcher
  fetches current `origin/main` and creates a new isolated worktree from it.

## Preflight

Run the package-manager-independent launcher before any live backend turn:

```bash
bash .orca/workflows/codebase-improvement.sh --preflight-only
```

Preflight first builds and pins a clean archive of source HEAD. It then creates
and retains an `orca/improve-<run-id>` branch and isolated worktree, installs
the frozen lockfile, runs all four ignored workflow test suites and flow
typecheck, then runs the repository gates `bun test` and `bun run lint`. Any
failure stops the run before Codex is invoked.

Preflight copies all fourteen locked artifacts so its tests read the exact
audited docs, workflow files, and ledger. Live copies only the ten ignored
workflow files and ledger, leaving the strict candidate baseline clean. Both
modes rehash the source and every copied operational artifact before execution.

Only after gates, evidence collection, package-lock verification, and final
deadline checks succeed does finalization atomically promote `preflight.json`.
It records terminal success, the distinct run ID, source HEAD, runtime SHA-256,
fetched `origin/main` SHA, and exact fourteen-artifact digest. After the source
ledger validates, the full finalizer trap is active before preflight mode moves
older `preflight.json` and `latest.json` into run-unique same-directory
quarantines. Signal and failure handling repeats that idempotent invalidation
and attempts both paths even when one rename fails. Live requires the claimed
preflight to match the quarantined successful latest evidence, so an attestation
left stable by a failed rename is not reusable. Live recomputes those values and
requires terminal success plus all four bindings before worktree creation. It
passes the attestation path and digest as `ORCA_IMPROVEMENT_PREFLIGHT_PATH` and
`ORCA_IMPROVEMENT_ARTIFACT_DIGEST`; the report retains both values and the
distinct preflight run ID. Preflight and live launches never share a run ID.

## Live Run

Start with the simple profile:

```bash
bash .orca/workflows/codebase-improvement.sh --complexity=simple
```

Live execution always passes `--baseline=strict`. The workflow stops when the
fresh `origin/main` baseline fails; it does not repair a pre-existing red gate.
Use `--complexity=medium` or `--complexity=challenging` only when the candidate
cannot fit the smaller profile.

The launcher binds `ORCA_IMPROVEMENT_RUN_ID`, `ORCA_IMPROVEMENT_BRANCH`, and
`ORCA_IMPROVEMENT_STARTED_AT_MS` before the workflow starts. The workflow
validates the branch as `orca/improve-<run-id>` before config, backend, or
baseline work, then requires Git to report that same retained branch. These are
launcher-owned evidence variables, not operator overrides.

The proving launcher rejects any non-empty `ORCA_BACKEND` value other than
`codex` before repository discovery or side effects, then exports
`ORCA_BACKEND=codex`. The workflow still uses `selectBackend()` and revalidates
the selected backend tag before agent work. This proving path cannot launch a
different backend accidentally.

For unattended Codex stages, the workflow ignores user Codex configuration so
user-configured MCP servers and their approval prompts cannot cancel a
noninteractive run. This containment does not change global configuration or
approve MCP tools. Repository instructions and installed skill descriptions
remain available.

The end-to-end ceilings are:

- simple: 10 minutes
- medium: 30 minutes
- challenging: 45 minutes

Each backend conversation and command also has a stage limit. A timed-out,
off-target, broad, dependency, release, security, or public-API candidate is a
failed run, not permission to widen scope.

The simple stage limits preserve the 560-second allocation:

| Stage | Limit |
|---|---:|
| preflight | 35 seconds |
| scout | 100 seconds |
| reproduce | 65 seconds |
| implement | 100 seconds |
| repairs | 65 seconds |
| review | 65 seconds |
| verify | 40 seconds |
| delivery | 90 seconds |

Medium and challenging stage limits scale by 3 and 4.5. These simple-profile
totals stay unchanged:

- 100-second scout allocation
- 560-second allocation
- 600-second launcher-to-merge ceiling

The repairs and review allocations count only their active work. Initial review
pauses repairs; blocker repair pauses review; repeated review resumes the prior
review remainder. Both remain capped by the launcher-wide deadline.
Every post-turn test-diff and changed-path Git probe receives the active stage
remainder explicitly. Serial Git probes recompute that remainder, so their
internal command cap cannot reset a spent stage or launcher deadline.

Scout time is split into:

- at most 10 seconds for deterministic gathering
- at most 80 seconds total for tool-free ranked synthesis
- at most two fresh synthesis conversations, each limited to 40 seconds
- a second attempt only when the first ends in its exact timeout cancellation
- 10 seconds for validation and reserve

Every synthesis attempt gets a new conversation. The run report records its
label, limit, duration, outcome type, and whether it hit the exact timeout. A
non-timeout outcome from the first attempt is final; it is never retried.

The parent workflow gathers evidence with these exact bounded commands before
it reads only the selected files:

```bash
git status --porcelain=v1
git ls-files src tests
git log -40 --format= --name-only -- src tests
git show --format='Latest commit: %H%nSubject: %s' \
  --name-only --first-parent HEAD
rg -n --no-heading -m 8 \
  'TODO|FIXME|HACK|XXX|throw new Error|catch' -- <selected-paths>
git status --porcelain=v1
```

Selection and rendering use stable path and line order. Selection reserves one
unused positive-overlap test for each selected source that has one before
adding extras, using deterministic maximum-coverage assignment so a shared test
cannot starve another source. The packet exposes those assignments under
`Reserved source-test pairs`; the pair list is mandatory and consumes the same
10,000-character cap. Rendering emits each path once as a
`File: <path>` section header, then numbered source lines that candidates cite
as `<path>:<line>`. It retains
every hotspot first, then distributes context fairly across files through
16 lines before and after each hotspot without cutting a line. The packet
contains at most eight tracked paths: at most four `src/**/*.ts` paths and at
most four `tests/**/*.test.ts` paths. It is capped at 10,000 characters.
Files without hotspots contribute up to their first 40 lines.
The latest-commit prefix and mandatory lines consume the cap before optional
context. Mandatory overflow fails closed; the renderer never truncates a line
or the composed final packet.
Protected public entrypoints plus dependency, release, security, secret,
generated, documentation, skill, workflow, and `.orca/` paths are ineligible.

The run report records packet paths, reserved pairs, and character count. It
also records synthesis attempt records and gather command logs.
The evidence digest uses SHA-256. It records three candidate seeds,
`rankedCandidateIds`,
`selectedControl`, and the
hydrated selected candidate after genuine RED acceptance. Rank one is attempted
first; a later rank can become the selected candidate only through the bounded
invalid-proof fallback below. Every candidate path must come from the packet.
Each `testPath` must match `tests/**/*.test.ts` and be reserved for one of its
allowed production paths. Every candidate must cite one rendered test line.
Every candidate must cite one rendered line from every allowed production path.
Citation validation uses structured rendered-line markers produced from source
and test bodies; latest-commit prefix text cannot satisfy a citation.
The three candidates require unique `testPath`
values and each requires an exclusive production path that neither other
candidate uses; shared support paths remain allowed.
No non-target `tests/**` path is allowed. Duplicate allowed repository paths
are rejected.
`selectedControl` supplies one packet-grounded known-good adjacent input for
rank one using the same production entrypoint, setup, and observation path as
the target, differing only in the defect input.

The Codex scout only sets `reasoningEffort: "low"` for its synthesis request.
Other Codex stages retain their selected configuration.

Gather failure, a changed before/after worktree status, timeout, any model tool
event, malformed or incomplete `rankedCandidateIds`, an uncited claim, an
off-packet path, or insufficient evidence fails closed. Model tool use is a
no-tool failure; the workflow cancels the active scout attempt and does not
continue to reproduction. These checks do not change the positive-control and
immutable-red proof, targeted test and lint, independent review, one full
`bun run verify`, ready pull request, green `CI / Verify`, or head-SHA-locked
squash-merge gates.

## Required Proof

Reproduction adds only the target regression and preserves the scout-selected,
pre-existing top-level test named by `controlTestName`. The control must prove
`controlBrief` through the bound `controlProductionPath`, using the same
production result assertion before and after reproduction. The new regression
must observe the same exported production entrypoint as the control through
lexically scoped symbol identity; a shadowing declaration or untainted
reassignment cannot inherit an outer production origin. Only the defect input
may differ. The parent rejects a
different export from the same allowed production file. Candidate source must
equal the baseline raw bytes plus one
exact contiguous insertion whose parsed extent is the new top-level test; any
other byte change or inserted disabling directive token fails closed.
The RED assertion must end in a recognized built-in Bun matcher invocation.
Only property modifiers `not`, `resolves`, and `rejects` may appear between
`expect(...)` and that matcher. Calling a modifier, naming an unknown terminal
matcher, or inserting an unknown intermediate property fails closed.
Before returning, the reproduction agent runs both commands: the filtered
control and only its new regression through anchored, escaped exact-name
selectors. It must not use the whole test file as RED proof. It corrects only
the new regression until the control passes and that exact target fails with
the expected marker.
The target assertion must isolate the production behavior.
No incidental runner, stack, or source text may satisfy it.
Prompt command rendering shell-quotes non-plain arguments, including the space
inside the control pattern, so each displayed control command is directly
executable.
The prompt lists the exact allowed repository paths. After required skill and
context setup, reproduction inspects only those paths before editing. If they
disprove the causal claim, reproduction must stop immediately with no changes
and report the candidate non-reproducible.
The prompt states: "Never rename, repurpose, delete, or weaken an existing test";
it must preserve the named control and add only the new regression case.
After an expected test-file change is applied, the workflow still waits for the
reproduction conversation's
terminal outcome and records its usage. Off-target cancellation also waits for
terminal settlement before the scope failure is surfaced. Normalized expected
file-change evidence is `none`, `unconfirmed`, or `applied`. `none` preserves
terminal-only backends: an exact one-path Git change and non-empty diff prove
the edit. `unconfirmed` means a normalized call started, mismatched, or failed
without a successful matching result and cannot prove the edit. The guard
records a typed rejection stating that confirmed change evidence is missing.

The parent independently repeats both gates. It first runs the exact filtered
positive-control command
`bun test <testPath> --test-name-pattern '^<controlTestName>$'`. It must
exit zero with exactly one passing line for that name and no skip or todo line.
Only then does the parent run the exact added RED test command
`bun test <testPath> --test-name-pattern '^<escaped candidateRedTestName>$'`.
That named test must produce the exact marker-bound `(fail)` record and the
canonical one-test failing Bun summary. These commands run sequentially within
the unchanged reproduce budget. Red proof is valid, and the immutable test diff
is saved, only after both gates validate.

A shared 65-second reproduce budget covers all ranked attempts. Rank one uses
the scout's control. A later-ranked control is generated lazily, tool-free, in
at most 10 seconds, and must return that exact candidate ID. The workflow falls
back only after a typed invalid reproduction proof: failed, skipped, or
miscounted control; passing target; wrong target failure pattern; no net change;
or empty diff. Backend, timeout, signal-killed command, scope, persistence, and
restoration failures stop the run immediately.

For each rejected proof, the report and a rejected candidate artifact retain
the candidate, control, reason, attempted diff, validation logs, rank, snapshot
SHA-256, baseline status, baseline binary diff, and restoration evidence. Before
the next rank, the workflow restores the raw test bytes byte-for-byte and
requires the restored SHA-256, exact git status, and complete binary diff to
match the pre-attempt snapshot. Each rejected-artifact write asserts a positive
shared-budget remainder immediately before and after persistence. The workflow
also rechecks the shared budget after saving RED and before accepting a
candidate. Candidate, plan, and immutable-red report state are published only
after that acceptance.

After implementation, the workflow must pass the targeted test and
`bun run lint`. It runs `bun run verify` once as the final local gate. Delivery
is complete only when the ready pull request's head SHA matches the validated
commit, the GitHub workflow `CI` check named `Verify` passes, and the pull
request is squash-merged at that same head SHA. Each head query also requires
`isDraft=false` and `baseRefName=main`, so a draft or wrong-base pull request
cannot advance to checks or merge. Every reported check must have conclusion
`pass`; skipped, cancelled, neutral, pending, failed, or missing checks are not
green.

Client polling alone cannot make check state atomic with merge. Before the final
poll, the workflow requires GitHub to report strict `Verify` protection on
`main`, pinned to GitHub Actions app ID `15368`, with administrator enforcement.
GitHub then guards the matched-head merge server-side if check state changes
after the final client read.

Immediately after pull-request creation, GitHub can briefly return the exact
`no checks reported` result before any check run exists. That startup state is
pending and is polled within the delivery budget. Other GitHub CLI failures
remain fatal.

The successful final poll is persisted in `report.remoteChecks` only after a
second ready-state and fixed-head assertion. It records `checkedAt`,
`headSha`, literal state `passed`, the exact command log, and every returned
check row. Pending, startup-empty, failed, or nonzero command results cannot
produce passed evidence.

Delivery captures the pre-commit HEAD and requires it to equal the fetched
`origin/main` base. The validated commit must have exactly that one parent, and
the complete `base..validated-head` range must contain exactly the validated
path set. After every workspace-writing agent and immediately before push, Git
must still report the launcher branch and configured `origin` fetch and push
URLs. CI polling returns typed fixed-SHA passing evidence. Immediately before
merge, the workflow verifies server-enforced merge protection, polls checks
again, requires every current row to pass, replaces `report.remoteChecks` with
that fresh command and timestamp, and then reasserts the unchanged ready head.
Final merge evidence retains the exact command log plus `state=MERGED`,
unchanged `headRefOid`, `isDraft=false`, and `baseRefName=main`.

## Proof Integrity

The expected RED marker is exactly `ORCA_RED:<candidate-id>`. The statically
identified added test name must contain that exact case-sensitive token. The
escaped exact-name selector and one exact Bun `(fail)` record bind runtime
evidence to the same name; regular-expression punctuation has no special
meaning. Generic values such as `error`, `SyntaxError`, and `expected failure`
are rejected before reproduction.

The positive control is semantic proof, not output text. The scout binds a
pre-existing named test to one allowed production path. The parent runs that
test on the untouched baseline, captures its source AST fingerprint, and after
reproduction requires the same named test and fingerprint. AST taint retains
the imported export identity through aliases and namespace calls, then requires
the control and RED assertion to observe the same exported production
entrypoint. The filtered Bun command must report the exact test as
passing with canonical `1 pass`, `0 fail`, and one-test/one-file summary lines;
forged `(pass)` text, skips, todos, or unrelated passing tests fail closed.
Candidate RED syntax must contain one allowlisted terminal Bun matcher after
zero or more recognized property modifiers; a property call alone is not
matcher evidence.

Before and after every workspace-writing agent node, the workflow compares a
path, mode, and content-hash manifest of all ignored `.orca` controls and
evidence. Baseline repair, reproduction, implementation, targeted repair, and
review repair all fail closed if that manifest changes, even when the agent
operation itself fails.
Capture is capped at 1,024 entries, 256 KiB of path data, and 16 MiB of content,
with the active stage deadline applied to each filesystem wait. Symbolic links
hash their raw link text, so link retargeting is visible even when both targets
contain identical bytes. Synchronous and asynchronous operation failures both
run the post-operation comparison.

After `bun run verify`, delivery freezes each validated candidate path's mode
and Git object ID. The pre-stage worktree, staged index, and committed tree must
all match that manifest. `git push` runs only after the committed-tree proof.
Worktree symbolic links use Git blob hashing for the repository object format.
Index and commit rows require strict NUL framing, blob modes, stage zero, and an
exact SHA-1 or SHA-256 object-ID length. A full post-commit path-set query also
rejects files added by commit hooks before the committed-tree check or push.

The launcher validates `.orca/improvement-loop/issues.jsonl` before dependency
build, fetch, worktree creation, or backend work. The ledger must exist, be
non-empty, preserve the exact historical seed, and contain exactly one JSON
object per non-empty line. Every row must satisfy the typed ledger schema,
including a nonblank ID, run ID, timestamp, classification, stage, evidence,
nonnegative elapsed time, and status `open`, `corrected`, or `resolved`.
Invalid ledgers exit `65` and are never rewritten. Finalization merges the
isolated append-only ledger under a directory lock, validates a temporary
merged file, and publishes it with one atomic rename; it never replaces newer
source records with an older worktree copy.

## Evidence and Retention

Read `.orca/improvement-loop/latest.json` in the source checkout first. It
records the run ID, branch, retained worktree, profile, exit code, and paths to
the available evidence. Centralized evidence is retained under:

- `.orca/improvement-loop/runs/<run-id>/launcher.log`
- `.orca/improvement-loop/runs/<run-id>/monitoring/*.json`
- `.orca/improvement-loop/runs/<run-id>/workflow/report.json`
- `.orca/improvement-loop/runs/<run-id>/workflow/rejected/*.json`
- `.orca/improvement-loop/runs/<run-id>/issues.jsonl`
- `.orca/improvement-loop/issues.jsonl`

A successful live run must contain exactly one monitor JSON. Its filename stem
must equal its internal run ID, its backend must be Codex, and its terminal
summary must contain one clean completed outcome with no failures. The launcher
validates those fields before hashing the monitor into terminal ledger proof;
filesystem ordering cannot select stale evidence.

New failure ledger rows include `backend`, `worktree`, `branch`, `monitorPath`,
and `prUrl` when available. Historical rows remain append-only and may omit
later-added context keys.

The workflow report retains the launcher-bound branch, preflight linkage,
final `remoteChecks`, and final merge proof. Backend usage is accumulated once
per backend outcome; baseline repair usage is not counted again through its
aggregate return value. At least one recorded backend usage counter is
required before delivery can succeed.

The workflow never resolves ledger issues. It publishes only its candidate
ledger, monitor, and terminal report. Stable run-local issue evidence remains
that candidate ledger until canonical commit. For live success, the launcher
stages a canonical ledger from the exact captured base and candidate suffix,
resolves every latest-open ID, and appends one terminal record binding the
candidate-ledger, monitor, report, and cycle-free `latest.json` projection
SHA-256 values. The projection excludes `ledgerSha256`,
`latestProjectionSha256`, and `terminalProof`; those embedded claims are checked
separately. Under the ledger lock the launcher rejects any concurrent source
suffix, rehashes every bound file and projection, verifies the claims and
zero-open state, and atomically renames that canonical ledger last. That rename
is the live commit point; `latest.json` alone is never authoritative. A caught
launcher signal is not itself proof of which side of the canonical rename
completed. After a nonzero merge result, exactly one supervised read-only probe
under the remaining outer deadline checks the terminal record and complete
canonical-ledger hash. A pre-rename interruption has no matching record and
hash, so the probe fails and the original signal status remains. A post-rename
interruption may recover only when the probe validates the exact terminal
record, projection and claims, and complete canonical-ledger hash. A new
`TERM`, `INT`, or `HUP` during that probe remains nonzero and cannot authorize
success. The bounded command wrapper reaps its child, restores the caller traps,
and only then returns any recorded signal status, so the final child wait cannot
overwrite it. A successful group leader is not terminal while any member of its
process group remains. The wrapper sends `TERM`, escalates to `KILL`, waits for
the group to disappear, and converts a would-be zero status to `125`; an
existing nonzero status remains nonzero.

The launcher otherwise fails evidence finalization closed. Every shutdown,
ledger, copy, discovery, report-read, retry, clock, JSON-render, and
atomic-publish action uses the shared absolute deadline. Successful latest and
preflight documents remain private while diagnostics print. `latest.json` gets
an immediate positive commit decision before its rename; claimable
`preflight.json` gets a second fresh positive decision immediately before its
rename. Cooperative canonical publishers serialize each destination with one
exclusive `${destination_path}.publication-lock` held across the final
destination-absence check and authoritative move; an ordinary non-participating
`mv` is outside this protocol. Lock cleanup preserves the authoritative move
status. TERM, INT, and HUP remove only a proven-owned marker and lock, while an
invalid, SIGKILL-stale, or cleanup-stale lock fails closed with status `73` and
is never reclaimed automatically. An operator may remove a stale lock only
after proving no publisher is live. The same run must publish `latest.json`
successfully before it may publish `preflight.json`. In preflight mode,
authority transfers only after that rename returns and no pending signal
requires retraction. A failed second decision or rename
atomically moves `latest.json` back to private staging
before rendering failure evidence. If that move fails after the deadline, a
same-directory atomic failure tombstone replaces the success-shaped document.
A signal observed before preflight ownership transfers retracts every newly
published success document. If canonical quarantines and reused private
fallbacks are occupied, cleanup clears or reallocates fresh current-run private
paths, retries retraction, and verifies canonical preflight and latest success
are absent.
After preflight authority transfers, finalization exits immediately with no
fallible cleanup. Any earlier failure turns a prior success into exit
`74`; an earlier nonzero workflow status is preserved.
Build, install, fetch, worktree, test, lint, and live commands use the same
deadline, terminate their whole process group on expiry, and reject a
successful leader that leaves any group member alive. Final status and elapsed
time settle before `latest.json` is atomically published. The primary
checkout's pre-existing untracked `package-lock.json`
is hashed before dependency installation and must have the same existence and
SHA-256 afterward.

The rejected artifact's path inside the retained worktree is
`.orca/improvement-loop/runs/<run-id>/rejected/*.json`. The launcher recursively
copies that run subtree, so its source-checkout location gains the
`workflow/rejected/` segment shown above.

The launcher never removes the worktree or deletes the branch. Keep both until
the report, monitor, ledger, pull request, check result, and merge proof have
been reviewed.

## Bounded Reruns

Do not resume a failed run by repeating an uncorrected command. Inspect its
retained evidence and worktree, correct the specific environment, baseline,
backend, gate, review, scope, remote-check, merge, or SLA cause, then launch one
fresh run from current `origin/main`. Keep the smallest viable complexity
profile. If the same cause repeats, stop and revise the corrective design before
another live run.

## Correction 22

GitHub's required check context is `Verify`; `CI` is workflow metadata, not part
of the context string. Preflight validates strict administrator-enforced
protection as its first gate, and live mode revalidates it before claiming the
attestation. The terminal ledger worker refuses an already recorded signal.
Failed terminal publication removes its provisional success-shaped staging
ledger before publishing failure evidence.

The corrected checkpoint passes 352 focused tests with 2,208 assertions. Full
deterministic verification records 461 passes, one gated skip, and 1,317
assertions.

## Correction 23

Context `Verify` alone does not bind its producer. Both protection validators
require a branch-protection check entry with context `Verify` and GitHub Actions
app ID `15368`. Missing, unrestricted, and wrong-app entries fail closed.

## Correction 24

Process-heavy launcher harnesses use test-only scheduling room for loaded hosts.
Production workflow, command, stage, and launcher deadlines remain unchanged.

The corrected checkpoint passes 352 focused tests with 2,215 assertions. Full
deterministic verification records 461 passes, one gated skip, and 1,317
assertions.

## Correction 25

The terminal worker starts behind a two-phase temporary-file handshake. Its
child cannot execute the requested command until the parent has captured the
PID, rechecked recorded signals, released the start gate, observed the child
acknowledgement, and removed that acknowledgement. Every signal path terminates
the tracked child and removes only its exact gate files.

The preflight protection-order test now requires both the protection call and
the deterministic test command to exist before comparing their positions, and
its deletion mutant proves that removing the protection call is observable. The
final-wait signal harness anchors its injection to the actual terminal wait.

The corrected runtime and test checkpoint passes 353 focused tests with 2,227
assertions. The append-only ledger retains its exact 80-row prefix and adds two
Correction 25 rows for 82 total. Run the final deterministic gates on these
recorded bytes before freezing the replacement fourteen-artifact digest.

## Correction 26

Behavioral shell RED produced six expected failures plus one unrelated
loaded-host timeout. It proved that command substitution could defer the parent
signal trap, and that signal or deadline paths after terminal ledger staging
could leave success-shaped stage evidence. `capture_before_deadline` now runs
all 24 bounded output captures from the main shell. Signal, timeout, and
finalizer cleanup remove the terminal stage before prior-evidence invalidation.

The merge behavioral RED was 0/1: `Expected []`; `Received ["merge must persist
its command result and confirm exact merged state even after a failed
response"]`. Merge now persists its exact SHA-locked `CommandLog` regardless of
the command result, then always runs bounded authoritative confirmation. A
failed or lost response is recovered only when GitHub proves the exact pull
request URL and repository, base `main`, head ref, head SHA, non-draft state,
and `MERGED`. A passed command with failed confirmation surfaces the
confirmation failure; dual failure throws an `AggregateError` containing both.

The Correction 26 checkpoint passes 363 focused tests with 2,353 assertions.
The ledger preserves the exact 82-row prefix with SHA-256
`ed4306a940db3275dec36e3bd91e61e7a942bdecd1f57d46f351aa7f934f91ec`;
three append-only open rows bring it to 85 unique rows. Correction 25's
353-test, 2,227-assertion, 82-row checkpoint remains historical. Full
deterministic verification passes 461 tests with one gated skip, zero failures,
and 1,317 assertions.

The historical fourteen-artifact digest was recorded only as abbreviated
`d603...4e60`. It is invalid and non-reconstructable; missing hexadecimal
characters must not be invented. Run final deterministic gates on the
Correction 26 bytes before computing the successor digest.

## Correction 27

The frozen digest
`b039dd863b146132233239d1003bb3f41f48f336b5160b2bc270169bbe7afc77`
is invalid. A stalled `now_ms` subprocess inside launcher-deadline polling
deferred TERM for 2,174 milliseconds against a 1,500-millisecond bound. A
separate preflight RED delivered TERM immediately before the first success
publication and observed exit `0` instead of `143` because terminal ownership
had already been asserted.

Launcher remainder checks now use Bash's built-in `SECONDS` counter and assign
their result directly in the main shell. The two finalizer clock reads also use
`capture_before_deadline`, bringing the main-shell bounded-capture count to 26.
No active-child polling path invokes an external clock subprocess.

Signals retain direct cleanup authority through `latest.json` publication.
Live mode transfers terminal ownership only before the hash-bound canonical
ledger worker; preflight transfers ownership only after its final rename has
returned. Therefore `latest.json` alone cannot authorize preflight success, and
a signal before or inside the preflight rename removes private or partial
evidence and retains its conventional exit status.

Correction 27 passes 365 focused tests with 2,367 assertions. The ledger
preserves its exact 85-row prefix with SHA-256
`6478fc33be4155396e3cd2aaa3355016b5c3107706580f4bcb90a3da8a4c0418`;
two append-only open rows bring it to 87 unique rows. Full deterministic
verification passes 461 tests with one gated skip, zero failures, and 1,317
assertions. Freeze a new fourteen-artifact digest only after these exact bytes
settle, then require three fresh zero-finding audits.

## Correction 28

Digest
`89a9381f4734052151a3329d56fce2c96d2a0b6518123e9ae303e4a05890e0d8`
is invalid. Semantic taint retained only the allowed production file path, so a
control and RED assertion could call different exports from that file. Taint
now carries both path and exported entrypoint through direct, aliased, default,
and namespace imports plus local bindings. RED must match the control origin.

The concurrent same-ID ledger conflict harness also replaces its fixed 100ms
delay with a bounded file handshake after base capture. Its focused regression
passes five consecutive runs.

Correction 28 passes 366 focused tests with 2,377 assertions. The ledger
preserves its exact 87-row prefix with SHA-256
`d1580b5f595fbbbf4325d08aee3afcce15f2a4a9fb19c4c1714673c3e06587ad`;
two append-only open rows bring it to 89 unique rows. Full deterministic
verification passes 461 tests with one gated skip, zero failures, and 1,317
assertions. Freeze a new fourteen-artifact digest only after these exact bytes
settle, then require three fresh zero-finding audits.

## Correction 29

The fourteen-artifact digest
`9c3824b40178183c2af42ea068063412d896f6f4ec5caa78faf07cc23da3dc24`
is invalid. Three fresh findings invalidate those exact bytes:

- production taint must bind lexical symbols, not identifier text, so shadowing
  declarations and untainted reassignments cannot inherit an outer origin;
- RED must be one exact raw additive insertion, with every baseline byte
  preserved and every inserted disabling directive token rejected; and
- when canonical quarantines and private fallbacks are both occupied,
  preflight signal cleanup must clear or reallocate fresh current-run paths,
  retry retraction, and verify canonical preflight and latest success absent.

These findings remain open in the append-only ledger until a merged proving run
resolves them; the local repairs enforce all three contracts. The ledger
preserves its exact 89-row prefix with SHA-256
`e897a979014f817046b766f9063e7021dceab6181e335cb9339aca3b466f3a32`;
three append-only open rows bring it to 92 unique rows. The successor digest,
three zero-finding audits, preflight, and live run remain pending until all
three repairs and deterministic gates pass.

## Correction 30

The fourteen-artifact digest
`be08eb2843d4163f22d76edfa0617e7f7a98b34063f86afaa507f1c70ffe179a`
is invalid. Two fresh findings invalidate those exact bytes:

- RED validation accepted a called modifier or unknown property as a matcher,
  allowing an unrelated Bun `TypeError` to masquerade as causal RED; and
- the bounded launcher returned success when a group leader exited while a
  background descendant remained able to mutate lock or evidence bytes.

The local repairs require one allowlisted terminal Bun matcher after only
recognized property modifiers, and require every successful bounded command to
prove its process group empty. Residual members receive `TERM`, then `KILL`; a
would-be success becomes exit `125`. The ledger preserves its exact 92-row
prefix with SHA-256
`3c2e9579ff986a29c35a5038548b28e635a94f57606d17c28bcfcbf5a8daa013`;
two append-only open rows bring it to 94 unique rows. A successor digest, three
zero-finding audits, preflight, and the one authorized live run remain pending.

The Correction 30 deterministic checkpoint passes 373 focused tests with 2,447
assertions. Flow typecheck, exact ledger validation, Bash syntax,
documentation links, diff checks, and full repository verification pass. Full
verification records 461 passes, one gated skip, zero failures, and 1,317
assertions.

## Correction 31

The fourteen-artifact digest
`c6749dcf831c1070755e602a57baf97e8f628e11284abda53cd0359f54e4d2d4`
is invalid. Four fresh findings invalidate those exact bytes:

- the positive control accepted a bare `expect(productionResult)` plus an
  unrelated passing matcher;
- RED accepted a passing marker-bearing target when another test failed;
- UTF-8 decoding stripped a baseline BOM from the claimed raw additive proof;
  and
- a descendant that called `setsid()` escaped process-group cleanup.

Local repairs require the production value to reach an allowlisted terminal
Bun matcher, bind the literal RED marker to the target's own `(fail)` record,
decode UTF-8 fatally while retaining a BOM, and assign every bounded command an
inherited owner token.
Containment covers process-group members and descendants retaining the
inherited owner token. Bounded owner inspection fails closed unless it proves
the cooperative set empty. A surviving cooperative owner converts would-be
success to exit `125`. Arbitrary same-UID hostile processes are outside the
proof because they can also mutate repository authority directly. This is not
kernel isolation.

The ledger preserves its exact 94-row prefix with SHA-256
`6ba0aaa3319134b5f8b1261806adb68b2f782ac17c433e6221d7496660fc4b4d`;
four append-only open Correction 31 rows bring it to 98 unique rows with
SHA-256
`89742959183b13b09b9ff6fb9e9fdb519aa5e83f2ac7e40e91983daf5de46fdd`.
A successor digest was not frozen because the next audit and full artifact gate
found additional proof gaps.

## Correction 32

The post-Correction 31 audit found four more issues before digest lock:

- a production-bound control matcher after unconditional `return` or `throw`
  was accepted even though it could not execute;
- substring matching let a failing `ORCA_RED:candidate-x-extra` test authorize
  a passing `ORCA_RED:candidate-x` target;
- live host-wide owner inspection made unrelated finalizer harnesses exceed
  their deterministic test caps; and
- raw same-user process environments were written to a private temporary file
  that abrupt `SIGKILL` could leave behind.

Control analysis now rejects ambiguous flow and considers only a reachable
production-bound matcher. RED failure provenance requires the exact marker
token on a Bun `(fail)` line. The finalizer harness supplies a scoped empty
owner scan while dedicated process tests retain real `setsid()`, inspection,
and filter failures. Production inspection streams `ps eww` through a
pipefail-protected filter and persists matching PID lines only.

The ledger preserves its exact 98-row prefix with SHA-256
`89742959183b13b09b9ff6fb9e9fdb519aa5e83f2ac7e40e91983daf5de46fdd`;
four append-only open Correction 32 rows bring it to 102 unique rows with
SHA-256
`021909608578d7519d5c6c3381967cca3f74d14efc4a1256a8416ad158b82ed8`.
All four focused suites pass at 384 tests and 2,496 assertions. A new digest,
three zero-finding audits, preflight, and the one authorized live run remain
pending until every final deterministic gate passes on these exact bytes.

## Correction 33

The post-Correction 32 semantic audit found eleven proof gaps before digest
lock:

- labeled `break` flow could make a skipped matcher appear reachable;
- optional calls and indexes could skip production or matcher evaluation;
- evaluated nested writes and invoked local behavior could overwrite a trusted
  production value;
- candidate RED analysis was weaker than positive-control analysis;
- matcher expectations could depend on the received value or an arbitrary
  `toSatisfy` predicate;
- the RED marker could already exist in baseline source;
- later production calls could receive mutable or effectful arguments after an
  exact observation;
- `await` lost named and namespace production origins;
- the exact added RED test's static name was not retained safely;
- RED ran the whole test file instead of one exact named test; and
- marker presence did not prove one exact failing reporter record with a
  canonical one-test Bun summary.

Control and RED analysis now share the same causal matcher, production-origin,
reachability, and side-effect rules. Labeled exits propagate to their matching
scope; optional evaluation fails closed. Exact-state provenance survives pure
aliases and uninvoked closures, but nested writes, invoked local effects, and
later production calls with anything except recursively proven primitives
invalidate it. Matcher expected arguments must be passive and independent;
`toSatisfy` is not proof. Named and namespace production results retain origin
through non-optional `await`.

The baseline must not contain the candidate marker. Semantic evidence returns
the exact single added test's nonempty static name. The workflow runs an
anchored, escaped selector for only that name, then requires exactly one matching
`(fail)` reporter record and one unique Bun summary with zero passes, one
failure, nonzero expectation calls, one test, and one file. This correction
rejects duplicate or contradictory summary fields. It hardens only the added
RED test name; control-name character hardening remains out of scope.

The ledger preserves its exact 102-row prefix with SHA-256
`021909608578d7519d5c6c3381967cca3f74d14efc4a1256a8416ad158b82ed8`;
eleven append-only open Correction 33 rows bring it to 113 unique rows with
SHA-256
`d5afe4695fb80f65984ca311c01f566b3a6b2589e5e6d5c44735dd66aa78f547`.
Fresh local evidence covers all four focused suites at 406 tests and 2,663
assertions: 84 library, 157 runtime, 82 contract, and 83 artifact tests. Flow
typecheck also passes. Full deterministic verification passes 461 tests with
one gated skip, zero failures, and 1,317 assertions. A new digest, three
zero-finding audits, preflight, and the one authorized live run remain pending.

## Correction 34

Matcher-argument const bindings now resolve recursively to primitives. An
effectful or aggregate-backed initializer cannot become passive through a const
alias. The reproduction agent runs both authoritative commands: the filtered
control and the exact named RED selector. Whole-file RED is not proof.

The ledger preserves its exact 113-row prefix with SHA-256
`d5afe4695fb80f65984ca311c01f566b3a6b2589e5e6d5c44735dd66aa78f547`;
two append-only open rows bring it to 115 unique rows with SHA-256
`20fad41c836b40974ae56fc52ea5dbe8b5833d1a4aebf971f15e72e2b38e70a5`.

## Correction 35

Mutable const arrays and objects cannot supply matcher expectations, and
prototype-dependent `toBeOneOf` is not causal proof. Inline passive object
literals validate their values without treating identifier keys as bindings.
Unshadowed global `undefined` remains an accepted primitive.

The ledger preserves its exact 115-row prefix with SHA-256
`20fad41c836b40974ae56fc52ea5dbe8b5833d1a4aebf971f15e72e2b38e70a5`;
three append-only open rows bring it to 118 unique rows with SHA-256
`aaf71fc52c3c038cd44cf56de00624383d70effbaa3943252ee69371f1e5ee28`.

## Correction 36

The parent writes and byte-verifies a deadline-bound Bun preload immediately
after the reproduce budget starts. It disables `expect.extend`, freezes
`expect.prototype` and `expect`, and prefixes the baseline control, repeated
control, exact named RED, and post-fix targeted GREEN commands. Static analysis
validates causal matcher semantics before expect integrity, then rejects
aliases, extensions, escaped assertion objects, and prototype writes. Contract
mutants prove no proof wrapper can run before installation.

The ledger preserves its exact 118-row prefix with SHA-256
`aaf71fc52c3c038cd44cf56de00624383d70effbaa3943252ee69371f1e5ee28`;
one append-only open row brings it to 119 unique rows with SHA-256
`bd6ea5690024400877747e9cd2b558014f5143d722005eee7717deb711a1af5f`.
All four focused suites pass at 417 tests and 2,715 assertions: 84 library with
323 assertions, 167 runtime with 682, 83 contract with 704, and 83 artifact
with 1,006. Flow typecheck passes. Full deterministic verification, a new
digest, three zero-finding audits, preflight, and the one authorized live run
remain pending.

## Correction 37

Matcher-preload validation now traces transitive named proof wrappers to their
runtime call sites. Direct, aliased, and hoisted pre-install executions fail,
indirect proof-wrapper references fail, and a safely hoisted wrapper invoked
only after installation remains valid.

The ledger preserves its exact 119-row prefix with SHA-256
`bd6ea5690024400877747e9cd2b558014f5143d722005eee7717deb711a1af5f`;
one append-only open row brings it to 120 unique rows with SHA-256
`625e7d8935d663c872a49056f5ad849a4052143fb5663617ec9a82edd92d35a2`.

## Correction 38

Proof-wrapper closure now follows TypeScript binding identity rather than
identifier text. Named wrapper declarations may be hoisted; only reachable
invocation order is compared with preload installation. Shadowed same-name
bindings and safely hoisted declarations remain valid, while the direct,
alias, and transitive pre-install mutants still fail.

The ledger preserves its exact 120-row prefix with SHA-256
`625e7d8935d663c872a49056f5ad849a4052143fb5663617ec9a82edd92d35a2`;
two append-only open rows bring it to 122 unique rows with SHA-256
`189403f518f525ea4f16eecc56e338d828960f25796643e0e875bfbd5df9706e`.
Focused matcher tests and flow typecheck pass. The full artifact suite exposed
the Correction 39 harness-timeout gap.

## Correction 39

The five-case fresh-preflight integration harness now has a 15-second test
timeout instead of Bun's five-second default. This bounds only the deterministic
test harness; launcher, preflight, stage, and 600-second live deadlines remain
unchanged.

The ledger preserves its exact 122-row prefix with SHA-256
`189403f518f525ea4f16eecc56e338d828960f25796643e0e875bfbd5df9706e`;
one append-only open row brings it to 123 unique rows with SHA-256
`71e942097fd6ec015bb6a4d267144048f39705f5a2e89496bde57bdf5e7066c8`.
All four focused suites pass at 419 tests and 2,727 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 83 artifact
with 1,006. Flow typecheck passes. Full deterministic verification, a new
digest, three zero-finding audits, preflight, and the one authorized live run
remain pending.

## Correction 40

The first fully frozen pre-amendment proving state used commit `713ab15`,
fourteen-artifact
digest
`65f7e553e851d657cdc220ec72660dfc5dba1b356fa31a461dd54ed5077b816b`,
and runtime SHA-256
`98e86243d42f82ec2e728e1dceba1df011d4a854f698914ca23a48a568de2207`.
Full deterministic verification passed 461 tests with one gated skip and 1,317
assertions, three independent audits returned literal `ZERO FINDINGS`, and
preflight `20260716182959-15561` passed in 173,944ms. The authorized live run
`20260716183318-48343` then exited 1 after 17,815ms, before backend startup,
push, pull request, CI, or merge, because the compiled Bun runtime could not
load the target repository's package metadata and resolve its installed
`typescript` dependency.

Local and release binary builds now enable Bun's
`--compile-autoload-package-json` runtime setting. The host-native release smoke
replaces release source-syntax validation: it invokes the real release-builder
entrypoint for the current host, then executes its unarchived artifact against a
repository flow that imports `typescript`. Its autoload-removal mutation proof
failed with the exact retained resolution error and passed after the flag was
restored. The local-binary smoke, strict release-option tests, typecheck,
touched-file lint, release validation, embedded-loader tests, and an inert
import of the retained runtime also pass.

The ledger preserves its exact 123-row prefix with SHA-256
`71e942097fd6ec015bb6a4d267144048f39705f5a2e89496bde57bdf5e7066c8`;
one append-only open row brings it to 124 unique rows with SHA-256
`fcd8e718290c2d15facac74bb1641fa3a94c60432af2b57e48caa95e4dc04758`.
All four focused suites pass at 419 tests and 2,727 assertions, and full
deterministic verification passes 466 tests with one gated skip, zero failures, and 1,336
assertions. A successor digest, three audits, and preflight remain pending. The
authorized live run was consumed; a second live invocation requires fresh
explicit authorization.

## Correction 41

The first successor digest
`16e2c3824553866e404fccd4eaf7e8b3930db28f81894a7e9e68c9c7ff866748`
is invalid. Its frozen runtime audit found that `remaining_launcher_ms`
derived remaining budget from whole-second `SECONDS` even though the launcher
had already recorded `launcher_deadline_at_ms`. Live latest and canonical-ledger
publication, or preflight success publication, could therefore occur up to 999
milliseconds after the absolute deadline.

Publication decisions now read and validate a fresh millisecond clock and
subtract it from the exact absolute deadline. Active-child polling retains its
shell-native clock so a stalled external clock cannot defer signal cleanup; it
starts from one exact remainder and rechecks the exact clock after a successful
command. The obsolete launcher-wide started-seconds state is removed. Two
deterministic finalizer harnesses fix `now_ms` at 100 and the deadline at 99;
both live and preflight RED exited 0 before the fix and now fail closed without
committing canonical success. The prior stalled-clock TERM harness remains
green.

The ledger preserves its exact 124-row prefix with SHA-256
`fcd8e718290c2d15facac74bb1641fa3a94c60432af2b57e48caa95e4dc04758`;
one append-only open row brings it to 125 unique rows with SHA-256
`952d97ef59e8f4d5895c1a27b679614fbfbbf2d5e2b70c81e80d280bc84ae72a`.
All four focused suites pass at 421 tests and 2,737 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 85 artifact
with 1,016. Full deterministic verification passes 466 tests with one gated
skip, zero failures, and 1,336 assertions. A fresh successor digest, three
audits, and preflight remain pending. Another live run still requires fresh
explicit authorization.

## Correction 42

The first Correction 41 review found that its live regression expired before
the first latest publication, not between latest publication and the canonical
ledger rename. The terminal ledger worker could finish its validations, rename
the canonical ledger, and then have the wrapper's exact post-action check
return timeout. The caller treated the matching committed ledger hash as
authoritative and converted that timeout back to success.

The terminal-commit ledger action now makes one fresh exact deadline decision
immediately before its canonical rename. A deterministic harness leaves 4.9
seconds of shell-native polling budget, advances only the exact clock after the
terminal ledger hash binding, and expires before the rename. RED expected exit
74 but received 0 and committed the ledger. GREEN exits 74, retracts
success-shaped latest evidence, and leaves the canonical ledger unchanged. The
post-rename interruption recovery and stalled-clock signal guard remain green.

The ledger preserves its exact 125-row prefix with SHA-256
`952d97ef59e8f4d5895c1a27b679614fbfbbf2d5e2b70c81e80d280bc84ae72a`;
one append-only open row brings it to 126 unique rows with SHA-256
`9a83857191d0563a2a13acf078889086be3cdc902c3c280d665a721a2edfe5ef`.
All four focused suites pass at 422 tests and 2,743 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 86 artifact
with 1,022. Full deterministic verification passes 466 tests with one gated
skip, zero failures, and 1,336 assertions. Fresh reviews, a new 14-artifact
digest, three audits, and preflight remain pending. Another live run still
requires fresh explicit authorization.

## Correction 43

The first frozen Correction 42 successor digest
`14b684dc4829740debc908b96b1ce00cd47d605ff5958deca10aed485d87590f`
is invalid. Its expiry harness advanced exact time after only the staged-ledger
hash, so an early deadline decision still passed while later bindings retained
a rename window. It also used `now_ms=6000` against deadline `5000`, so changing
equality rejection from `-le` to `-lt` still passed.

The harness now advances exact time only after the final hash-binding decision
and uses `now_ms=5000`, exactly equal to the deadline. Two mutation proofs move
the decision after the staged-ledger hash and weaken equality to strict-before.
Both failed RED because the weakened launchers still returned exit 74. GREEN
makes both mutants publish false success with exit 0, proving the production
regression would fail under either weakening; the unmodified launcher exits 74.
Post-rename recovery and stalled-clock signal handling remain green.

The ledger preserves its exact 126-row prefix with SHA-256
`9a83857191d0563a2a13acf078889086be3cdc902c3c280d665a721a2edfe5ef`;
two append-only open rows bring it to 128 unique rows with SHA-256
`2476a42e688b8d125a8d5765bd366f514a38ac99c81e711e1415d2b48d935ec9`.
All four focused suites pass at 424 tests and 2,756 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 88 artifact
with 1,035. Full deterministic verification passes 466 tests with one gated
skip, zero failures, and 1,336 assertions. A new digest, three audits, and
preflight remain pending. Another live run still requires fresh explicit
authorization.

## Correction 44

Authorized run `20260717000416-46151` failed in scout before edits, push, PR,
CI, or merge. Its first scout attempt saw 73,245 model-visible input
characters, establishing prompt-size correlation; reasoning-effort causality
remains unproven.

Compact rendering emits one `File: <path>` header followed by numbered source
lines, while citations remain `<path>:<line>`. Offline replay over the exact
failed-run files rendered 9,998 characters under the 10,000-character cap and
retained every required hotspot. The 100-second scout allocation remains 10
seconds for gathering, at most two fresh 40-second synthesis attempts, and 10
seconds for validation.

Append-only ledger row 129 is retained; its current SHA-256 is
`96c1c4df54aa386adef1ceea1154b4925476095249966eafe0b9988351f6274a`.
Full verification, successor manifest/audits, and preflight remain pending.
Another live run requires fresh explicit authorization.


## Correction 45

The frozen-byte audits found
`audit-scout-validation-reserve-deadline`,
`audit-candidate-citation-token-boundary`, and
`audit-current-scout-plan-evidence-cap`. Early synthesis left validation able
to consume the whole scout remainder, forged prefix, nested-path, and line
suffix text satisfied rendered markers, and the current imperative Task 2
snippet still prescribed `20_000`.

Scout validation now starts one absolute 10-second validation deadline
immediately after synthesis, bounds every tracked-path operation by its shared
remainder, and performs a final remainder check. Candidate citations now
require exact citation-token boundaries. The current Task 2 snippet uses the
normative 10,000-character cap and names the validation-limit constant.

Three append-only open audit rows bring the ledger to 132 rows and 132 unique
IDs with SHA-256
`1ebfb5e0bec4d7f3fd4db71c8550ab7193e181e52c733ae8850bbcd7a0f261f1`.
Focused library, contract, and artifact regressions pass. Prompt-size correlation
and the unproven reasoning-effort causality conclusion are unchanged. Full
verification, a new manifest, three fresh audits, preflight, and any live run
remain pending. Another live run requires fresh explicit authorization.

## Correction 46

The aggregate library, contract, and artifact gate exposed
`terminal package-lock drift blocks success publication` as a behavioral RED.
The test runs three subprocess harnesses under Bun's default 5-second timeout;
it timed out in the aggregate gate and took 4.98 seconds isolated. Only this
existing three-scenario artifact test now has an explicit 15-second timeout,
matching its neighboring harness.

Append-only open row `review-terminal-package-lock-harness-timeout` brings the
ledger to 133 rows and 133 unique IDs with SHA-256
`07da8ff81c2d550629961d9d0d5a2f9d3b7a9dfeaf8647a972b899f9fa5ef347`.
The focused target and artifact proof pass 1/1 each, the isolated artifact
suite passes 91/91, and the aggregate gate passes 262/262. Full verification,
a new manifest, three
fresh audits, preflight, and any live run remain pending. Another live run
requires fresh explicit authorization.

## Correction 47

The complete four-suite gate exposed a second default-timeout failure:
`successful terminal publication validates monitor identity and outcome`
timed out after 5003.72 milliseconds. It expected launcher exit 74 but received
the timeout signal status 143.

A deterministic AST inventory found 31 finalizer-harness tests, 33 static calls,
and 52 loop-expanded subprocess runs. The 24 default-timeout tests
relied on Bun's five-second default, six already declared 15 seconds, and the
named six-scenario mutation test declared 30 seconds. Every ordinary
finalizer-harness test now declares a 15-second timeout; the six-scenario
mutation test retains its 30-second timeout. An AST policy guard locks the
31-test, 33-call, and 52-run expansion. It rejects indirect harness references
and duplicate exception titles.
It permits exactly one six-scenario 30-second exception.
It rejects reduced scenario sets.

Append-only open row `review-finalizer-harness-timeout-policy` preserves the
exact 133-row prefix with SHA-256
`07da8ff81c2d550629961d9d0d5a2f9d3b7a9dfeaf8647a972b899f9fa5ef347`
and brings the ledger to 134 rows and 134 unique IDs with SHA-256
`24cb771218c8ff8839397eb12e64588b649980c09928249dfc7aa3f4ae84e43f`.
The isolated artifact suite passes 93/93 with 1,317 assertions, and the
four-suite aggregate passes 431/431 with 3,064 assertions. Full verification
records 466 passes, one gated skip, zero failures, and 1,336 assertions. A new
manifest, three fresh audits, preflight, and any live run remain pending.
Another live run requires fresh explicit authorization.

## Correction 48

The frozen-byte policy audit found
`audit-finalizer-harness-conditional-skip`. The first AST guard counted six
declared loop elements, but a conditional `continue` could skip one at runtime
while preserving 31 tests, 33 calls, 52 expanded runs, and an empty issue list.

The sole 30-second exception must now use one top-level `for...of` loop whose
first body statement is an unconditional top-level harness call awaited into
one variable. Conditional, early-exit, alternate-loop, nested, and labeled
control flow are rejected. A mutation regression proves all six scenarios must
execute. The loop must enumerate the exact six unique mutation literals;
duplicate literals and spread elements are rejected.

Append-only open row `audit-finalizer-harness-conditional-skip` preserves the
exact 134-row prefix with SHA-256
`24cb771218c8ff8839397eb12e64588b649980c09928249dfc7aa3f4ae84e43f`
and brings the ledger to 135 rows and 135 unique IDs with SHA-256
`f42621dd2b4400f075ff182be37a6f2953ce9ef1f47fc3b4b2ed2d6167bc22d3`.
Focused policy and proof verification passes. The isolated artifact suite
passes 94/94 with 1,405 assertions, and the four-suite aggregate passes 432/432
with 3,152 assertions. Full verification records 466 passes, one gated skip,
zero failures, and 1,336 assertions. A new manifest, three fresh audits,
preflight, and any live run remain pending.
Another live run requires fresh explicit authorization.

## Correction 49

The Correction 48 frozen-byte audits found five remaining root-cause classes:

- `audit-finalizer-harness-scenario-binding`:
- `audit-finalizer-harness-global-loop-control`:
- `audit-finalizer-harness-option-integrity`:
- `audit-finalizer-harness-scenario-identity`:
- `audit-finalizer-harness-callable-identity`:

Static loop cardinality alone did not prove which scenarios executed, which
harness option each scenario selected, or which callable produced the result.
Mutations could repeat one valid case, skip later iterations, override an option,
evaluate an effect before the selector, or shadow a fixture while preserving the
31-test, 33-call, and 52-run inventory.

All seven harness loops require exact scenario-array digests.
They require exact scenario-to-option selector paths.
They use inline non-spread scenario literals.
They use const loop bindings and a first awaited harness call with fixed
launcher and zero-status arguments. Remaining values are pure harness options
with unique static keys; spreads, computed overrides, assignments, calls, and
irrelevant bindings fail closed. Pre-loop and post-call returns, breaks, catching
try blocks, and conditional skips are rejected. The only allowed wrapper is a
non-catching `try/finally` with no return.
The file retains one top-level `runFinalizerHarness`.
It retains one top-level `terminalMonitorFixture`.
Both are used only through direct calls.

The exact 135-row ledger prefix retains SHA-256
`f42621dd2b4400f075ff182be37a6f2953ce9ef1f47fc3b4b2ed2d6167bc22d3`.
Five append-only open rows bring the ledger to 140 rows and 140 unique IDs with
SHA-256
`401a417c41f1c24aaef1fdf8990ae1c049c8d7affcb822e8d552fc2372d463e3`.
Deterministic verification also exposed that the four-scenario terminal-stage
boundary test consumed 14.0-14.9 seconds under its 15-second limit. The harness
now tightens only its test-local `run_before_deadline` polling from 50ms to 10ms
for `afterTerminalStage` scenarios; production launcher polling and the
15-second test limit are unchanged. The focused boundary test passes 1/1 with
32 assertions in 11.5 seconds.

Focused policy verification passes 18/18 with 88 assertions. The isolated
artifact suite passes 112/112 with 1,584 assertions, and the four-suite
aggregate passes 450/450 with 3,331 assertions. Flow typecheck, exact ledger
validation, Bash syntax, documentation link, symbol, and signature checks pass.
Full verification records 466 passes, one gated skip, zero failures, and 1,336
assertions. A new manifest, three fresh audits, preflight, and any live run
remain pending.
Another live run requires fresh explicit authorization.
## Correction 50

Nine validated root causes remained after Correction 49:

- `audit-finalizer-harness-callback-identity`: fragment and count checks did not
  bind complete callbacks. The policy now requires exact normalized callback
  source digests for all seven protected tests.
- `audit-finalizer-harness-option-binding-purity`: an effectful pre-loop alias
  could satisfy an otherwise passive option expression. The protected callback
  identities now require the exact pure pre-loop option bindings.
- `audit-matcher-proof-symbol-identity`: same-name local shadows could satisfy
  matcher checks. The contract now resolves canonical TypeScript symbol identity
  for the preload writer and imported matcher helper.
- `audit-delivery-immutable-push-ref`: mutable `HEAD` and the current remote name
  could drift. Delivery now uses one captured origin URL, an immutable
  validated-SHA push ref, and an exact `ls-remote` branch-SHA proof before PR
  creation.
- `audit-merge-command-authority`: confirmation could hide a failed squash
  response. A failed squash command now throws before confirmation can run.
- `audit-terminal-report-binding`: a nonempty PR URL could authorize launcher
  success. A complete terminal report binding now proves launcher, run, monitor,
  repository, fixed head, CI, merge, timing, SLA, and usage claims before hash or
  ledger staging.
- `audit-work-finalization-reserve`: active work could consume the full deadline,
  and merge subtracted the reserve twice. Runtime work now leaves one worker
  finalization reserve, merge consumes that cutoff without another subtraction,
  and launcher work leaves its own reserve before terminal publication.
- `audit-timeout-usage-accounting`: non-scout timeouts discarded valid settled
  usage. The shared wrapper records fulfilled terminal usage once and rethrows
  the same timeout.
- `audit-design-contract-drift`: design text omitted two control fields, allowed
  one path, and described only one commit. It now documents the four-field
  `selectedControl`, exactly two to three changed paths, and the full
  parent-to-head diff.

The unchanged 140-row prefix retains SHA-256
`401a417c41f1c24aaef1fdf8990ae1c049c8d7affcb822e8d552fc2372d463e3`.
Nine append-only open rows bring the ledger to 149 rows and 149 unique IDs with
SHA-256
`607bd1a3250dcf1afeb9880683179391a69cc98fda7e151c938d0b9658604338`.

Final measured gates: focused docs/proof verification passes 2/2 with 150
assertions. The isolated artifact suite passes 119/119 with 1,936 assertions,
and the four-suite aggregate passes 464/464 with 3,700 assertions. Flow
typecheck and exact launcher ledger validation pass. Bash syntax,
documentation link checking for 53 files, symbol and signature checks, and
`git diff --check` pass. Full verification records 466 passes, one gated skip,
zero failures, and 1,336 assertions.

A new manifest, three fresh audits, preflight, and a live run remain pending.
No manifest generation, audit, preflight, live execution, push, PR, CI wait, or
merge ran in Correction 50. Any live run or GitHub write requires fresh explicit
authorization.

## Correction 51

One cross-layer root cause remained after Correction 50:

- `audit-cross-layer-finalization-reserve-composition`: Task 4 review blocked
  commit because the launcher and runtime independently claimed the same final
  10-second interval. The launcher could terminate a worker while runtime
  terminal evidence was still being published. The launcher now exports its
  absolute worker cutoff through `ORCA_IMPROVEMENT_WORKER_DEADLINE_AT_MS`;
  runtime binds that exact safe integer as `workerDeadlineAtMs` before fallible
  setup, records it in the terminal report, stops active work 10 seconds earlier,
  and completes finalization by the worker cutoff. Launcher terminal validation
  requires that exact reported cutoff and rejects `finishedAtMs` after it before
  success hashing or ledger staging.
- For the simple profile, runtime active work ends at 580 seconds, runtime
  finalization owns 580-590 seconds, and launcher finalization owns 590-600
  seconds. These disjoint windows preserve the unchanged 600-second outer SLA.
  Medium and challenging profiles retain their unchanged absolute deadlines and
  the same two exact reserves.

The unchanged first 149 rows retain SHA-256
`607bd1a3250dcf1afeb9880683179391a69cc98fda7e151c938d0b9658604338`; the
first 140 rows still retain SHA-256
`401a417c41f1c24aaef1fdf8990ae1c049c8d7affcb822e8d552fc2372d463e3`.
One append-only open row brings the ledger to 150 rows and 150 unique IDs with
SHA-256
`f77b1bf5c4ec4a65b28c4d433a3a46e0bf4c43bb0ad72212f86da250af0e9872`.

Final measured gates: focused Correction 51 proof and mutation policy pass 2/2
with 124 assertions. The isolated artifact suite passes 122/122 with 2,093
assertions, and the four-suite aggregate passes 467/467 with 3,861 assertions.
Flow typecheck and exact extracted launcher ledger validation pass. Bash syntax,
documentation link checking for 53 files, symbol and signature checks, and
`git diff --check` pass. Full verification records 466 passes, one gated skip,
zero failures, and 1,336 assertions.

A new manifest for the ordered 14-file set, three fresh audits, preflight, and a
live run remain pending. No manifest generation, audit, preflight, live
execution, push, PR, CI wait, or merge ran in Correction 51. Any live run or
GitHub write requires fresh explicit authorization.

## Correction 52

Two evidence-audit root causes remained after Correction 51:

- `audit-correction49-proof-section-boundary`: The Correction 49 proof sliced
  from its heading through end-of-file, allowing Correction 50 or later text to
  supply a missing required historical token. The Correction 49 proof now
  locates an exact Correction 50 Markdown heading and inspects only the bounded
  Correction 49 section. A borrowing mutation removes `exact scenario-array
  digests` from Correction 49 and places it in Correction 50; the policy
  rejects it.
- `audit-correction51-ledger-claim-semantic-binding`: The Correction 51 proof
  required count and SHA-256 fragments rather than affirmative ledger
  semantics. `do not retain SHA-256` and `does not bring the ledger to 150 rows
  and 150 unique IDs` preserved those fragments while reversing the claims.
  The Correction 51 inspector now requires the two exact normalized affirmative
  ledger sentences, and both semantic-negation mutations are rejected.

The unchanged first 150 rows retain SHA-256
`f77b1bf5c4ec4a65b28c4d433a3a46e0bf4c43bb0ad72212f86da250af0e9872`.
Two append-only open rows bring the ledger to 152 rows and 152 unique IDs with
SHA-256
`24328b018809a39e2659dcc62e94c7600d106e63cebb2d4cfc00af83ee24bdcb`.

Final measured gates: focused Correction 52 proof and mutation policy pass 2/2
with 147 assertions. The isolated artifact suite passes 123/123 with 2,235
assertions, and the four-suite aggregate passes 468/468 with 4,003 assertions.
Flow typecheck and exact extracted launcher ledger validation pass. Bash syntax,
documentation link checking for 53 files, symbol and signature checks, and
`git diff --check` pass. Full verification records 466 passes, one gated skip,
zero failures, and 1,336 assertions.

A new manifest for the ordered 14-file set, three fresh audits, preflight, and a
live run remain pending. No manifest generation, audit, preflight, live
execution, push, PR, CI wait, or merge ran in Correction 52. Any live run or
GitHub write requires fresh explicit authorization.

## Correction 53

Three historical-proof boundary root causes remained after Correction 52:

- `audit-correction50-proof-heading-start`: The Correction 50 proof located its
  start with plain-text `lastIndexOf`, so a plain non-heading Correction 50
  label could satisfy the historical proof. The shared parser now requires an
  exact supported Markdown heading before the Correction 50 row anchor.
- `audit-correction51-heading-word-boundary`: The Correction 51 and Correction
  52 heading matchers lacked numeric word boundaries, so Correction 510 or
  Correction 520 could satisfy an exact historical heading. The shared matcher
  now requires the complete requested correction number.
- `audit-correction51-proof-section-end-boundary`: The Correction 51 proof
  ended at reusable authorization text instead of its next correction heading,
  so its required authorization could be borrowed from Correction 52. The
  shared extractor now ends the section at the exact next-number heading.

One shared exact Markdown heading matcher accepts `##`, `###`, and checked-list
headings with optional bold markers and requires `\bCorrection <number>\b`. One
shared historical extractor requires an exact current heading before its row
anchor, an exact next-number heading after that row anchor, and
`current < row < next`; it returns only `source.slice(current, next)`.
Corrections 49, 50, 51, and 52 now use that extractor.

The unchanged first 152 rows retain SHA-256
`24328b018809a39e2659dcc62e94c7600d106e63cebb2d4cfc00af83ee24bdcb`.
Three append-only open rows bring the ledger to 155 rows and 155 unique IDs with
SHA-256
`5e64ec63520b0f86bb53e4abe7f5f1b072543dde459c96e65b9e1e6dbef41b65`.

Final measured gates: focused Correction 53 proof and mutation policy pass 2/2
with 171 assertions. The isolated artifact suite passes 124/124 with 2,397
assertions, and the four-suite aggregate passes 469/469 with 4,165 assertions.
Flow typecheck and exact extracted launcher ledger validation pass. Bash syntax,
documentation link checking for 53 files, symbol and signature checks, and
`git diff --check` pass. Full verification records 466 passes, one gated skip,
zero failures, and 1,336 assertions.

A new manifest for the ordered 14-file set, three fresh audits, preflight, and a
live run remain pending. No manifest generation, audit, preflight, live
execution, push, PR, CI wait, or merge ran in Correction 53. Any live run or
GitHub write requires fresh explicit authorization.

## Correction 54

Nine successor-audit root causes remained after Correction 53:

- `audit-runtime-filesystem-deadline-coverage`: Active filesystem operations
  now share the exact 580-second work remainder and reject completion at or
  after cutoff.
- `audit-ci-poll-deadline-reserve`: Every pending CI sleep is deadline-bound
  and preserves the 5,000 ms merge-confirmation plus 5,000 ms issue-closure
  reserves.
- `audit-launcher-publication-deadline-coverage`: Every canonical launcher
  publication uses the supervised atomic rename protocol with a 1,000 ms
  read-only recovery reserve.
- `audit-merge-response-authoritative-confirmation`: Every exact SHA-locked
  squash response is persisted before authoritative state confirmation,
  including failed responses and ordered dual-cause failure.
- `audit-correction-heading-horizontal-whitespace`: Correction headings accept
  horizontal space or tab only; a newline after the Markdown marker is
  rejected.
- `audit-correction-row-anchor-exact-line`: Escaped row IDs match only exact
  Markdown anchor lines; suffixed and prose-only IDs are rejected.
- `audit-correction-heading-uniqueness`: Each current and supplied next-number
  correction heading must occur exactly once.
- `audit-correction53-section-end-boundary`: Correction 53 is bounded by the
  exact Correction 54 heading rather than reusable authorization prose or EOF.
- `audit-proof-semantic-execution-binding`: Exact section bytes and SHA-256
  values bind historical wording, semantic polarity, and measured-count prose
  without claiming that static text executed a command.

The unchanged first 155 ledger rows retain SHA-256
`5e64ec63520b0f86bb53e4abe7f5f1b072543dde459c96e65b9e1e6dbef41b65`.
Nine append-only open rows bring the ledger to 164 rows and 164 unique IDs
with SHA-256 `1311cdd92f9177984ccce0f74d3f8c794c13529b86837503b1597502008a723c`.

Static hashes bind wording and history only. Executed focused and aggregate
gate outputs plus a fresh preflight prove execution. Historical measured-count
prose remains locked documentation, not evidence that those commands ran.

Final measured Task 4 gate: focused proof document policy and Correction 54
verification passes 5/5 with
68 assertions.
The Task 5 aggregate gate and fresh preflight remain pending and must execute;
their later outputs, not this static section, will prove those actions.

No manifest generation, audit, preflight, live execution, push, PR, CI wait,
or merge ran in Correction 54. Any live run or GitHub write requires fresh
explicit authorization.
## Correction 55

One proof-evidence audit finding remained after Correction 54:

- `audit-correction-heading-line-terminator-exclusion`: Both correction-heading
  free-text fragments now exclude CR, LF, LINE SEPARATOR, and PARAGRAPH
  SEPARATOR; a Markdown marker cannot borrow a later Correction label across
  any ECMAScript line terminator.

The unchanged first 164 ledger rows retain SHA-256
`1311cdd92f9177984ccce0f74d3f8c794c13529b86837503b1597502008a723c`.
One append-only open row brings the ledger to 165 rows and 165 unique IDs
with SHA-256 `62f6ed7843676b071f88908dcd82a0b9e64613d06cc1ad44da26a86fe8d862db`.

Static hashes bind wording and history only. Executed focused and aggregate
gate outputs plus a fresh preflight prove execution. Historical measured-count
prose remains locked documentation, not evidence that those commands ran.

Final measured Task 1 gate: focused proof document policy, Correction 54, and
Correction 55 verification passes 7/7 with 98 assertions.
The Task 2 aggregate gate, three successor audits, and fresh preflight remain
pending and must execute; their later outputs, not this static section, prove
those actions.

The Correction 54 successor digest
`7f66b7c0a901ac6ca5632dc93a1f6bf8ab4aeb09d356db5641001d97ba963e6a`
is invalidated historical evidence and cannot authorize preflight or live
execution.

No C55 successor manifest, successor audit, preflight, live backend, push, PR,
CI wait, or merge ran in Task 1. Fresh authorization remains required for any
live run or GitHub write.
## Correction 56

Two deadline and atomic-publication audit findings remained after Correction 55:

- `audit-terminal-ledger-recovery-reserve`: Terminal-ledger commit now spends
  the existing 1,000 ms reserve on its merge and runs one read-only recovery
  validator under the remaining outer deadline. Both signal channels gate
  recovery before and after it; a stalled validator is terminated and cannot
  authorize success after cutoff.
- `audit-canonical-publication-no-clobber`: Each canonical destination now uses
  a destination-keyed `mkdir` publication lock held through the final absence
  check and `mv`. Existing, invalid, SIGKILL-stale, or cleanup-stale locks fail
  closed with status 73, while cleanup preserves an already committed move
  status.

The unchanged first 165 ledger rows retain SHA-256
`62f6ed7843676b071f88908dcd82a0b9e64613d06cc1ad44da26a86fe8d862db`.
Two append-only open rows bring the ledger to 167 rows and 167 unique IDs
with SHA-256 `390a6523ffc73ddb04daba2820605115059a4032dd7c78ff32687008e91662ed`.

The exact Correction 55 section remains 1,530 UTF-8 bytes with SHA-256
`186c083d3f40dd8fd3e39903e794f29ad776802591ffb7b8a690d091ec209f13`. The C55
successor digest
`8e90acb21113296ff9d5590465273d38cbc0b265e5b5618ffda33e8a039cd5a6`
is invalidated historical evidence and cannot authorize preflight or live
execution.

Measured Task 1 final focused verification passed 11/11 tests with 127
assertions; `bash -n` and `bun run typecheck` passed. Measured Task 2 final
focused verification passed 15/15 tests with 291 assertions; `/bin/bash -n`,
`bash -n`, `bun run typecheck`, and `git diff --check` passed. These are the
only executed results recorded in this static section.

The full deterministic aggregate gate, successor manifest and digest, three
successor audits, fresh simple preflight, live backend run, push, ready PR, CI
wait, and SHA-locked squash merge remain pending. No preflight, live backend,
push, PR, CI wait, merge, or GitHub mutation ran in Correction 56 Task 3.
Fresh authorization remains required for any live run or GitHub write.
## Correction 57

The required stock-Bash artifact gate and independent Task 1 review exposed three
proof failures after Correction 56:

- `audit-stock-bash-harness-process-identity`: Explicit macOS Bash 3.2 proof now
  uses portable top-level self-signalling and direct-child parent-PID capture for
  background workers. Early child exit returns structured diagnostics, and exact
  PID, process-group, stream, and temporary-root teardown remains bounded.
- `audit-terminal-ledger-post-commit-signal-recovery`: A caught launcher signal
  no longer decides whether the canonical ledger rename committed. One supervised
  exact terminal-record and full-ledger-hash probe fails before rename and retains
  status 143, or succeeds after an authorized rename and preserves committed
  success. Terminal-commit signals still gate and override recovery.
- `audit-harness-pipe-eof-before-group-cleanup`: Both structured harnesses start
  draining pipes immediately but terminate their exact owned process groups before
  awaiting EOF. A dual inherited-pipe regression proves no fallback kill, live
  group, or exact temporary root remains.

The unchanged first 167 ledger rows retain SHA-256
`390a6523ffc73ddb04daba2820605115059a4032dd7c78ff32687008e91662ed`.
Three append-only open rows bring the ledger to 170 rows and 170 unique IDs with
SHA-256 `223969995ddcfdef812fe919e3f5a706e059278cfba592e3d8eec00286aae1de`.

The exact Correction 56 section remains 2,091 UTF-8 bytes with SHA-256
`3122b34df66312a94ed78eb3631bc7e79b442d0e48bfe656f444da444b3e961e`.
No Correction 56 successor manifest or digest was created: its required isolated
artifact gate failed before commit, lock generation, audits, or preflight.
Correction 56 therefore remains historical static evidence and cannot authorize
preflight or live execution.

Final measured Correction 57 Task 1 verification passed the inherited-pipe test
1/1 with 21 assertions, atomic family 4/4 with 93 assertions, terminal family
5/5 with 61 assertions, and contract family 2/2 with 57 assertions: 12/12 tests
and 232 assertions total. Both Bash syntax checks, exact non-skip flow typecheck,
whitespace checks, protected-byte checks, and residue checks passed. Independent
re-review repeated these gates and approved Task 1 with zero findings.

The full isolated artifact suite, explicit four-suite aggregate, repository
verification, Correction 57 successor manifest and digest, three sequential
successor audits, fresh simple preflight, live backend run, push, ready PR, CI
wait, unchanged-head proof, and SHA-locked squash merge remain pending. No
preflight, live backend, push, PR, CI wait, merge, or GitHub mutation ran in
Correction 57 Task 1 or Task 2. Fresh authorization remains required for the one
live simple proving run and every GitHub write.
## Correction 60

Five deadline and atomic-publication audit findings remained after Correction 59:

- `audit-terminal-ledger-stage-no-follow`: Terminal-ledger publication now creates
  one private `0600` six-X stage beside the canonical ledger after managed
  children stop. Repeated regular-file, non-symlink, and same-parent checks fail
  closed before copy, hashing, deadline authorization, and rename.
- `audit-detached-descendant-trust-boundary`: Containment explicitly covers
  process-group members and descendants retaining the inherited owner token.
  Bounded inspection must prove that cooperative set empty. Arbitrary same-UID
  hostile processes remain outside the proof, and no kernel isolation is claimed.
- `audit-controller-wide-deadline-coverage`: Safe controller state and traps now
  precede external work. A Bash-3.2-compatible low-level controller bounds startup,
  command execution, owner scans, finalization, and cleanup with fixed descriptors,
  builtin timing, TERM/KILL cutoffs, and fail-closed status. Captured stdout stays
  inside the owned process group: an in-group broker isolates raw bytes from fd 7,
  latches signals, publishes one length-checked typed frame, and leaves no capture
  temporary file even when both owned groups receive SIGKILL.
- `audit-terminal-ledger-same-filesystem-rename`: The terminal stage and canonical
  ledger share one parent. Fresh hashes and boundary checks precede the positive
  exact-deadline decision, followed immediately by same-directory `mv` with no
  fallible operation inserted between authorization and rename.
- `audit-ci-probe-delivery-reserve`: Head checks, CI reads, and pending poll sleep
  use only the allowance remaining after the exact merge-confirmation and issue-
  closure reserves. Non-positive allowance rejects before invocation.

The unchanged first 170 ledger rows retain SHA-256
`223969995ddcfdef812fe919e3f5a706e059278cfba592e3d8eec00286aae1de`.
Five append-only open rows bring the ledger to 175 rows and 175 unique IDs with
SHA-256 `cfa3814b36f66ffe8d8028e4c332ccb9cdb9a356f368248f3231128635283b67`.
The primary package lock remains SHA-256
`a9f2f75a69a2f247a00536a04d4b5be1cc36330c850c7fd31fdd388f7fd1f8f9`.

The exact Correction 57 section remains 2,800 UTF-8 bytes with SHA-256
`c5ef679021a6fdf2275764ea3ca3b94f9b760a9fc8b24f78cea364d9a4198955`.
The Correction 59 successor digest
`d6bbe87f4859eed4511017ae3fb465db4aa70f8a4b09a6b525bd2ef1e65a350f`
is invalidated historical evidence and cannot authorize preflight or live
execution.

Task 1 through Task 4 used focused RED/GREEN, adversarial mutations, syntax or
type checks, and independent review before Task 5 synchronization. Final triage
also binds source probes to the current low-level controller and finalizer
structure, gives detached-child readiness a disjoint margin before active TERM,
uses a block-bodied CI sleep callback, and removes the guarded non-null assertion.

Task 5a requires focused and adversarial gates, both Bash syntax checks, the
stock-Bash artifact suite, four-suite aggregate, exact flow typecheck, docs gates,
diff check, and repository verification on final bytes before freezing the new
fourteen-file manifest and digest. Static prose and hashes are not execution
evidence; the final Task 5 report records actual command outputs.

Three sequential successor audits, no-write preflight, live backend proof, push,
ready PR, CI wait, unchanged-head proof, and SHA-locked squash merge remain
outside Task 5a and did not run in this phase. No commit or GitHub mutation ran.
## Correction 61

One residual-ownership contract mismatch remained after Correction 60:

- `audit-observed-once-residual-ownership`: Prior TERM or KILL discovery now
  triggers cleanup without replacing a successful command status. Final bounded
  `NONE` inspection is authoritative: a proven-empty cooperative owner set
  preserves status `0`; inspection failure or residual ownership returns `125`.
  Timeout `124` and signal `143`, `130`, and `129` behavior remains unchanged.

The launcher, workflow contract, runbook, both plans, design, regression
contracts, ledger, and progress now use final residual ownership rather than
observed-once ownership. The detached-helper proof requires the helper dead,
forbids its late write, and expects a successful leader to return `0`. A durable
source mutation restores the old observed-once `125` branch and must fail that
behavior proof.

The unchanged first 175 ledger rows retain SHA-256
`cfa3814b36f66ffe8d8028e4c332ccb9cdb9a356f368248f3231128635283b67`.
One append-only open row brings the ledger to 176 rows and 176 unique IDs with
SHA-256 `c1722959c52ce941b8cea542bec7d1f7171baab17387a18226c98baa39a9e2d2`.
The primary package lock remains SHA-256
`a9f2f75a69a2f247a00536a04d4b5be1cc36330c850c7fd31fdd388f7fd1f8f9`.

The exact Correction 60 section remains 3,554 UTF-8 bytes with SHA-256
`7e0b1ceae71372a74841cf7280dbc9c6eb95bf3a9baca3ecc8b263690886511a`.
The Correction 60 successor digest
`800f96b4aea138a9c26bc0d0d2ef306c4363ae91b4897ec48157197b557ac7b2`
is invalidated historical evidence and cannot authorize successor audits,
preflight, or live execution.

Task 1 requires witnessed RED and GREEN, explicit old-rule mutation failure,
both Bash syntax checks, exact flow typecheck, stock-Bash artifact gate,
four-suite aggregate, docs gates, diff check, and repository verification on
one final byte set. Static prose and hashes are not execution evidence; the
Task 1 report and raw final-gate transcript record actual command outputs.

Three sequential successor audits, no-write preflight, live backend proof,
commit, push, ready PR, CI wait, unchanged-head proof, and SHA-locked squash
merge remain outside Correction 61 Task 1 and did not run.
## Correction 62 — controller capture and cleanup status precedence

Correction 61 successor Audit 1 exposed two controller-precedence defects:

- `audit-controller-capture-signal-deferral`: Controller-side captures now
  compute deadline cutoffs and invoke `controller_run_until --capture` directly
  in the current shell, then assign through `printf -v`. Startup capture no
  longer wraps the deadline controller in command substitution.
- `audit-owner-cleanup-status-precedence`: Every bounded TERM, KILL, and final
  NONE owner scan propagates timeout `124` and signals `143`, `130`, and `129`
  unchanged. Unknown inspection failure or residual cooperative ownership still
  returns `125`; the caller also latches a propagated signal status.

Cleanup partition is exact: TERM `0` ends cleanup and `42` advances to KILL;
KILL `0` or `42` advances to final NONE; final NONE `0` proves empty and `42`
returns `125`. Each scan propagates `124`, `143`, `130`, or `129` and maps any
other status to `125`.

Capture protocol framing is fail-closed. Every successful NUL-delimited record
must match typed PID, payload, or status syntax. A successful empty record has
read status `0` but is untyped and returns `125`. The separate Bash 3.2 empty
timed-poll case has read status `1` and continues only while the wrapper lives;
dead-wrapper EOF and nonempty partial records return `125`.

The real startup harness blocks both `now_ms` and startup Git capture, delivers
TERM only after entry, and requires status `143` within 1,500 ms with no live
controller or process-group residue. The cleanup matrix blocks TERM, KILL, or
NONE inspection after leader exit and requires exact `124`, `143`, `130`, and
`129` results with no controller residue. Executed historical command-substitution
and cleanup-flattening mutations each failed their behavior proof; final restored
bytes passed the focused family 4/4 with 63 assertions.

The combined review regression injected an empty NUL record before valid frames
and recorded its first read as status:length `0:0`; the old parser returned `0`
instead of `125`. The one-line unconditional fallback passed 1/1 with 6
assertions. Restoring the nonempty-only guard failed the durable contract with
`captured broker must reject every untyped successful record`; restored
behavior plus contract passed 2/2 with 13 assertions. The 11-case controller
neighborhood passed 11/11 with 96 assertions.

The unchanged first 176 ledger rows retain SHA-256
`c1722959c52ce941b8cea542bec7d1f7171baab17387a18226c98baa39a9e2d2`.
Two append-only open rows bring the ledger to 178 rows and 178 unique IDs with
SHA-256 `c196e0aa2c91f87540d1c2187d8b318f58fcacc7d6e319aeac5d9292fb2d338a`.
The primary package lock remains SHA-256
`a9f2f75a69a2f247a00536a04d4b5be1cc36330c850c7fd31fdd388f7fd1f8f9`.

The current Correction 62 fourteen-file manifest digest is externalized in
`.superpowers/sdd/correction62-successor-digest.txt`. These proof documents are
themselves manifest payloads, so embedding the numeric digest here would make
the digest recursively depend on itself; the Task 1 report and frozen package
bind the exact value.

The exact Correction 61 section remains 2,206 UTF-8 bytes with SHA-256
`25cb9a47b3d40585c7a6ed8b758e25b694981426b2bb340112f519f0e3bfb754`.
The Correction 61 fourteen-file successor manifest digest
`6d063971281ca6e6bf505bdc60120833fb52e559872e681fff51380c722aa6ac`
is invalidated historical evidence and cannot authorize successor audits,
preflight, or live execution.

Final ordered verification passed paired 14/14 manifest checks with one unchanged
digest, the focused Correction 62 family, the stock-Bash artifact suite, the
four-suite aggregate, both Bash syntax checks, exact flow typecheck, docs gates,
diff check, and repository verification. The raw transcript and Task 1 report
record commands, outputs, statuses, durations, hashes, and residue checks.

Containment remains cooperative: it covers process-group members and descendants
retaining the inherited owner token. Arbitrary same-UID hostile processes remain
outside the proof, and this is not kernel isolation. Successor audits, no-write
preflight, live backend proof, commit, push, PR, CI wait, and merge remain outside
Correction 62 Task 1 and did not run.
## Correction 63

Five final broad-review findings remained after Correction 62:

- `audit-finalization-temp-symlink-overwrite`: Finalization text publication now
  delegates to one runtime publisher. It creates a cryptographically random
  same-directory regular file with `O_CREAT | O_EXCL | O_WRONLY` and mode
  `0600`; write, durability, close, byte-count, and identity checks finish
  before `commitPublication()`, with rename immediately next. Cleanup unlinks
  only the exact created device/inode and never follows the old predictable
  symlink.
- `audit-delivery-identity-deadline-bypass`: Repository parsing assigns through
  a validated output name and `printf -v` in the current shell. Both external
  lowercase operations run through `capture_before_deadline`; timeout `124`,
  fetch/push identity checks, and case-insensitive comparison remain intact.
- `audit-cancellation-failure-settlement`: Failed cancellation cleanup now
  stores one typed `BackendFailed` outcome plus the shared `cancel()` rejection
  under the active outer settlement reservation. An internal completion channel
  lets the run finalizer finish held stdout/stderr iterator teardown without
  awaiting the public cancellation promise; outcome and rejection publish once
  at final release.
- `audit-terminal-subprocess-quiescence`: One terminal finalizer owns timeout,
  cancellation, consumer failure, stream cleanup, bounded TERM-to-KILL, exit,
  and reservation release. POSIX children use process groups and await leader
  close plus group disappearance. The disappearance wait owns one cancellable
  timer; any termination failure rejects the exit wait with the same error and
  clears polling. Windows retains its gated leader fallback.
- `audit-reasoning-effort-model-compatibility`: Both backend references state
  that all six declared values forward to Codex without a local model catalog.
  Acceptance depends on selected model and Codex CLI version; rejected
  combinations return a backend failure.

Final whole-change review found that cancellation failure still published before
outer release, process-group disappearance polling could continue after bounded
cleanup gave up, and timeout documentation incorrectly said `Conversation.signal`
aborted. All three were repaired without changing runtime timeout signal
semantics.

A later whole-re-review found that canonical cancellation docs described only
successful cleanup: they promised that `cancel()` resolves and
`awaitResult()` becomes cancelled, but omitted the cleanup-failure path. Both
documentation surfaces now preserve normal successful cancellation and state
that cleanup failure rejects the shared cancellation promise and publishes a
typed `BackendFailed` only after final cleanup and settlement release.

Strict RED/GREEN and mutation proof preceded synchronization. The finalization
RED changed an external file through the planted predictable symlink; GREEN
passed 2/2 with 62 assertions, and restoring the old publisher failed the
external-byte assertion. The delivery RED entered a PATH-shadowed hanging `tr`
and returned `143` instead of required `124`; GREEN passed 2/2 with 23
assertions, and restoring command substitution reproduced the failure.

Cancellation, reservation, terminal-consumer, real POSIX group, terminal-family,
and stderr-cleanup REDs all exposed premature or missing settlement. The first
Slice C freeze passed 90/90 with 250 assertions; cancellation, reservation,
immediate-kill, and leader-only historical mutations each failed.

Final-review REDs then observed cancellation outcome and rejection before outer
release and before held stdout/stderr teardown. A naive public-result deferral
mutation stalled teardown. GREEN passed the reservation unit 1/1 with 5
assertions and held-stream integration 1/1 with 6 assertions. The group-poll RED
scheduled three additional 10 ms timers after termination failure; GREEN passed
1/1 with 4 assertions, proving the exit wait rejected with the same error and
left zero polling timers. Removing registered poll cancellation reproduced a
pending exit. The timeout-doc lock RED missed the actual-signal contract; GREEN
passed 1/1 with 9 assertions, and restoring the false signal-abort claim failed.

The cancellation-doc lock RED missed the success/failure contract and failed
0/1 after one assertion. GREEN passed 1/1 with 6 assertions. Restoring the
resolve-only claim failed 0/1 with 3 assertions, then exact GREEN bytes were
restored. No runtime semantic changed.

A later successful-cancel cleanup audit found that subprocess finalization
discarded stdout/stderr cleanup errors after termination had succeeded. The
pending cancellation outcome therefore published as `cancelled` and the shared
`cancel()` promise resolved even though owned stream teardown failed.

The qualifying RED held both cleanup paths, rejected stdout cleanup, completed
stderr cleanup, and received `{ type: "cancelled", reason: "stop" }` instead of
a typed `BackendFailed`; the shared cancellation promise resolved. GREEN
registers one internal late-failure handler with the shared promise.
Cancellation cleanup failure has higher settlement priority than successful
cancellation and reports a cleanup error before final release. Outcome remains
pending until both streams finish, then typed failure publishes before the exact
cleanup error rejects the shared promise. Timeout stream cleanup errors likewise
win before timeout settlement. The focused GREEN passed 1/1 with 8 assertions;
restoring discarded `await cleanupStreams()` in both cancellation paths failed
0/1 with the same cancelled outcome. Exact source bytes were restored and GREEN
passed again. A final lifecycle re-review then found that consumer and timeout
cleanup errors still called `conversation.fail` after cancellation had started.
Active cancellation made those calls no-ops, so `cancel()` resolved and a
`cancelled` outcome hid the teardown error. It also found no deadline around
stdout iterator return, line-generator return, stderr cancellation/return, or an
awaited stderr collector result after process exit; any one could retain run or
timeout settlement reservations forever.

Four real-behavior REDs received two `cancelled` outcomes and two pending
sentinels. GREEN routes consumer and timeout cleanup errors through the registered
cancellation-failure handler only while cancellation owns settlement, preserving
ordinary timeout failure ordering. Finalization starts one absolute
stream-teardown deadline from the configured wall-clock budget. Every awaited
stdout and stderr teardown shares its remaining time; expiry becomes a typed
cleanup failure and every reservation releases.

The final focused GREEN passed 4/4 with 7 assertions. Disabling cancellation-
failure routing failed 0/2 and again published `cancelled`; disabling deadline
rejection failed 0/2 with both paths still pending. Exact bytes were restored.

A subsequent whole-review-4 race found that the terminal-error finalizer discarded
cleanup errors returned by `terminateAndCleanup(false)`. When a consumer error
started termination, cancellation began while exit was pending, and stdout
iterator return rejected, the run preserved its primary rejection but `cancel()`
resolved and `awaitResult()` returned `cancelled`.

The one-test RED recorded exactly those three outcomes. GREEN captures returned
cleanup errors; while cancellation is active it reports the first through the
registered cancellation-failure handler before rethrowing the exact primary
error. Without cancellation, the primary error keeps precedence. Removing only
that routing reproduced the same RED. Exact bytes passed the focused race 1/1
with 4 assertions, the full Codex file 45/45 with 135 assertions, and 20/20
repeated race runs.

A successor-audit-2 docs review found that the website introduction still
claimed every fallible operation returns a `Result`, contradicting the same
page's typed asynchronous cancellation-cleanup contract. Result-returning
operations now represent expected failures as values, while asynchronous
lifecycle methods retain promise semantics: public `cancel()` resolves after
successful cleanup and rejects when cleanup fails.

The deterministic wording lock RED passed 20 existing tests and failed the new
claim with 56 assertions. GREEN passed 21/21 with 57 assertions. Restoring the
old absolute wording reproduced the same RED; restoring exact bytes passed the
targeted test, documentation links, and documentation symbols. No runtime
semantic changed.

The four affected backend/conversation suites passed 98/98 with 280 assertions,
and the regression passed 20/20 repeated runs. Typecheck, lint,
declarations/signatures, facade, and diff checks passed. Independent scoped
review returned Spec PASS, Quality PASS, and zero findings.

Final Slice C, backend, and reasoning coverage passed 106/106 with 301 assertions.
Reasoning-effort RED passed all six forwarding cases but failed the missing
two-surface contract; its original GREEN passed 7/7 with 8 assertions, and
suppressing `ultra` failed its table row.

The ledger RED expected 183 rows and received 178. Exact append, prefix, field
order, evidence, uniqueness, and one-LF EOF locks passed 3/3 with 25 assertions;
order, field, semantic, duplicate-ID, and EOF mutations were all rejected. Four
proof documents now carry this byte-identical section once at EOF, with heading,
row-order, count, status, semantics, hash, and post-EOF mutations locked.

The unchanged first 178 ledger rows retain SHA-256
`c196e0aa2c91f87540d1c2187d8b318f58fcacc7d6e319aeac5d9292fb2d338a`.
Five append-only open rows bring the ledger to 183 rows and 183 unique IDs,
110,097 bytes, and SHA-256
`6544bd11a635893b1f2890b3306fc27d4aac3fbe3724eac0d44bd66fddb63a03`.
The five-row suffix SHA-256 is
`f7bef2e8a82622fe84b2639b32747ac0f977fa53a210d219fd2fb5637da93d5b`.
The primary package lock remains SHA-256
`a9f2f75a69a2f247a00536a04d4b5be1cc36330c850c7fd31fdd388f7fd1f8f9`.
The exact Correction 62 section remains 4,272 UTF-8 bytes with SHA-256
`c30027f085ba22283e3a8816bf06567a441e70eb725d7b56f516b8012b530834`.

The Correction 62 successor digest is invalidated historical evidence. The
Correction 63 fourteen-file successor digest, separate correction-runtime
manifest, gate-log hash, and package hash are externalized in the Task 1 report
and frozen review package. Protected proof documents are manifest inputs, and
the gate log contains manifest checks, so embedding those values here would
create recursive hash dependencies.

Final ordered verification on frozen bytes passed affected workflow suites, all
Slice C suites, backend and reasoning tests, cancellation, timeout, and
Result/lifecycle documentation locks, system and Homebrew Bash syntax, exact
flow typecheck, documentation
links and symbols, lint, typecheck, diff check, and `bun run verify`. Paired
pre/post manifest, package-lock, 178-row prefix, HEAD/branch, process, and
temporary-residue checks remained unchanged.

Correction 62's first ordered aggregate had one load-sensitive existing terminal-
ledger recovery fixture fail once. It then passed unchanged 3/3 alone, the exact
aggregate retry, and the restarted final sequence. That historical timing
concern remains preserved rather than hidden.

The protected launcher artifact set remains exactly fourteen files; a separate
eleven-file manifest covers correction-only runtime, tests, and backend docs.
Public `Conversation` and package-root exports remain unchanged. Stock Bash 3.2
status
mapping remains `124`, `143`/`130`/`129`, and `125` as documented. Real process-
group behavior ran on macOS; the gated Windows fallback was not runtime-tested.
Candidate worktrees still start from `origin/main`; no history rewrite occurred.

Live acceptance, successor audit, no-write preflight, live backend, commit, push,
PR, CI wait, merge, and GitHub mutation remain outside Correction 63 Task 1 and
did not run.
