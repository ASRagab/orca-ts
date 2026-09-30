---
title: Source Checkout
description: Install Orcats from source for development and contribution.
---

Use a source checkout when you are contributing to Orca itself.

```bash
git clone https://github.com/ASRagab/orca-ts.git
cd orca-ts
bun install --frozen-lockfile
./bin/orcats --version
bun run verify
```

Run the source checkout through `./bin/orcats`, including
`./bin/orcats check <artifact.ts>`. The public POSIX launcher clears ambient
`BUN_OPTIONS` before it enters Bun; `bun src/cli/main.ts` is contributor-only
and is not the supported consumer path.

`bun run verify` runs typecheck, unit tests, docs-site build, internal doc-link checking, fixture validation, release metadata validation, declaration generation, facade checks, and a compiled binary smoke. It does not require live backend credentials.

## Docs site development

```bash
bun run docs:site:dev
bun run docs:site:build
bun run docs:site:preview
```

The docs site lives under `website/` and is isolated from runtime package code.
