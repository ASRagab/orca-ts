---
title: Agent Skills
description: Install the bundled Orca skills for setup, authoring, and running flows.
---

The repository ships three host-agnostic Agent Skills:

| Skill | Purpose |
| --- | --- |
| `orca-ts-setup` | Install or verify the `orca` CLI and verify at least one backend. |
| `orca-ts-author` | Generate a saved, verification-gated workflow or loop module. |
| `orca-ts-flow` | Run, monitor, diagnose, and heal a saved workflow or loop. |

The intended sequence is:

```text
orca-ts-setup -> orca-ts-author -> orca-ts-flow
```

## Install from GitHub

```bash
npx skills add ASRagab/orca-ts --list
npx skills add ASRagab/orca-ts --skill '*' --global
```

Install one skill to one agent:

```bash
npx skills add ASRagab/orca-ts --skill orca-ts-setup --agent claude-code
```

Before the repository is public, install from a local checkout:

```bash
git clone https://github.com/ASRagab/orca-ts.git
npx skills add ./orca-ts --skill '*' --global
```

Each skill is self-contained. Its `SKILL.md`, `scripts/`, references, and templates are installed together.
