## MODIFIED Requirements

### Requirement: Skill monitors progress and detects stalls

While a run is active, the skill SHALL judge progress from live process stderr,
runtime heartbeat or stage messages, loop state history, persistent-plan
checkbox state, and git status/history. Terminal monitoring JSON SHALL be
treated as the durable final summary after the run ends, not as a required live
heartbeat. The skill SHALL flag a stall only when none of the available live
signals advances across a tunable window beyond the runtime's inactivity
watchdog, not on backend slowness alone.

#### Scenario: Healthy slow run is not flagged

- **WHEN** stderr, a heartbeat or stage message, loop state, persistent plan, or git history advances during a slow backend turn
- **THEN** the skill treats the run as live and does not flag a stall

#### Scenario: Terminal JSON is not required for liveness

- **WHEN** an active run has not yet written its terminal monitoring JSON
- **THEN** the skill monitors the available live signals without treating the absent summary as a stall or failure

#### Scenario: Stuck run is flagged

- **WHEN** no stderr heartbeat, stage, plan, loop-state, file, or commit progress occurs within the configured window beyond the inactivity watchdog
- **THEN** the skill flags a stall and surfaces the last observed live signal

### Requirement: Skill diagnoses runtime failures

On failure the skill SHALL classify the cause (backend crash, expired or
missing authentication, validation/gate failure, non-convergence, stall, or
served-child failure) using live process evidence and the terminal monitoring
summary when present. A terminal summary's final status, backend, transport,
active stage, and terminal error SHALL be authoritative over wrapper echo text
or the mere presence of a monitor-log path. The report SHALL name the affected
backend and selected transport when those fields are available.

#### Scenario: Terminal failure overrides wrapper echo

- **WHEN** wrapper output looks successful or prints a monitor path but the terminal monitoring summary records failure
- **THEN** the skill reports the run as failed and uses the summary's stage and terminal error as evidence

#### Scenario: Backend/auth failure classified

- **WHEN** a run fails because a backend transport crashes or authentication is missing or expired
- **THEN** the skill classifies it as an environment failure and identifies the affected backend and selected transport

#### Scenario: Non-convergence classified

- **WHEN** a task's fix-loop hits its convergence guard or ceiling
- **THEN** the skill classifies it as non-convergence and surfaces the recorded failure category

### Requirement: Skill resolves and heals failures within safety bounds

The skill SHALL attempt bounded, safety-gated recovery. For environment
failures it SHALL run the backend doctor against the same selected transport,
give transport-specific recovery guidance, guide re-authentication when needed,
and resume via persistent plan or loop state only after readiness is restored.
It SHALL NOT silently switch transports. For non-convergence it SHALL retry with
an adjusted prompt or backend a bounded number of times before escalating. For
a crash it SHALL resume from persistent plan or loop state. The skill SHALL NOT
auto-perform destructive or irreversible repository actions (for example
force-push, history rewrite, or destructive resets) and SHALL escalate those to
the user.

#### Scenario: Heal expired authentication and resume

- **WHEN** a run fails on expired backend authentication
- **THEN** the skill runs the doctor for the affected backend and selected transport, guides re-authentication, and resumes only after that transport is ready

#### Scenario: Claude transport recovery stays specific

- **WHEN** a Claude run fails over `stream-json` or `acp`
- **THEN** the skill names the selected transport and gives its specific diagnostic or recovery command
- **THEN** it does not switch Claude transports without explicit operator intent

#### Scenario: Bounded non-convergence retry

- **WHEN** a task fails to converge
- **THEN** the skill retries within a bounded limit and escalates to the user when the limit is reached

#### Scenario: Destructive recovery escalates

- **WHEN** recovery would require a destructive or irreversible repository action
- **THEN** the skill does not perform it automatically and asks the user how to proceed

### Requirement: Skill surfaces outcome and owns backend lifecycle

At the end of a run the skill SHALL surface the final status, exit status,
terminal error when present, and per-agent cost/usage summary. When terminal
monitoring JSON exists, its explicit final status SHALL determine the reported
outcome rather than a wrapper echo pattern. The skill SHALL ensure any managed
backend process is shut down (for example calling OpenCode's shutdown) so no
server is left running.

#### Scenario: Outcome surfaced

- **WHEN** a run writes a terminal monitoring summary
- **THEN** the skill reports its final status, end time, active stage, backend, transport, terminal error, and available per-agent cost or usage

#### Scenario: Wrapper echo disagrees with final status

- **WHEN** wrapper echo text disagrees with the terminal summary's final status
- **THEN** the skill reports the terminal summary's status as the run outcome

#### Scenario: Managed backend shut down

- **WHEN** a run used the OpenCode backend
- **THEN** the skill ensures the managed `opencode serve` process is shut down after the run
