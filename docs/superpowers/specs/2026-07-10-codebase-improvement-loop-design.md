# Codebase Improvement Loop Design

## Context

Orcats needs a repeatable self-improvement run that proves its own workflow
contract against this repository. The run must isolate work, choose one small
evidence-backed improvement, implement it, verify it, review it, open a pull
request, wait for remote checks, and squash-merge it.

The previous `.orca/workflows/feature-fix-loop.ts` is not a suitable base:

- its only recorded feature run lasted 15 minutes 12 seconds and failed when
  the implementation turn hit the 600-second backend limit;
- it imports the retired `@twelvehart/orca-ts` package and invokes `orca`;
- it works in the caller's checkout instead of a fresh worktree;
- it has no per-stage instruction contract;
- it does not open, watch, or merge a pull request;
- it runs the full verification gate repeatedly, conflicting with the simple
  task target.

Current `origin/main` starts green: `bun test` reports 444 passing tests and one
opt-in live smoke skipped; `bun run lint` exits zero. Codex 0.144.1 is logged in,
Orcats 0.2.3 is installed, GitHub CLI is authenticated, and main has no branch
protection. Recent CI completes in about 70 seconds and Docs in about 20 seconds.

## Goals

1. Finish one simple improvement end to end in at most 10 minutes; faster is
   acceptable.
2. Support explicit medium and challenging profiles with ceilings of 30 and 45
   minutes without weakening the same delivery gates.
3. Make stage-specific skill and prompt instructions explicit inputs.
4. Expose live progress and preserve a machine-readable final run log.
5. Prove the selected change with test-first work, targeted repair gates,
   independent review, full verification, and remote checks.
6. Open and squash-merge the pull request without modifying the user's main
   checkout or deleting recovery evidence.
7. Record every workflow or runtime failure for the next iteration.

## Non-goals

- No new Orcats runtime or DSL API.
- No long-lived trigger service.
- No dependency, release, publishing, secret, security, or public-API work.
- No simple-profile task larger than three changed files. Medium allows at most
  six; challenging allows at most ten.
- No force-push, history rewrite, hard reset, broad clean, branch deletion, or
  worktree deletion.
- No multi-backend proving run. This proof uses default or explicit Codex only.
  Bounded terminal shutdown for OpenCode's managed server is separate
  source-runtime work and is not claimed by this workflow.

## Chosen Shape

Use a self-executing workflow based on the issue-to-PR archetype, with a launcher
that owns worktree creation. A `defineLoop()` module is not used because the
current firing path is optimized for trigger-to-output loops, while this task
needs flow-context command, Git, GitHub, monitoring, and baseline tools.

Local artifacts:

- `.orca/workflows/codebase-improvement.ts`: staged Orcats workflow;
- `.orca/workflows/codebase-improvement.config.json`: validated directives;
- `.orca/workflows/codebase-improvement.sh`: worktree launcher;
- `.orca/workflows/codebase-improvement.run.md`: operator runbook;
- `.orca/improvement-loop/issues.jsonl`: append-only run issue ledger.

The artifacts remain under the gitignored `.orca/` directory. The codebase
improvement produced by the workflow is the only content eligible for its pull
request.

## Stage Directive Contract

The configuration has one directive per agent stage:

```json
{
  "stages": {
    "scout": {
      "prompt": "Prefer a low-risk behavioral defect with a focused regression test."
    },
    "reproduce": {
      "skill": "tdd",
      "prompt": "Add only the failing regression test; do not change production code."
    },
    "implement": {
      "skill": "tdd",
      "prompt": "Fix the cause without changing or weakening the captured regression test."
    },
    "repair": {
      "skill": "debug-like-expert"
    },
    "review": {
      "prompt": "Report only concrete correctness, regression, safety, or test-quality blockers."
    }
  }
}
```

Each directive is validated as `{ skill?: non-empty string, prompt?: non-empty
string }`, with at least one field present. `renderDirective()` converts it to a
per-call `systemPrompt`. A skill directive states that the child agent must
invoke `$<skill>` before stage work. A prompt directive is copied verbatim after
the skill requirement. The workflow records the stage name and non-secret
directive fields in its run evidence.

The first live run proves both forms: `reproduce` and `implement` use `$tdd`;
`review` uses a specific blocking-review prompt.

## Launcher

The launcher performs deterministic isolation before Orcats starts:

1. Resolve the repository root and reject a non-git directory.
2. Validate every source-ledger row and immutable seed before installing a
   trap, creating evidence, logging, building, fetching, or running a backend.
3. Hash the primary checkout's existing `package-lock.json` and the exact
   bytewise-ordered fourteen-artifact audit set, including the ledger.
4. Capture source HEAD, archive that immutable commit into a private build
   directory, install frozen dependencies there, compile `dist/orcats`, copy the
   executable under run evidence, verify it resolves first on the launch PATH,
   and record its source HEAD, SHA-256, and version. Dirty source-worktree bytes
   cannot enter the runtime.
5. In preflight mode, run every deterministic gate and atomically attest the
   source HEAD, runtime SHA-256, fetched `origin/main` SHA, and artifact digest.
   Promote that attestation only after terminal finalization succeeds; a new
   preflight invalidates older success first. Live mode requires terminal
   success and that exact attestation before worktree creation and
   retains the distinct preflight run ID; the two launches never share an ID.
6. Fetch `origin/main`.
7. Generate a unique run ID and branch `orca/improve-<run-id>`.
8. Create a linked worktree from `origin/main` under the system temporary
   directory.
9. Snapshot and revalidate copied bytes before execution. Preflight copies all
   fourteen locked artifacts so artifact tests can read the three plan/spec
   files; live copies only the ten ignored workflow files and ledger so the
   strict candidate baseline and pull-request scope stay clean. Run
   `bun install --frozen-lockfile` there.
10. Export launch timestamp, profile, preflight path, and artifact digest so the workflow's
   deadline includes setup time and uses the correct ceiling.
11. Run the copied artifact through the PATH-pinned source binary with Codex.
12. Under an atomic directory lock, merge and validate isolated ledger appends;
   copy monitor, report, and merged ledger into the source evidence directory.
13. Recheck the protected package lock and enforce the profile deadline after
   finalization, then print worktree, branch, runtime provenance, elapsed time, exit
   code, monitor log, issue
   ledger, and pull-request URL when available.

The backend restriction does not change lock membership. The exact set remains
the issue ledger, the same ten `.orca/workflows/` files, and the same three
tracked plan/spec documents; no deferred OpenCode source-runtime file enters the
proof digest.

Evidence finalization fails closed and every blocking phase uses the shared
absolute deadline. Build, install, fetch, worktree, test, lint, live-run, and
finalization commands terminate and reap their process group on expiry. A
leader exit is not successful while any group member remains: residual members
receive `TERM`, then `KILL`, and a would-be zero status becomes `125`. Any
bounded command also inherits a run-unique owner token. Before returning, the
launcher finds token-owning descendants across process groups and sessions,
terminates them, and fails closed on inspection failure or residual ownership.
Owner enumeration streams through a pipefail-protected filter so temporary
storage receives matched PID lines only, never raw same-user environments. Any
required shutdown, ledger merge, directory, copy, discovery, report-read,
clock, JSON-render, or atomic-publish failure changes a previously successful
launcher exit to `74`; an earlier nonzero workflow status is preserved. Final
status and elapsed time settle before `latest.json` is atomically published.

The source binary is rebuilt from the captured committed HEAD for preflight and
live modes. Dirty tracked or untracked source-worktree bytes cannot enter it. A
global Orcats installation is ignored even when it appears first on the
operator's normal PATH.

The launcher never removes the worktree or branch. A failed run therefore keeps
all evidence available for diagnosis and bounded reruns.

## Workflow Lifecycle

### 1. Preflight

- Accept an unset, empty, or explicit `codex` backend request. Reject every
  other non-empty `ORCA_BACKEND` value before monitor creation, preflight,
  filesystem access, config reads, commands, or backend construction. The
  launcher also invokes the copied workflow with Codex explicitly.
- Bind the launcher run ID, retained branch, and launch timestamp before config,
  backend, or baseline work. Require the branch to equal
  `orca/improve-<run-id>` and later require Git to report the same branch.
- Bind and retain the launcher's preflight path and artifact digest; reject a
  missing or mismatched attestation before backend work.
- Parse the baseline policy, defaulting to `repair`.
- Require the fresh worktree to be clean.
- Run `bun test` and `bun run lint`.
- Confirm the branch starts at `origin/main`.
- Record the configured `origin` fetch and push URLs, then require the branch
  and both URLs again after every workspace-writing agent and before push.
- Confirm Codex and GitHub authentication without spending a backend turn.
- Start `WorkflowMonitor` and derive the 10-minute deadline from the launch
  timestamp supplied by the launcher.

### 2. Scout

Split scouting into deterministic evidence gathering and a bounded read-only
structured Codex synthesis phase. Gathering runs these exact bounded commands:

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

Recent-touch count and then path name determine stable source selection. Test
selection reserves the closest unused positive-overlap test for each source
that has one before filling remaining slots by overlap, recent touch count, and
path name. Assignment first maximizes covered sources, then total overlap, so a
shared test cannot consume another source's only related behavior surface.
The selected source-test assignments are preserved as structured metadata and
rendered as a mandatory `Reserved source-test pairs` section.
Rendering uses stable path and line order. It emits one `File: <path>` header
followed by numbered source lines, while citations remain `<path>:<line>`.
It reads at most eight tracked files: at most four `src/**/*.ts` paths and at
most four `tests/**/*.test.ts` paths. Every hotspot line and the first line of a
file without hotspots are mandatory. The latest-commit prefix shares the same
cap.
Files without hotspots retain up to their first 40 lines.
Optional complete lines are added round-robin across files through 16 lines on
each side of every hotspot. Mandatory overflow fails closed; no prefix, line,
or final packet is sliced. The evidence packet is capped at 10,000 characters.
Protected public entrypoints plus dependency, release, security, secret,
generated, documentation, skill, workflow, and `.orca/` paths are ineligible.
The report records packet paths, source-test pairs, character count, SHA-256
evidence digest, command logs in both validation and scout evidence, the latest
first-parent commit subject and changed paths,
synthesis attempt records, all three candidate seeds, the ranked IDs,
`selectedControl`, rejected attempts, the accepted control, and the hydrated
candidate only after genuine RED. The two worktree status snapshots must match
byte for byte.

The model receives only that packet and instructions not to inspect the
repository or call tools. It returns exactly three candidate seeds, a complete
ranked-ID permutation, and one control bound to the first ranked candidate:

```text
candidates[]: id, title, problem, evidence[], allowedPaths[], testPath,
targetedTestArgs[], expectedFailurePattern, implementationBrief,
expectedMinutes, risk
rankedCandidateIds[]: best-first candidate-ID permutation
selectedControl: candidateId, brief, testName, productionPath
```

Candidates must have `risk = "low"`, a `tests/**/*.test.ts` test path, at least
one distinct production path, and a targeted Bun test whose first argument is
`test`.
Every candidate cites at least one rendered line from its `testPath` and from
every allowed production path, then explains the causal path between them. The
target test must belong to a preserved source-test pair whose source is one of
that candidate's allowed production paths. Citation validation uses structured
markers generated from rendered source and test lines, never by reparsing the
packet prefix. The three ranked candidates require unique target tests. Each
canonical production path set must contain at least one path that neither other
candidate uses;
shared support paths remain allowed, but variants with no exclusive behavior
surface are not independent fallback ranks. Allowed paths must be unique, and
no non-target `tests/**` path is allowed.
`selectedControl.candidateId` must equal `rankedCandidateIds[0]`. Its brief
identifies a packet-grounded known-good adjacent input that uses the same
production entrypoint, setup, and observation path as the target; tautological,
mock-only, and unrelated controls are invalid. Rank one is hydrated first with
`selectedControl.brief`. Later-ranked controls are generated only if an earlier
rank produces a typed invalid proof. Each reproduction turn runs its exact
filtered control and candidate-configured target command as agent-side evidence
before returning. It must strengthen a passing target assertion until it fails
with the expected pattern; incidental runner, stack, or source text cannot
satisfy that assertion. Prompt commands shell-quote non-plain arguments so the
control pattern remains one argument. The parent independently reruns the
control, then runs only the statically identified added RED test under an
anchored exact-name selector before saving the immutable test diff.
Profile limits are enforced before selection: simple is 5-10 minutes and two to
three paths; medium is 20-30 minutes and two to six paths; challenging is 30-45
minutes and two to ten paths. Every candidate path must be one of the excerpted
tracked paths, and direct evidence must cite an excerpt path and line. The
ranked IDs must be unique and equal the candidate-ID set. The first ranked
candidate with a genuine RED proof becomes selected. The reproduce prompt lists
the exact allowed paths. After required skill and context setup, the turn
inspects only those paths before editing; if they disprove the premise, it
stops immediately with no changes so the existing typed no-change rejection can
restore evidence and advance. It does not search for a replacement candidate.
Any gather failure,
worktree change, model tool event, timeout, invalid citation, incomplete
ranking, off-packet path, or insufficient evidence fails the run before
reproduction. A model tool event is a no-tool failure and cancels the scout
conversation.

An internal runtime guard races every asynchronous gather operation against the
same absolute gather deadline. A second guard drains conversation events
concurrently with the outcome and cancels on either normalized tool event.
Behavior tests use delayed fake operations and fake conversations so deadline
and cancellation ordering cannot pass through source-text checks alone.

Synthesis has at most 80 seconds total. Each attempt creates a fresh
conversation and receives at most 40 seconds. A Codex scout request sets
`reasoningEffort: "low"`; other Codex stages retain their selected/default
configuration. The workflow retries only when
the first attempt returns the exact cancellation reason generated by its own
timeout label and limit; tool use, malformed output, backend failure, another
cancellation reason, or any other first outcome is final. A second timeout is
also final. The report records each attempt's label, limit, duration, outcome
type, and exact-timeout classification. Ten seconds remain after synthesis for
validation and reserve.

Every timer-based helper uses an absolute completion timestamp; timer callback
arrival is only a wakeup and never proof of timely completion. `awaitBounded`
records terminal settlement time. If the outcome has already settled at or
after its active deadline, it becomes an owned timeout without a redundant
cancel. If it is still pending when the active deadline expires, the helper
cancels once and awaits terminal settlement within its reserved bound. Overdue
settlement is still timeout evidence, and terminal usage plus normalized
success, failure, or cancellation evidence remains JSON-safe.

The scout's one-time retry snapshots the total remainder once, reserves
settlement within that snapshot, and retries only the first exact owned timeout
while positive retry time remains. It never retries an unrelated cancellation,
a second timeout, or any terminal outcome at or after total expiry. Codex,
Claude stream-json, and Pi subprocess cancellation plus their shared internal
watchdogs use bounded SIGTERM-to-SIGKILL escalation and do not settle until the
child exits; a termination failure rejects the stage instead of leaving it
pending. This runtime comparison does not authorize those other backends for
this proof. OpenCode's managed-server terminal shutdown is not covered and
remains deferred source-runtime work.

`awaitWithinDeadline` applies the same rule to ordinary operations: late
success, late rejection, and exact-deadline equality all become deadline
failure before a caller can retain evidence. Manifest metadata, link, stream,
hash, and comparison operations use that same absolute-completion boundary.

### 3. Ranked Reproduce

Attempt candidates in validated rank order under one shared reproduce budget.
Rank one uses `selectedControl`; a later rank obtains its control lazily through
a tool-free structured turn limited to 10 seconds and the remaining reproduce
budget. The returned control must name that exact candidate. No later control
turn starts unless the preceding rank was rejected for a typed invalid proof.

Before each attempt, require the candidate's scout-selected, pre-existing
top-level control test to import its bound allowed production path, call that
production code, and assert the returned value through a reachable allowlisted
terminal Bun matcher. An unconditional `return` or `throw` before the causal
matcher makes it unreachable, and ambiguous control flow before that matcher
fails closed. Run the exact filtered control on the untouched baseline and
capture the complete test source's AST-backed SHA-256 fingerprint. Decode
baseline and candidate source as fatal UTF-8 while retaining any BOM; malformed
source fails closed. Also capture the test path's raw bytes and SHA-256 plus exact
`git status --porcelain=v1 --untracked-files=all` and complete
`git diff --no-ext-diff --binary HEAD --`. Run one write-enabled Codex turn with
the reproduction directive. It may change only `testPath`. When a backend emits
normalized file-change events, the stage tracks the
`assistant_tool_call(name="file_change")` ID for `testPath` and records an
applied edit only after its successful matching `tool_result`. It continues
draining events and always awaits the terminal outcome so later backend failure
and usage remain observable. An off-target file-change call requests
cancellation, waits for terminal settlement, then fails the attempt. A failed
or unmatched result cannot prove an applied edit. Event evidence has three
states: `none`, `unconfirmed`, and `applied`. The reusable guard preserves
terminal-only behavior by letting `none` defer proof to exactly one expected
Git path plus a non-empty diff; this does not make another backend selectable.
`unconfirmed` rejects a started, mismatched, or failed normalized call;
`applied` records a successful matching result. Both `none` and `applied` still
require the deterministic Git proof. The failed-proof guard directly throws a
typed `no-change` rejection whose evidence says confirmed change evidence is
missing; contracts bind both the condition and its throw body.

The turn adds only the target regression and must preserve the existing named
control and source fingerprint. Candidate source must equal the baseline raw
bytes plus one exact contiguous insertion whose parsed extent is the added
top-level test. Any other byte change or inserted disabling directive token
fails closed. The parent then requires exactly one changed path equal to
`testPath` and a non-empty diff. It reruns the exact filtered
control, requiring exit zero, exactly one matching passing line, no skip or
todo line, and Bun's canonical `1 pass`, `0 fail`, one-test/one-file summary.
AST taint carries both the allowed production path and exported entrypoint
through named, aliased, default, and namespace imports plus lexical symbol
identity for local result bindings. Shadowing declarations and untainted
reassignments clear an outer origin. The added RED assertion must resolve to
the same exported entrypoint as the control. A different export from the same
allowed production file fails before the target command can authorize RED. The
assertion must end in an allowlisted built-in Bun matcher after only `not`,
`resolves`, or `rejects` property modifiers. Called modifiers and unknown
terminal or intermediate properties fail closed.
Only then does it run the statically identified added RED test under its
anchored exact-name selector and require a non-zero result with exactly one Bun
`(fail)` record for that name plus the canonical one-test failing summary. The
name must contain the exact `ORCA_RED:<candidate-id>` token; a longer marker with
that prefix does not match.

Only these invalid-proof results permit fallback: failed, skipped, or
miscounted control; passing target; wrong target failure pattern; no net change;
or empty diff. A timeout marker or `exitCode: null` is an operational failure,
not an invalid proof. Backend, scope, persistence, budget, and restoration
failures also stop immediately.

For every rejected rank, retain the candidate, control, reason, attempted diff,
candidate-local command logs, rank, snapshot hash, baseline status, and baseline
binary diff in both the run report and a candidate artifact. Restore the raw
test bytes byte-for-byte before the next rank, then require the restored hash,
exact status, and complete binary diff to equal the snapshot. Restoration
evidence is added to the artifact. All attempts, lazy controls, evidence writes,
and restoration share the original reproduce budget. Every rejected-artifact
write asserts a positive remainder immediately before and after persistence.
Contracts bind those assertions to the containing write rather than accepting
global count or source-order evidence.

Only both deterministic gates make RED valid. Save the immutable RED diff, then
check the shared budget again before accepting the rank. Event completion does
not replace either gate, and persistence cannot turn an over-budget proof into
an accepted candidate.

### 4. Select and Plan

After genuine RED acceptance, publish the hydrated candidate and accepted
control. Persist all seeds, the full ranking, original rank-one control,
accepted control, rejected-attempt evidence, and selected candidate to
`.orca/improvement-loop/plan.json`. No candidate is selected merely because it
was rank one.

### 5. Implement

Run one write-enabled Codex turn with the implementation directive. The prompt
contains the selected problem, evidence, allowed production paths, immutable
test diff, and implementation brief. It forbids commit, push, pull-request,
merge, dependency, and off-target edits. After the turn, the workflow confirms
the test diff is byte-identical to the saved red state.

### 6. Targeted Repair Loop

Evaluate the selected targeted test and `bun run lint`. A `fixLoop` invokes the
repair directive only when a gate fails. It allows at most one targeted repair,
stops repeated failure signatures as `stuck`, and stops when the 10-minute run
deadline cannot accommodate delivery. After every repair, the workflow confirms
the saved red-state test diff remains byte-identical.

### 7. Independent Review

Run one read-only structured Codex review against the diff. Findings include
severity, evidence, recommendation, and `fixable`. High or critical findings
enter one bounded repair turn, followed by targeted test, lint, and one repeated
review. Any remaining blocker prevents delivery.

Review repair is subject to the same immutable-test check. The workflow repeats
that check immediately before final verification and immediately before commit.

### 8. Final Verification

Run `bun run verify` once. Then enforce:

- exactly two to three changed paths;
- every changed path is in `allowedPaths`;
- the selected test path changed;
- no lockfile, dependency manifest, release file, workflow artifact, or secret
  path changed;
- the worktree contains no untracked off-target path.

### 9. Delivery

Capture the pre-commit HEAD and require it to equal the fetched base SHA. Stage
only validated changed paths and commit with a conventional message derived
from the selected title. Require the commit to have exactly that single parent
and require the complete base-to-head range to contain exactly the validated
paths. Recheck branch and origin URLs, then push. Write the pull-request body to
a file and pass it to `gh pr create --body-file`. Open a ready-for-review pull
request against `main`. Every head check reads `headRefOid`, `isDraft`, and
`baseRefName`; a draft or non-`main` pull request fails before checks or merge.

Poll the pull request's check rollup until the expected `Verify` check from the
`CI` workflow is present and every reported check has conclusion `pass`, a check fails, or
the delivery budget expires. Zero reported checks never authorizes merge.
Immediately after pull-request creation, the exact GitHub CLI exit-1
`no checks reported` result is an empty pending rollup and is polled again;
authentication, API, timeout, malformed-output, and other failures remain fatal.
The polling stage returns typed passing evidence bound to the validated SHA;
require it immediately before merge. Squash-merge with
`--match-head-commit <sha>`. Confirm and retain the final query command plus
`state=MERGED`, unchanged `headRefOid`, `isDraft=false`, and
`baseRefName=main`, then print the pull-request URL.

## Progress and Evidence

`WorkflowMonitor` owns these stages:

```text
preflight
scout
scout attempt 1 [or scout attempt 2 after exact timeout]
reproduce
fallback control <candidate-id> [later ranks only]
red-gate [once per attempted rank]
select-plan
implement
targeted-repair
review
review-repair
verify
commit-push
pull-request
remote-checks
merge
```

Each stage prints start, completion, and elapsed time through Orcats run output.
The final monitoring JSON records stage duration, outcomes, repair iterations,
validation evidence, and token usage when reported. A separate run report JSON
records the profile, evidence paths/count/digest and command logs, latest commit
evidence, candidate seeds, ranking, `selectedControl`, rejected attempts,
`acceptedControl`, hydrated selected candidate, exact rendered per-turn system
prompts, red-state artifact, review completion evidence, locally validated head
SHA, pull request URL, merge state, total duration, and SLA verdict. Each
rejected artifact remains available after launcher collection. Unit tests prove
rendered directives are passed as backend request configuration rather than
only stored as metadata.

The main agent runs the artifact through `orcats-flow`, polls real output rather
than wall-clock alone, and reports each significant stage transition to the
user. No-progress beyond the runtime watchdog is classified from monitor,
worktree, plan, and Git evidence.

## Timing

Timing profiles measure launcher start through confirmed merge:

| Profile | Expected range | Hard ceiling | Maximum changed paths |
|---|---:|---:|---:|
| simple | 5-10 minutes | 10 minutes | 3 |
| medium | 20-30 minutes | 30 minutes | 6 |
| challenging | 30-45 minutes | 45 minutes | 10 |

A faster correct run passes. The first live acceptance uses `simple`. Its hard
allocations total 560 seconds, leaving 40 seconds for launcher and reporting:

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

The 100-second scout allocation is subdivided into at most 10 seconds for
deterministic gathering, at most 80 seconds total for tool-free structured
synthesis, and 10 seconds for validation and reserve. Synthesis uses at most two
fresh conversations limited to 40 seconds each and retries only the first
attempt's exact timeout cancellation. The split does not change the 560-second
allocation or 600-second launcher-to-merge ceiling.

The 65-second reproduce allocation is one absolute budget across every ranked
attempt, lazy fallback-control turn, parent gate, rejected-artifact write, exact
restoration, and RED persistence. Each rejected-artifact write checks the
budget on both sides of persistence; acceptance rechecks it after the RED
artifact is saved.

Stage allocations count active work. Switching from targeted repair to review
pauses the repairs allocation; a blocker repair pauses review, and the repeated
review resumes its prior review remainder. Inactive repair and review time does
not consume the other 65-second allocation. Every remainder is still capped by
the launcher-wide profile deadline.

Every post-turn test-diff and changed-path query requires the current stage
remainder. Each serial Git command recomputes the minimum of active-stage and
launcher-wide time, so a helper's internal 30-second command cap cannot reset a
spent budget.

The workflow checks the selected profile deadline before every new stage. A
stage conversation is cancelled at its own profile-scaled limit. Crossing the
deadline is a failed run even if local code is correct; the workflow records an
`sla-overrun` issue and does not merge.

## Proof Integrity

`expectedFailurePattern` must equal `ORCA_RED:<candidate-id>` and is a literal,
not a regular expression. Scout and hydrated candidate validation reject every
generic or mismatched marker. The statically identified test name must contain
that exact case-sensitive token. The escaped exact-name selector and one exact
Bun `(fail)` record bind runtime evidence to the same name; metacharacters carry
no special meaning, and marker-token boundaries reject prefix collisions.

Git ignores the workflow controls and retained evidence under `.orca`, so normal
scope checks cannot protect them. Each workspace-writing agent node captures a
sorted path, mode, and content-hash manifest before work and compares it again
in a guaranteed post-operation check. This applies to baseline repair,
reproduction, implementation, targeted repair, and review repair, including
failed agent outcomes. Parent-owned evidence writes occur outside those guards.
Capture is bounded to 1,024 entries, 256 KiB of UTF-8 path data, and 16 MiB of
content. The active stage deadline bounds metadata, symbolic-link, and stream
reads by absolute completion time. Manifest operations reject late success,
late rejection, and exact-deadline equality before comparison or evidence
commit. Symbolic links hash their link text, not target-file contents. Addition,
deletion, byte, mode, and link-target changes all alter the manifest.

Full verification freezes a candidate manifest containing every validated
path's Git mode and object ID. Delivery recaptures and compares the worktree
before staging, the index after staging, and the commit tree after commit. Any
content, mode, path, addition, or deletion mismatch stops delivery. Push is
ordered after the committed-tree comparison, so the remote branch can contain
only the bytes that passed full verification.
Worktree symbolic links use the Git blob hash of their raw link text under the
repository's SHA-1 or SHA-256 object format. Index and commit parsing requires
one trailing NUL, exact blob modes, stage zero, and exactly 40- or 64-character
object IDs. One bytewise comparator owns every path-set check. After commit,
the full parent-to-head `git diff --name-only -z <parent SHA> <head SHA> --` path
query must equal the validated set, so a commit hook cannot add an unverified
file before push.

Before any launcher side effect, the source ledger must exist, contain at least
one line, preserve the exact historical seed, and parse as exactly one JSON
object per non-empty line. Every row must include typed, nonblank identity,
time, classification, stage, evidence, elapsed-time, and allowed-status fields;
optional context fields must be strings when present. Missing, empty,
malformed, multi-value, altered-seed, or schema-invalid input exits `65`;
validation never repairs or rewrites the source ledger.

Ledger merge binds the complete byte-for-byte captured base, not only the seed.
Mutation, deletion, and reordering are exercised independently against source
and candidate ledgers. Every case exits `65`, preserves source bytes, releases
the atomic lock, and removes its temporary merge file. Mutation contracts reject
a seed-only comparator and removal of either source or candidate prefix guard.

Lock acquisition uses directory creation plus one unique
`owner.<pid>.<nonce>` regular-file marker. The directory must contain exactly
that marker, its PID must be the current live process, and its path must match
the caller's captured marker before ownership is accepted. Every acquisition or
recovery loop begins with the shared absolute-deadline check. An empty directory
may be removed with `rmdir`; one exact dead-owner marker may be removed and then
the directory removed with `rmdir`. A symbolic-link lock directory,
symbolic-link entry, live owner, malformed state, or multiple entries are never
recovered and fail closed when the bounded loop expires. The main lock
directory is never renamed or recursively deleted. Normal release and
`TERM`, `INT`, or `HUP` cleanup remove only the caller's exact marker and merge
temporaries. Stale-recovery and release replacement races prove that a successor
owner and marker survive.

Primary package-lock protection binds both initial existence and SHA-256 through
final launcher settlement. Six finalizer cases prove that an unchanged existing
lock succeeds; changed, deleted, newly appeared, and different-byte recreation
fail; and identical-byte recreation succeeds. Every case asserts final existence
and hash, while the real primary lock is restored to its pre-test state.

After the source ledger validates, the full finalizer trap is installed before
the launcher snapshots the ledger or invalidates prior evidence. Preflight mode
atomically moves any stable `preflight.json`, then `latest.json`, into
run-unique same-directory quarantines. Each invalidation attempts both paths
even when one rename fails. Finalizer and signal paths repeat the same
idempotent invalidation. Live validation binds the claimed preflight to the
quarantined successful latest document, so a stable attestation left by a
failed rename is still unclaimable.

The finalizer renders successful preflight and latest evidence only into
run-unique private stages. After final deadline calculation, it repeats the
package-lock existence-and-SHA comparison, then prints diagnostics while both
success documents remain private. `latest.json` receives one immediate positive
deadline decision before its atomic rename. Claimable preflight receives a
second fresh positive decision immediately before its rename. The launcher
records signals while a publication commit is active. In preflight mode,
authority transfers only after the final rename returns and no pending signal
requires retraction. In live mode, latest publication is not a commit point: a
recorded signal before the canonical ledger rename aborts with the signal
status. A failed preflight decision or rename atomically moves stable
latest back to private staging before failure evidence is rendered. If that
retraction fails after the deadline prevents normal rendering, an atomic
same-directory failure tombstone replaces the success-shaped latest document.
If a signal is observed before preflight ownership transfers while canonical
quarantines and reused private fallbacks are occupied, cleanup clears or
reallocates fresh current-run same-directory paths, retries retraction, and
verifies canonical preflight and latest success absent.
Changed, disappeared, or newly appeared package-lock state forces exit `74`,
clears an absent after-hash, and publishes only failure-shaped latest evidence.
No fallible cleanup follows preflight authority transfer. An arbitrary external
mutation afterward is outside the launcher's guarantee; the parent post-run
hash comparison verifies state after the launcher process returns.

Workflow finalization has three ordered phases: run shutdown once, run the issue
ledger and fresh monitor snapshot as retryable artifacts, then run exactly one
terminal report. Every action receives a fresh shared absolute remainder, an
abort signal, its attempt number, and a generation-current predicate. It races
asynchronous work against that remainder. Non-publication actions check the
absolute remainder again after completion, so same-thread work that delayed the
timer still fails. Expiry aborts and invalidates the attempt. Late settlement
may finish privately but cannot publish over a retry.

Ledger, monitor, and report publication uses an explicit commit point. The
publisher writes a run-and-attempt-unique temporary file in the destination
directory, then captures exactly one authentic positive commit decision from
the context immediately after that write and immediately before atomic rename.
The issue, monitor, or report action returns that exact decision. The wrapper
treats it as terminal and does not apply a later clock read that could
reinterpret an already committed atomic publication. On pre-publication
failure, cleanup removes only that attempt's temporary file, preserves the
publication error as primary, and attaches any cleanup failure as secondary.
After rename, the publisher returns immediately with no cleanup or other
fallible work. Contracts reject a commit before the temporary write, relocated
away from the immediate pre-rename position, after rename, forged by the action,
requested twice, or followed by fallible cleanup. The terminal report
recomputes finish time, elapsed time, and SLA before its commit point. It is not
retryable and cannot persist `sla: "passed"` after the deadline.

## Failure Handling

Every failure writes one JSON line containing run ID, timestamp, stage,
classification, elapsed time, command or backend, normalized error, worktree,
branch, monitor path, and pull-request URL when one exists.
New rows always bind `backend`, `worktree`, `branch`, and `monitorPath`, plus
`prUrl` once known. Historical append-only rows may omit those later-added
context keys and are not rewritten.
The workflow never resolves historical issues. It may append one failure row,
then publishes its candidate ledger, monitor, and terminal report. Only the
launcher can close issues after all live proof exists. It stages a canonical
ledger in deterministic ID order, overlays every latest-open row with the
current backend, worktree, branch, monitor path, and merged pull-request URL,
and appends one terminal record bound to the candidate-ledger, monitor, report,
and cycle-free latest-projection hashes. Stable run-local issue evidence remains
the candidate ledger until canonical commit. Under the lock, any concurrent
source suffix blocks success. The launcher freshly rehashes the candidate and
staged ledgers, report, monitor, and latest projection; verifies latest's
embedded ledger, projection, and proof claims; and requires a valid zero-open
canonical ledger immediately before its atomic rename. That rename is the live
commit point. `latest.json` cannot authorize success by itself, a pre-rename
signal aborts, and post-rename interruption recovers only through the exact
terminal record, projection and claims, and final-ledger hash. Failed runs
discard provisional resolved rows and
merge only each candidate ID's latest-open suffix row. Terminal staging applies
the same candidate filter before launcher-owned resolution, so candidate-authored
resolution cannot supersede a base-open row. At least one nonzero backend usage
counter must be recorded. Runtime shutdown runs once; retryable ledger and
monitor publications precede one terminal report. Runtime and launcher
finalization finish before the terminal ledger commit.
The branch binding is initialized from the launcher before any operation that
can fail, then checked against Git rather than overwritten from Git output.

The ledger begins with the prior `feature-implementation-timeout` run as the
first issue. The new staged workflow is its corrective iteration. Any new issue
found by authoring or running this workflow must receive a linked correction
entry and another bounded run before completion; a first-pass success does not
invent a synthetic failure merely to force another run.

Classifications are `environment`, `baseline`, `backend`, `gate`, `review`,
`scope`, `remote-check`, `merge`, and `sla-overrun`. Recovery is bounded to the
repair loops above. A failed or timed-out remote check does not trigger a merge.
No recovery path performs a destructive Git operation.

A typed invalid reproduction proof is candidate-local evidence, not a workflow
failure when a later rank succeeds. It is retained before exact restoration.
Exhausting all ranks or encountering an operational error fails the workflow
and receives the normal ledger entry.

## Verification Strategy

The 300-test focused result and successor digest beginning `3eb`, plus frozen
digest
`e28a8885678089f1009b75829fa470ca03ba05f7fb4df0e18d901824d7b78530`
at 319 focused tests and 1,775 assertions, are invalidated historical
checkpoints. The frozen audit exposed ledger-prefix and package-lock behavioral
coverage gaps. A later correction reached 327 focused tests and 1,963
assertions. The terminal-publication and symlink-lock corrections reached 328
focused tests and 1,984 assertions plus full deterministic verification, but a
post-checkpoint audit invalidated that result. The stale-invalidation,
commit-boundary, and stable-latest cleanup correction reached 331 focused tests
and 2,013 assertions before a pre-lock audit invalidated its fault hooks. The
subsequent 331-test, 2,016-assertion checkpoint was invalidated by the
terminal-ledger protocol audit. Its successor reached 340 focused tests and
2,061 assertions, but the final pre-lock audit invalidated that checkpoint by
finding candidate resolution authority, dirty runtime provenance, and one weak
required-command mutant. Behavioral regressions now cover launcher-owned
resolution and a clean committed runtime build; the mutant now swallows a real
failure into synthetic success. The corrected checkpoint passes 342 focused
tests with 2,086 assertions. Flow typecheck, exact launcher ledger validation,
lint, documentation link, symbol, signature, shell, diff, and full verification
pass; full verification records 461 passes, one gated skip, and 1,317
assertions. Final proving audits invalidated those bytes by finding cached
pre-merge CI, replace-ref-sensitive runtime archives, signal-status collapse,
and single-ID terminal-closure coverage. Correction 19 repolls and persists
current all-pass checks immediately before an unchanged-head recheck, disables
replacement objects for the runtime archive, preserves signal-specific exits,
and proves two open IDs close. The corrected checkpoint passes 342 focused tests
with 2,103 assertions; full deterministic verification records 461 passes, one
gated skip, and 1,317 assertions. Resumed bounded audits invalidated that
checkpoint: the final child wait could overwrite a recorded signal, monitor
selection trusted filesystem order, and an unprotected GitHub merge could race
the last client-side check poll. Correction 20 gives recorded signals precedence
after child reaping, accepts only one identity-matched successful terminal
monitor, and requires strict admin-enforced `Verify` branch protection from
workflow `CI` before the final poll and SHA-locked merge. Fresh deterministic
verification, a new digest, three zero-finding audits, preflight, and the
authorized live run remain pending.

Correction 21 closes the terminal-binding audit. The canonical commit rehashes
all bound files and the cycle-free latest projection while holding the ledger
lock, validates latest's embedded claims separately, and leaves stable run-local
issues candidate-only until the canonical rename. Mutation and interruption
tests cover every bound artifact and recovery claim. The corrected checkpoint
passes 348 focused tests with 2,176 assertions; full deterministic verification
records 461 passes, one gated skip, and 1,317 assertions.

Correction 22 closes the final protection and terminal-worker audit. GitHub's
required check context is `Verify`; workflow name `CI` remains separate
metadata. Preflight validates strict administrator-enforced protection as its
first gate, and live mode repeats that validation before consuming the
attestation. A terminal ledger worker cannot begin after a recorded signal,
and failed terminal publication removes its provisional success-shaped ledger.
The corrected checkpoint passes 352 focused tests with 2,208 assertions. Full
deterministic verification records 461 passes, one gated skip, and 1,317
assertions.

Correction 23 closes the protected-check source-identity gap. Context `Verify`
alone did not prove which producer could satisfy the server rule. Both
validators now require its branch-protection check entry to carry GitHub Actions
app ID `15368`, rejecting missing, unrestricted, and wrong-app entries.

Correction 24 closes loaded-host test nondeterminism. Two process-heavy launcher
harnesses passed in isolation but exceeded test-only scheduling caps in exact
suite runs. Wider success-path and Bun test timeouts preserve every assertion
and production deadline while removing host-load false negatives.
The corrected checkpoint passes 352 focused tests with 2,215 assertions. Full
deterministic verification records 461 passes, one gated skip, and 1,317
assertions.

Correction 25 closes a terminal-worker PID-capture race. The worker child waits
behind a start file until the parent captures its PID and rechecks signals, then
publishes an acknowledgement and waits for the parent to remove it before the
command can execute. Signal paths terminate the tracked child and clean only
those exact handshake files. The preflight protection-order test now rejects
missing calls before comparing positions and proves a protection-call deletion
mutant; the final-wait harness injects its signal at the actual terminal wait.
The corrected runtime and test checkpoint passes 353 focused tests with 2,227
assertions, and two append-only audit rows bring the locked ledger to 82 rows.

Correction 26 closes bounded-capture signal deferral, terminal-stage cleanup,
and latent merge recovery. Shell behavioral RED produced six expected failures
plus one unrelated loaded-host timeout. It proved that command substitution
could defer the parent signal trap, and that signal or deadline paths after
terminal staging could leave success-shaped evidence. All 24 bounded output
captures now run through `capture_before_deadline` in the main shell. Signal,
timeout, and finalizer cleanup remove terminal staging before prior-evidence
invalidation.

The merge behavioral RED was 0/1: `Expected []`; `Received ["merge must persist
its command result and confirm exact merged state even after a failed
response"]`. Merge now records its exact SHA-locked `CommandLog` regardless of
result and always runs bounded authoritative confirmation. Latent success is
accepted only for the exact pull request URL and repository, base `main`, head
ref, head SHA, non-draft state, and `MERGED`. Failed confirmation after a
successful command surfaces that failure; dual failure preserves both errors
in an `AggregateError`.

The Correction 26 checkpoint passes 363 focused tests with 2,353 assertions.
The ledger preserves the exact 82-row prefix with SHA-256
`ed4306a940db3275dec36e3bd91e61e7a942bdecd1f57d46f351aa7f934f91ec`;
three append-only open rows bring it to 85 unique rows. Correction 25's
353-test, 2,227-assertion, 82-row checkpoint remains historical. Full
deterministic verification passes 461 tests with one gated skip, zero failures,
and 1,317 assertions. The prior fourteen-artifact digest is recorded only as
abbreviated `d603...4e60`; it is invalid and non-reconstructable, and missing
hexadecimal characters must not be invented.

Correction 27 closes two terminal-audit races. Active-child deadline polling
ran `bun` in command substitution, so a stalled clock deferred TERM for 2,174
milliseconds against a 1,500-millisecond bound. Preflight set terminal ownership
before either rename; TERM immediately before first publication was recorded but
success still exited `0` instead of `143`.

Launcher remainder checks now use Bash's built-in `SECONDS` counter and assign
directly in the main shell. Finalizer clock reads use bounded main-shell capture,
for 26 bounded captures total. Signals retain cleanup authority through latest
publication. Live transfers terminal ownership only before canonical ledger
commit; preflight transfers only after the final rename returns.

The corrected checkpoint passes 365 focused tests with 2,367 assertions. The
ledger preserves its exact 85-row prefix with SHA-256
`6478fc33be4155396e3cd2aaa3355016b5c3107706580f4bcb90a3da8a4c0418`;
two append-only open rows bring it to 87 unique rows. Full deterministic
verification passes 461 tests with one gated skip, zero failures, and 1,317
assertions. Digest
`b039dd863b146132233239d1003bb3f41f48f336b5160b2bc270169bbe7afc77`
is invalid.

Correction 28 closes a semantic control gap and one loaded-host test race.
Production taint previously retained only the allowed file path, so the control
could call one export while RED called another export from the same file.
Taint now carries the production path and exported entrypoint through direct,
aliased, default, and namespace imports plus local result bindings. The RED
assertion must match the control origin. The reproduce prompt states the same
constraint, and behavioral tests reject named and namespace mismatches while
accepting two aliases of one export.

The concurrent same-ID ledger conflict harness no longer assumes the parent
resumes inside 100 milliseconds. A bounded marker handshake pauses the child
after its base snapshot and releases it only after the concurrent suffix is
written; the isolated regression passes five consecutive runs.

The corrected checkpoint passes 366 focused tests with 2,377 assertions. The
ledger preserves its exact 87-row prefix with SHA-256
`d1580b5f595fbbbf4325d08aee3afcce15f2a4a9fb19c4c1714673c3e06587ad`;
two append-only open rows bring it to 89 unique rows. Full deterministic
verification passes 461 tests with one gated skip, zero failures, and 1,317
assertions. Digest
`89a9381f4734052151a3329d56fce2c96d2a0b6518123e9ae303e4a05890e0d8`
is invalid.

Correction 29 invalidates fourteen-artifact digest
`9c3824b40178183c2af42ea068063412d896f6f4ec5caa78faf07cc23da3dc24`.
The three findings remain open in the append-only ledger until a merged proving
run resolves them. Local repairs now bind production taint to lexical symbols,
require one exact raw RED insertion while rejecting disabling directive comment
tokens, and reallocate fresh signal-retraction paths when canonical quarantines
and reused private fallbacks are occupied. Signal cleanup retries and verifies
canonical preflight and latest success absent. The ledger preserves its exact
89-row prefix with SHA-256
`e897a979014f817046b766f9063e7021dceab6181e335cb9339aca3b466f3a32`;
three append-only open rows bring it to 92 unique rows. A successor digest,
three zero-finding audits, preflight, and live run remain pending.

Correction 30 invalidates fourteen-artifact digest
`be08eb2843d4163f22d76edfa0617e7f7a98b34063f86afaa507f1c70ffe179a`.
RED validation accepted a called modifier or unknown property as matcher
evidence, and the bounded launcher accepted a successful group leader while a
background descendant remained. Local repairs require one allowlisted terminal
Bun matcher after only recognized property modifiers, and require an empty
process group before any bounded command can succeed. The ledger preserves its
exact 92-row prefix with SHA-256
`3c2e9579ff986a29c35a5038548b28e635a94f57606d17c28bcfcbf5a8daa013`;
two append-only open rows bring it to 94 unique rows. A successor digest, three
zero-finding audits, preflight, and the one authorized live run remain pending.
The deterministic checkpoint passes 373 focused tests with 2,447 assertions;
flow typecheck, exact ledger validation, Bash syntax, documentation links,
diff checks, and full repository verification pass. Full verification records
461 passes, one gated skip, zero failures, and 1,317 assertions.

Correction 31 invalidates fourteen-artifact digest
`c6749dcf831c1070755e602a57baf97e8f628e11284abda53cd0359f54e4d2d4`.
Positive-control validation accepted an unrelated matcher, RED provenance
accepted a marker from an unrelated failure, source decoding stripped a UTF-8
BOM, and a detached `setsid()` descendant escaped process-group cleanup. Local
repairs require a production-bound causal matcher, the exact marker on the
target's own `(fail)` record, fatal UTF-8 decoding with BOM retention, and
owner-token cleanup across groups and sessions. The ledger preserves its exact
94-row prefix with SHA-256
`6ba0aaa3319134b5f8b1261806adb68b2f782ac17c433e6221d7496660fc4b4d`;
four append-only open rows bring it to 98 unique rows with SHA-256
`89742959183b13b09b9ff6fb9e9fdb519aa5e83f2ac7e40e91983daf5de46fdd`.

Correction 32 rejects a causal matcher after unconditional `return` or `throw`
and fails closed on ambiguous control flow before it. Exact marker-token
matching rejects RED prefix collisions. Unrelated finalizer harnesses use an
isolated empty owner scan while dedicated process tests retain real inspection
coverage. Production owner enumeration streams through a pipefail-protected
filter and persists matched PID lines only. The ledger preserves its exact
98-row prefix and four append-only open rows bring it to 102 unique rows with
SHA-256
`021909608578d7519d5c6c3381967cca3f74d14efc4a1256a8416ad158b82ed8`.
The deterministic checkpoint passes 384 focused tests with 2,496 assertions;
a new digest, three zero-finding audits, preflight, and the one authorized live
run remain pending.

Correction 33 makes semantic proof symmetric and binds static RED identity to
runtime evidence. Label-scoped exits propagate to the matching target, while
optional calls and indexes fail closed. Positive-control and RED analysis now
share causal matcher, production-origin, reachability, and evaluated-side-effect
rules. Exact provenance survives pure aliases and uninvoked closures, but not
nested evaluated writes, invoked local behavior, or later production calls with
arguments other than recursively proven primitives. Matcher expected arguments
must be passive and independent of the received value; `toSatisfy` is rejected.
Named and namespace production origins survive non-optional `await`.

The candidate marker must be absent from baseline source. Semantic evidence
returns the exact single added test's nonempty static name. RED uses one anchored
and escaped exact-name selector, one exact matching `(fail)` reporter record,
and one unique canonical Bun summary proving zero passes, one failure, nonzero
expectation calls, one test, and one file. Duplicate or contradictory summary
fields fail closed. Only the added RED test name receives control-character
hardening in this correction; control-name hardening remains out of scope. The
ledger preserves its exact 102-row prefix with SHA-256
`021909608578d7519d5c6c3381967cca3f74d14efc4a1256a8416ad158b82ed8`;
eleven append-only open rows bring it to 113 unique rows with SHA-256
`d5afe4695fb80f65984ca311c01f566b3a6b2589e5e6d5c44735dd66aa78f547`.
Fresh local evidence covers all four focused suites at 406 tests and 2,663
assertions: 84 library, 157 runtime, 82 contract, and 83 artifact tests. Flow
typecheck also passes. Full deterministic verification passes 461 tests with
one gated skip, zero failures, and 1,317 assertions. A new digest, three
zero-finding audits, preflight, and the authorized live run remain pending.

Correction 34 requires bound matcher arguments to resolve recursively to a
primitive. A const alias cannot make an effectful or aggregate initializer
passive. The reproduction prompt now runs the same filtered control and exact
named RED commands that the parent validates. The exact 113-row ledger prefix
has SHA-256
`d5afe4695fb80f65984ca311c01f566b3a6b2589e5e6d5c44735dd66aa78f547`;
two open rows bring it to 115 unique rows with SHA-256
`20fad41c836b40974ae56fc52ea5dbe8b5833d1a4aebf971f15e72e2b38e70a5`.

Correction 35 rejects mutable const matcher containers and removes
prototype-dependent `toBeOneOf` from the causal allowlist. Inline passive
object literals inspect values rather than identifier keys; unshadowed global
`undefined` remains a primitive. The exact 115-row prefix has SHA-256
`20fad41c836b40974ae56fc52ea5dbe8b5833d1a4aebf971f15e72e2b38e70a5`;
three open rows bring it to 118 unique rows with SHA-256
`aaf71fc52c3c038cd44cf56de00624383d70effbaa3943252ee69371f1e5ee28`.

Correction 36 closes globally reachable Bun matcher mutation. A deadline-bound
preload disables `expect.extend`, freezes `expect.prototype` and `expect`, and
is byte-verified immediately after the reproduce budget starts. Both controls,
the exact named RED command, and post-fix targeted GREEN receive that preload.
Static analysis validates matcher semantics before expect integrity, then
rejects aliases, extensions, escaped assertion objects, and prototype writes.
The exact 118-row prefix has SHA-256
`aaf71fc52c3c038cd44cf56de00624383d70effbaa3943252ee69371f1e5ee28`;
one open row brings it to 119 unique rows with SHA-256
`bd6ea5690024400877747e9cd2b558014f5143d722005eee7717deb711a1af5f`.
All four focused suites pass at 417 tests and 2,715 assertions: 84 library with
323 assertions, 167 runtime with 682, 83 contract with 704, and 83 artifact
with 1,006. Flow typecheck passes. Full deterministic verification, a new
digest, three zero-finding audits, preflight, and the authorized live run remain
pending.

Correction 37 traces transitive named proof wrappers from `matcherProofArgs` to
runtime call sites. Direct, aliased, and hoisted pre-install execution plus
indirect wrapper references fail, while a safely hoisted post-install wrapper
remains valid. The exact 119-row prefix has SHA-256
`bd6ea5690024400877747e9cd2b558014f5143d722005eee7717deb711a1af5f`;
one open row brings it to 120 unique rows with SHA-256
`625e7d8935d663c872a49056f5ad849a4052143fb5663617ec9a82edd92d35a2`.

Correction 38 resolves proof-wrapper closure by TypeScript binding identity and
compares preload installation with reachable named-wrapper invocation order,
not declaration position. Shadowed same-name bindings and safely hoisted
declarations remain valid; direct, alias, and transitive pre-install mutants
still fail. The exact 120-row prefix has SHA-256
`625e7d8935d663c872a49056f5ad849a4052143fb5663617ec9a82edd92d35a2`;
two open rows bring it to 122 unique rows with SHA-256
`189403f518f525ea4f16eecc56e338d828960f25796643e0e875bfbd5df9706e`.
Focused matcher tests and flow typecheck pass. The full artifact suite exposed
the Correction 39 harness-timeout gap.

Correction 39 gives the five-case fresh-preflight integration harness a
15-second test timeout instead of Bun's five-second default. This changes only
the deterministic test harness; launcher, preflight, stage, and 600-second live
deadlines remain unchanged. The exact 122-row prefix has SHA-256
`189403f518f525ea4f16eecc56e338d828960f25796643e0e875bfbd5df9706e`;
one open row brings it to 123 unique rows with SHA-256
`71e942097fd6ec015bb6a4d267144048f39705f5a2e89496bde57bdf5e7066c8`.
All four focused suites pass at 419 tests and 2,727 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 83 artifact
with 1,006. Flow typecheck passes. Full deterministic verification, a new
digest, three zero-finding audits, preflight, and the authorized live run remain
pending.

Correction 40 records that the frozen fourteen-artifact digest
`65f7e553e851d657cdc220ec72660dfc5dba1b356fa31a461dd54ed5077b816b`,
three zero-finding audits, and preflight `20260716182959-15561` passed before
authorized live run `20260716183318-48343` exited 1 after 17,815ms. No backend,
push, pull request, CI, or merge started. The compiled Bun runtime could not
resolve the copied workflow's installed `typescript` dependency because its
build omitted runtime package metadata loading.

Local and release binaries now enable
`--compile-autoload-package-json`. An initial source validator bound both build
paths to that setting, and the local-binary smoke executes a repository flow
importing a project package. That smoke failed RED with the retained resolution
error and passed GREEN; typecheck, touched-file lint, release validation,
embedded-loader tests, and an inert import of the retained runtime pass. The
release-artifact amendment below replaces the source validator. The exact
123-row ledger prefix has SHA-256
`71e942097fd6ec015bb6a4d267144048f39705f5a2e89496bde57bdf5e7066c8`;
one open row brings it to 124 unique rows with SHA-256
`fcd8e718290c2d15facac74bb1641fa3a94c60432af2b57e48caa95e4dc04758`.
All four focused suites pass at 419 tests and 2,727 assertions, and full
verification passes 466 tests with one gated skip, zero failures, and 1,336 assertions. A
successor digest, audits, and preflight remain pending. The consumed live
authorization does not permit another invocation.

### Correction 40 release-artifact proof amendment

Static AST validation is not the final release-build proof. Four adversarial
mutants showed that a source checker can bind the apparent Bun argv while dead
calls, nested loops, contradictory flags, or helper transformations change the
executed behavior. The verify-blocking proof must execute the release builder's
real entrypoint and then execute its host-native artifact.

`scripts/build-release-binaries.ts` accepts either no arguments or the paired
smoke arguments `--only-target=<target>` and `--release-dir=<path>`. No arguments
preserve the release contract: rebuild all four supported targets under
`dist/release`. Smoke mode accepts exactly one supported target, requires a
nonexistent explicit output directory, and never removes that caller-selected
directory. Unknown, duplicate, partial, or unsupported arguments fail before
filesystem mutation.

`scripts/smoke-binary.ts` maps the current host OS and architecture to one of
the four supported Bun targets, creates a disposable parent directory, and
invokes the release script through its CLI entrypoint in smoke mode. It runs the
unarchived release binary against the same repository flow that imports
`typescript`, verifies the sentinel output, and removes only its own disposable
parent in `finally`. Unsupported hosts fail explicitly. The normal local-binary
help, version, repository-flow, external-flow, and respawn checks remain.

The host-native executable smoke replaces the release source-syntax validator
`scripts/release-build-validation.ts` and its unit test;
`scripts/validate-release.ts` retains release metadata validation but no longer
claims to prove runtime behavior from source syntax. Parser tests lock default
and smoke modes plus every rejected argument class. The autoload-removal
mutation proof passed: removing the package-autoload flag from the release argv
made the release artifact smoke fail with the retained `typescript` resolution
error; restoring the flag returned GREEN before full verification.

### Correction 41 absolute launcher-deadline amendment

The first post-Correction 40 successor digest
`16e2c3824553866e404fccd4eaf7e8b3930db28f81894a7e9e68c9c7ff866748`
is invalid. Although the launcher recorded an exact
`launcher_deadline_at_ms`, `remaining_launcher_ms` used whole-second
`SECONDS`. The commit decisions before live latest and canonical-ledger
publication and before preflight publication could therefore authorize success
up to 999 milliseconds after the absolute deadline.

The default remainder path now reads and validates fresh millisecond time and
subtracts it from the absolute deadline. Active-child polling deliberately
retains shell-native elapsed time so a stalled external clock cannot defer
signal cleanup; each command starts from one exact remainder and successful
completion receives another exact deadline check. The obsolete launcher-wide
started-seconds state is removed. Live and preflight harnesses with
`now_ms=100` and deadline `99` prove late success is unpublishable and the
canonical ledger remains unchanged. The Correction 27 stalled-clock signal
test remains load-bearing.

The exact 124-row ledger prefix has SHA-256
`fcd8e718290c2d15facac74bb1641fa3a94c60432af2b57e48caa95e4dc04758`;
one open row brings it to 125 unique rows with SHA-256
`952d97ef59e8f4d5895c1a27b679614fbfbbf2d5e2b70c81e80d280bc84ae72a`.
All four focused suites pass at 421 tests and 2,737 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 85 artifact
with 1,016. Full verification passes 466 tests with one gated skip, zero
failures, and 1,336 assertions. A fresh successor digest, three audits, and
preflight remain pending; another live run needs fresh explicit authorization.

### Correction 42 terminal-ledger commit-point amendment

Correction 41 placed fresh exact reads at the publication entry and wrapper
exit, but its live regression expired before first publication. It did not
cover expiry during the terminal worker's binding validations. The worker could
rename the canonical ledger first; the wrapper then returned timeout, and the
caller recovered success from the authentic committed ledger hash.

Terminal-commit merge now reads exact time after all hash bindings and
immediately before canonical rename. Equality or expiry returns timeout without
publication. The regression keeps 4.9 seconds of shell-native polling budget,
changes only exact time after terminal-ledger hash binding, and expires before
rename. RED expected exit 74 but received 0 with committed terminal state.
GREEN exits 74, retracts success-shaped latest evidence, and preserves the
canonical ledger. Recovery from a signal after an already-authorized rename
remains valid because the pre-rename action-authentic decision is now
load-bearing.

The exact 125-row ledger prefix has SHA-256
`952d97ef59e8f4d5895c1a27b679614fbfbbf2d5e2b70c81e80d280bc84ae72a`;
one open row brings it to 126 unique rows with SHA-256
`9a83857191d0563a2a13acf078889086be3cdc902c3c280d665a721a2edfe5ef`.
All four focused suites pass at 422 tests and 2,743 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 86 artifact
with 1,022. Full verification passes 466 tests with one gated skip, zero
failures, and 1,336 assertions. Fresh reviews, a new digest, three audits, and
preflight remain pending; another live run needs fresh explicit authorization.

### Correction 43 terminal-deadline proof-sensitivity amendment

The first frozen Correction 42 successor digest
`14b684dc4829740debc908b96b1ce00cd47d605ff5958deca10aed485d87590f`
is invalid. The regression changed exact time after only the staged-ledger hash,
so relocating the decision there stayed green while later evidence bindings
could consume the rename window. Its `now_ms=6000` with deadline `5000` also
failed to distinguish `-le` from `-lt` at equality.

The harness now changes exact time only after the final binding decision and
sets it exactly equal to the deadline. One mutation moves the deadline decision
after the staged-ledger hash; another weakens equality rejection to
strict-before. Both mutation proofs failed RED because the invalid launchers
still returned 74. GREEN makes both mutants return 0 while the production
regression returns 74 without canonical publication. This binds the test to an
authentic decision after every evidence binding, immediately before rename,
with equality rejected. Post-rename recovery and stalled-clock signal handling
remain unchanged.

The exact 126-row ledger prefix has SHA-256
`9a83857191d0563a2a13acf078889086be3cdc902c3c280d665a721a2edfe5ef`;
two open rows bring it to 128 unique rows with SHA-256
`2476a42e688b8d125a8d5765bd366f514a38ac99c81e711e1415d2b48d935ec9`.
All four focused suites pass at 424 tests and 2,756 assertions: 84 library with
323 assertions, 167 runtime with 682, 85 contract with 716, and 88 artifact
with 1,035. Full verification passes 466 tests with one gated skip, zero
failures, and 1,336 assertions. A new digest, three audits, and preflight remain
pending; another live run needs fresh explicit authorization.

### Correction 44 compact-scout evidence amendment

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

### Correction 45 frozen-audit fix amendment

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

### Correction 46 harness-timeout fix amendment

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

### Correction 47 finalizer-harness timeout-policy amendment

The complete four-suite gate exposed a second default-timeout failure:
`successful terminal publication validates monitor identity and outcome`
timed out after 5003.72 milliseconds. It expected launcher exit 74 but received
the timeout signal status 143. Correction 46 therefore exposed a class-wide
test-policy gap rather than an isolated slow scenario.

A deterministic AST inventory found 31 finalizer-harness tests, 33 static calls,
and 52 loop-expanded subprocess runs. The 24 default-timeout tests
relied on Bun's five-second default, six already declared 15 seconds, and
`terminal commit rejects bound evidence mutation after private staging`
declared 30 seconds for its six scenarios. Every ordinary finalizer-harness
test now declares a 15-second timeout; that mutation test retains its 30-second
timeout. An AST policy guard locks the 31-test, 33-call inventory and
52-run expansion. It rejects indirect harness references and duplicate
exception titles.
It permits exactly one six-scenario 30-second exception.
It rejects reduced scenario sets, so an unbounded new harness test or
accidental timeout change fails deterministically.

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

### Correction 48 unconditional scenario-policy amendment

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

### Correction 49 exact harness scenario-policy amendment

The Correction 48 frozen-byte audits found five remaining root-cause classes:

- `audit-finalizer-harness-scenario-binding`:
- `audit-finalizer-harness-global-loop-control`:
- `audit-finalizer-harness-option-integrity`:
- `audit-finalizer-harness-scenario-identity`:
- `audit-finalizer-harness-callable-identity`:

Static cardinality did not prove scenario identity, loop-to-option selection,
control-flow completion, or callable identity.
All seven harness loops require exact scenario-array digests.
They require exact scenario-to-option selector paths.
They use inline non-spread scenario literals.
They use const loop bindings and a first awaited harness call.
Remaining values are pure harness options with unique static keys.

Pre-loop and post-call returns, breaks, catching try blocks, conditional skips,
spreads, computed overrides, assignments, calls, and irrelevant bindings fail
closed.
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

### Correction 50 audit-closure amendment

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

### Correction 51 composed-finalization amendment

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

### Correction 52 historical-proof-boundary amendment

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

### Correction 53 exact-historical-boundary amendment

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

Before the first live run:

1. Run pure ranked-fallback tests and real temporary-Git restoration tests.
2. Run finalization behavior tests and publication mutation contracts, including
   asynchronous timeout, non-publication synchronous post-action overrun, abort,
   stale settlement, terminal-report ordering, one authentic immediate
   pre-rename commit decision, and atomic rename. Reject pre-write, relocated,
   post-rename, forged, and duplicate commit decisions plus fallible work after
   successful rename. Prove a cleanup failure remains secondary to the original
   pre-publication error.
3. Prove a non-Codex `ORCA_BACKEND` is rejected before every side-effect
   witness, while unset, empty, and explicit Codex select the same backend.
4. Prove every timer helper rejects completion at or after its absolute
   deadline. Cover owned settled timeouts without redundant cancellation,
   pending cancel-and-settle, JSON-safe usage/evidence, one-snapshot retry, and
   late or equal generic and manifest operations that cannot commit evidence.
5. Run the Orcats author typecheck script against the generated workflow.
6. Run a static self-audit for imports, flow envelope, outcome narrowing,
   backend shutdown, baseline policy, monitor use, gate coverage, stage
   directives, and forbidden Git operations.
7. Run the launcher preflight through worktree creation without a model turn.

For the live acceptance run:

1. Observe each stage transition through `orcats-flow`.
2. Confirm the accepted rank's exact filtered positive control passed before
   the target regression failed with its expected pattern and before production
   changed. If any rank was rejected, confirm its artifact and exact restoration
   evidence precede the next attempt.
3. Confirm targeted test and lint passed.
4. Confirm independent review returned no blocker.
5. Confirm `bun run verify` exited zero.
6. Confirm the verified, pre-stage, staged, and committed manifests match.
7. Confirm remote checks succeeded. Immediately before merge, require strict
   `Verify` protection from workflow `CI` on `main`, pinned to GitHub Actions app
   ID `15368`, with administrator enforcement. Poll again, persist that final
   passing command log and rows with timestamp and the fixed local head SHA,
   then reassert the ready head. Startup-empty, pending, failed, unprotected, or
   nonzero results produce no passing evidence.
8. Confirm the merge attempt was persisted and bounded authoritative state
   confirmation ran after its response. Accept latent success only for the exact
   pull request identity and final state `MERGED`; otherwise preserve the
   command and confirmation failures. Confirm the pull request merged.
9. Confirm shutdown ran once, retryable evidence preceded one atomic terminal
   report, each publication returned its authentic commit-point decision, no
   stale attempt published, and stable run-local issues remained candidate-only.
   Then confirm the launcher atomically committed a zero-open canonical ledger
   with the exact terminal record, latest projection and claims, and freshly
   revalidated bound hashes.
10. Confirm total elapsed time is at most 10 minutes.
11. Summarize monitoring usage and verify no Codex child process remains.

## Acceptance Criteria

The design is complete only when one current-state run proves all of the
following:

- the proving workflow used default or explicit Codex, and a non-Codex request
  was independently rejected before any side effect;
- timer-backed conversations, retries, generic operations, and manifest reads
  were accepted only when their recorded completion preceded the absolute
  deadline; timeout usage/evidence remained JSON-safe and late work committed
  no evidence;
- launcher deadline polling used no external clock subprocess while an active
  child existed; signals reaped the child group before finalization; and a
  successful leader could leave neither a process-group member nor a detached
  owner-token descendant alive, while temporary scan state contained matched
  PID lines only;
- a fresh worktree was created from current `origin/main`;
- simple, medium, and challenging profiles validate their 10/30/45-minute
  ceilings and 3/6/10-path limits; the live proof uses simple;
- the scout returned three ranked low-risk candidates and one rank-one control;
  the first candidate with a genuine RED proof became the selected
  three-file-or-smaller improvement;
- both a named skill directive and a stage prompt directive were applied;
- deterministic evidence including the latest commit, ranked attempts,
  accepted control, implementation, test, verification, review, pull request,
  remote checks, and merge are individually observable;
- the exact filtered positive control passes before the selected regression
  demonstrates red then green behavior, and its production result reaches a
  causal matcher that is executable through label-scoped control flow, outside
  any optional chain, and before any unconditional termination;
- the positive control and added RED assertion resolve to the same exported
  production entrypoint through lexical symbol identity, including through
  aliases and namespace imports, while shadowing or untainted reassignment
  clears an outer origin;
- control and RED matcher expectations are passive and independent of their
  received production value; evaluated nested writes, invoked local behavior,
  and later production calls with non-primitive-proven arguments invalidate
  exact provenance, while supported named and namespace origins survive
  non-optional `await`;
- matcher-argument const bindings resolve only through recursively proven
  primitives; mutable containers and prototype-dependent matchers cannot prove
  causality, while inline passive objects and unshadowed global `undefined`
  remain valid;
- the parent byte-verifies one frozen matcher preload before any proof command;
  both controls, exact named RED, and targeted GREEN run with extensions and
  matcher-prototype mutation disabled;
- candidate test source equals baseline raw bytes plus exactly one contiguous
  top-level-test insertion, with fatal UTF-8 decoding retaining any BOM and no
  inserted disabling directive token;
- the candidate marker is absent from baseline; semantic evidence returns the
  exact single added test's static name; RED runs only its anchored and escaped
  exact-name selector; and one exact `(fail)` record plus one canonical summary
  prove zero passes, one failure, nonzero expectation calls, one test, and one
  file;
- local targeted gates and `bun run verify` pass;
- every workspace-writing agent node preserves ignored `.orca` controls and
  evidence, and verified worktree, staged-index, and committed-tree manifests
  are identical;
- the ready pull request's `CI / Verify` check and every reported check pass;
- `main` enforces strict `Verify` protection from workflow `CI` for
  administrators, pinned to GitHub Actions app ID `15368`, so GitHub rejects a
  merge if check state changes after the final client poll;
- the report's `remoteChecks` record contains literal state `passed`, the exact
  final command log, every returned check row, its timestamp, and the unchanged
  locally validated head SHA;
- the ready pull request's SHA-locked merge attempt is persisted before bounded
  authoritative confirmation, and the pull request is accepted as squash-merged
  only when its exact URL, repository, base, head ref, head SHA, draft state,
  and final state match;
- shutdown ran once; retryable ledger and monitor artifacts preceded one
  terminal, atomic report; every publication returned one authentic immediate
  pre-rename commit decision from a fresh validated millisecond read and exact
  absolute subtraction that the wrapper could not reclassify; equality,
  expiry, and stale attempts could not publish; and the report could pass SLA
  only with a positive absolute-deadline remainder at that commit point;
- a signal recorded during the final child wait retained its conventional exit
  status after child reaping and trap restoration;
- latest publication alone never transferred terminal authority; preflight
  became authoritative only after its final rename returned, while live success
  still required the canonical ledger commit;
- a preflight signal before ownership transfer cleared or reallocated fresh
  current-run private retraction paths when canonical quarantines and reused
  fallbacks were occupied, retried retraction, and left no canonical success;
- the launcher rejected a concurrent source suffix, committed the canonical
  zero-open ledger last, kept stable run-local issues candidate-only until that
  commit, and bound its unique terminal record to freshly revalidated candidate
  ledger, report, monitor, latest-projection, embedded-claim, and final-ledger
  hashes;
- the bound monitor was the only monitor JSON, matched its filename run ID, and
  contained one clean completed outcome with no failures;
- elapsed time is at most 10 minutes;
- monitoring reports progress, outcome, stop reason, and usage;
- the prior timeout issue is linked to this corrective run, and every new
  workflow/runtime issue has a correction entry plus a later proving run;
- main's pre-existing untracked `package-lock.json` remains untouched.

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
