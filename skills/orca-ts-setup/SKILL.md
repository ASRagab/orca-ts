---
name: orca-ts-setup
description: "Install the Orca TypeScript `orca` binary and verify at least one coding-agent backend (claude/codex/opencode/pi) is on PATH, authenticated, and usable. Asks which backend(s) to enable, runs a non-spending readiness probe, and troubleshoots install/auth/config failures. Re-runnable as a doctor. Use first, before authoring or running an Orca workflow, or whenever a backend stops working. Triggers on \"install orca\", \"set up orca\", \"orca setup\", \"verify orca backend\", \"orca backend not working\", \"orca doctor\"."
compatibility: "Host-agnostic (any coding agent) and stack-agnostic (any git-backed repo). Binary-only use needs neither Bun, Node, nor a JVM. Verifying a backend needs that backend's CLI installed and authenticated. Bundled scripts locate every CLI at runtime — never hardcoded."
metadata:
  author: "Ahmad Ragab"
---

# orca-ts-setup — install Orca and prove a backend works

Orca runs TypeScript flows that drive a coding-agent backend. Before you can
author (`orca-ts-author`) or run (`orca-ts-flow`) a workflow, two things must be
true: the `orca` binary is installed, and **at least one** backend is
authenticated and usable. This skill establishes both and troubleshoots
failures. It is safe to re-run any time as a doctor.

Flow: **install the binary → ask which backend(s) to enable → verify → on
failure, classify and give a concrete fix → confirm at least one backend is
ready.**

## 1. Install (or locate) the `orca` binary

Prefer an existing on-`PATH` binary; otherwise run the documented installer. The
bundled script does both and confirms with `orca --version`:

```bash
bash skills/_shared/scripts/orca-setup.sh
```

Honor the user's pin/location if they give one:

```bash
ORCA_VERSION=0.1.0 ORCA_INSTALL_DIR="$HOME/bin" bash skills/_shared/scripts/orca-setup.sh
```

- If `orca` is already on `PATH` (and matches any requested `ORCA_VERSION`), the
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

Run the shared doctor for the chosen backend(s). It probes each for CLI-on-PATH,
a non-spending readiness check, and auth, then classifies the result:

```bash
bash skills/_shared/scripts/orca-doctor.sh --backend codex --backend claude
# or: --all  to probe every backend
```

Per-backend status:

| Status | Meaning |
|---|---|
| `ready` | CLI present, `--version` ok, auth confirmed (codex/opencode) or credentials found (claude/pi) |
| `unverified` | CLI + version ok, but auth can't be cheaply proven (claude/pi) — probably fine; confirm with `--smoke` |
| `unauth` | CLI present but not authenticated |
| `missing` | CLI not on `PATH` |
| `misconfig` | CLI present but `--version` failed (broken install) |

The doctor exits `0` iff at least one chosen backend is `ready` or `unverified`.
**Do not declare setup complete until that holds.**

Optional definitive auth proof for claude/pi (spends a few tokens — gated):

```bash
bash skills/_shared/scripts/orca-doctor.sh --backend claude --smoke
# or set ORCA_REAL_BACKEND_SMOKE=1 in the environment
```

The smoke runs one cheap real turn through the `orca` binary; it is the only way
to *prove* auth for backends with no non-spending status check.

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
  broken. Reinstall the CLI and confirm it runs outside Orca.
- **Installer `checksum`/`network` failure** (from `orca-setup.sh`) → the script
  prints the manual fallback: download the tarball + `SHA256SUMS.txt` from the
  releases page, `shasum -a 256 -c SHA256SUMS.txt`, move `orca` onto `PATH`.

## 5. Re-run any time (doctor mode)

The skill is idempotent. On a healthy environment, step 1 skips reinstall and
step 3 re-confirms readiness. Re-run it whenever a workflow fails with a backend
or auth error — `orca-ts-flow` does exactly this during healing.

## Done when

- `orca --version` succeeds, and
- the doctor reports at least one chosen backend `ready`/`unverified` and exits 0.

Report the resolved binary version and the per-backend status table, then point
the user to `orca-ts-author` to create a workflow.
