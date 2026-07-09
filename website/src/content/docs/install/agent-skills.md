---
title: Agent Skills
description: Install the bundled Orca skills for setup, authoring, and running flows.
---

The repository ships three host-agnostic Agent Skills:

| Skill | Purpose |
| --- | --- |
| `orcats-setup` | Install or verify the `orcats` CLI and verify at least one backend. |
| `orcats-author` | Generate a saved, verification-gated workflow or loop module. |
| `orcats-flow` | Run, monitor, diagnose, and heal a saved workflow or loop. |

The intended sequence is:

```text
orcats-setup -> orcats-author -> orcats-flow
```

## Install from GitHub

```bash
npx skills add ASRagab/orca-ts --list
npx skills add ASRagab/orca-ts --skill '*' --global
```

Install one skill to one agent:

```bash
npx skills add ASRagab/orca-ts --skill orcats-setup --agent claude-code
```

Before the repository is public, install from a local checkout:

```bash
git clone https://github.com/ASRagab/orca-ts.git
npx skills add ./orca-ts --skill '*' --global
```

Each skill is self-contained. Its `SKILL.md`, `scripts/`, references, and templates are installed together.

Generated mutating artifacts default to baseline policy `repair`. Use
`--baseline=strict`, `--baseline=accept-dirty`, or `ORCA_BASELINE_POLICY` only
when you want to override that per run.
