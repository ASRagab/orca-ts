---
name: orcats-setup
description: "Install the Orcats `orcats` binary and prove at least one selected coding-agent backend transport is usable. Static CLI/auth checks remain unverified; a consent-gated bounded live turn is required for ready. Re-runnable as a doctor."
compatibility: "Host-agnostic (any coding agent) and stack-agnostic (any git-backed repo). Binary-only use needs neither Bun, Node, nor a JVM. Verifying a backend needs that backend's CLI installed and authenticated. Bundled scripts locate every CLI at runtime — never hardcoded."
metadata:
  author: "Ahmad Ragab"
---

# orcats-setup — install Orcats and prove a backend works

Orcats runs TypeScript workflows and loop modules that drive a coding-agent
backend. Before you can author (`orcats-author`) or run (`orcats-flow`) an
artifact, two things must be true: the `orcats` binary is installed, and **at
least one** backend is
authenticated and usable. This skill establishes both and troubleshoots
failures. It is safe to re-run any time as a doctor.

Flow: **install the binary → ask which backend(s) to enable → verify → on
failure, classify and give a concrete fix → confirm at least one backend is
ready.**

## 1. Install (or locate) the `orcats` binary

Prefer an existing on-`PATH` binary; otherwise run the documented installer. The
bundled script does both and confirms with `orcats --version`:

```bash
bash skills/orcats-setup/scripts/orca-setup.sh
```

Honor the user's pin/location if they give one:

```bash
ORCA_VERSION=0.1.0 ORCA_INSTALL_DIR="$HOME/.local/bin" bash skills/orcats-setup/scripts/orca-setup.sh
```

- If `orcats` is already on `PATH` (and matches any requested `ORCA_VERSION`), the
  script reports the version and **skips installation** — this is the doctor
  fast-path.
- If install drops the binary into a dir not on `PATH`, the script prints the
  exact `export PATH=...` line to add.

## 2. Choose which backend(s) to enable

Ask the user which of the four supported backends to enable: **claude, codex,
opencode, pi**. Do not assume.

- **On Claude Code**: use `AskUserQuestion` with the four backends as options
  (multi-select).
- **On a host without structured prompts**: ask in one line — "Which backend(s)
  do you want to enable? (claude/codex/opencode/pi)" — and accept a bare,
  possibly comma-separated answer.

You only need **one** to pass, but verify every backend the user names.

## 3. Verify with the doctor

Run the shared doctor for the chosen backend(s). It resolves the active
transport first, checks that transport's executables and available static auth
evidence, and reports those facts without claiming the transport was exercised:

```bash
bash skills/orcats-setup/scripts/orca-doctor.sh --backend codex --backend claude
# or: --all  to probe every backend
# explicit Claude ACP selection:
bash skills/orcats-setup/scripts/orca-doctor.sh --backend claude --transport acp
```

Per-backend status:

| Status | Meaning |
|---|---|
| `ready` | A bounded live turn succeeded over the reported selected transport |
| `unverified` | Required executables and available static auth evidence passed, but the selected transport has not completed a turn |
| `unauth` | CLI present but not authenticated |
| `missing` | CLI not on `PATH` |
| `misconfig` | CLI present but `--version` failed (broken install) |

The doctor exits `0` only when at least one chosen backend/transport is `ready`.
Static checks normally exit `1` with `unverified`; that is incomplete setup,
not a broken CLI.

Before the live proof, tell the user it spends a small number of tokens and ask
for consent. Only after consent run:

```bash
bash skills/orcats-setup/scripts/orca-doctor.sh --backend claude --smoke
# or set ORCA_REAL_BACKEND_SMOKE=1 in the environment
```

The smoke runs one bounded turn through the installed `orcats` entry point and
the reported transport. Declining leaves the backend `unverified`; do not call
it usable or setup complete.

## 4. Troubleshoot by failure class

Map the doctor's status to a concrete next step — never hand back a raw error.

- **`missing`** → tell the user how to install that CLI (the doctor prints a
  hint per backend): Claude Code docs, `codex login` after install,
  `opencode auth login`, or the pi CLI install + auth.
- **`unauth`** → give the backend-specific login step: `codex login`,
  `opencode auth login`, `claude` then `/login` (or `claude setup-token` for a
  long-lived token), or set `ANTHROPIC_API_KEY`/`ANTHROPIC_OAUTH_TOKEN` for pi.
  Re-run the doctor after.
- **`misconfig`** → the CLI is on `PATH` but `--version` failed; the install is
  broken. Reinstall the CLI and confirm it runs outside Orcats.
- **Claude `stream-json` failure** → keep `stream-json` selected, verify `claude
  --version` and login, then rerun the same smoke.
- **Claude `acp` failure** → verify `claude-agent-acp` (or
  `ORCA_CLAUDE_ACP_COMMAND`) and Claude auth, then rerun with `--transport acp`.
  Never replay the turn through another transport without explicit user intent.
- **Installer `checksum`/`network` failure** (from `orca-setup.sh`) → the script
  prints the manual fallback: download the tarball + `SHA256SUMS.txt` from the
  releases page, `shasum -a 256 -c SHA256SUMS.txt`, move `orcats` onto `PATH`.

## 5. Re-run any time (doctor mode)

The skill is idempotent. On a healthy environment, step 1 skips reinstall and
step 3 re-confirms readiness. Re-run it whenever a workflow fails with a backend
or auth error — `orcats-flow` does exactly this during healing.

## Done when

- `orcats --version` succeeds, and
- the doctor reports at least one chosen backend/transport `ready` after the
  user-consented smoke and exits 0.

Report the resolved binary version and the per-backend status table, then point
the user to `orcats-author` to create a workflow.
