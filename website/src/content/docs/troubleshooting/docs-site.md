---
title: Docs Site Troubleshooting
description: Fix docs build, preview, and internal-link failures.
---

Run the docs build:

```bash
bun run docs:site:build
```

Run internal link checks:

```bash
bun run docs:check
```

Preview the built site:

```bash
bun run docs:site:preview
```

Common fixes:

| Failure | Fix |
| --- | --- |
| Missing dependency | Run `cd website && bun install --frozen-lockfile`. |
| Broken internal link | Use a relative link to the target `.md` file. |
| Missing GitHub Pages assets | Check `site` and `base` in `website/astro.config.mjs`. |
| Sidebar item 404 | Confirm the `slug` matches a file under `website/src/content/docs`. |
