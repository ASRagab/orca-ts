---
title: Source Checkout
description: Install Orca from source for development and contribution.
---

Use a source checkout when you are contributing to Orca itself.

```bash
git clone https://github.com/ASRagab/orca-ts.git
cd orca-ts
bun install --frozen-lockfile
bun run verify
```

`bun run verify` runs typecheck, unit tests, docs-site build, internal doc-link checking, fixture validation, release metadata validation, declaration generation, facade checks, and a compiled binary smoke. It does not require live backend credentials.

## Docs site development

```bash
bun run docs:site:dev
bun run docs:site:build
bun run docs:site:preview
```

The docs site lives under `website/` and is isolated from runtime package code.
