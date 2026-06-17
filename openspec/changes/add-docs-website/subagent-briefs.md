# add-docs-website subagent briefs

## Shared source material

- `README.md`
- `CONTEXT.md`
- `docs/`
- `skills/orca-ts-setup/SKILL.md`
- `skills/orca-ts-author/SKILL.md`
- `skills/orca-ts-flow/SKILL.md`
- `examples/`
- `openspec/changes/add-docs-website/proposal.md`
- `openspec/changes/add-docs-website/design.md`
- `openspec/changes/add-docs-website/specs/documentation-website/spec.md`

## Integration rules

- Write user-facing prose only.
- Do not document npm publishing, `bunx -p orca-ts`, or registry tarballs as supported install paths.
- Document only supported backend tags and constructors: `claude`, `codex`, `opencode`, and `pi`.
- Document snapshot and sqlite loop state stores; identify DBOS and Dolt as deferred, not selectable adapters.
- Do not change runtime exports, backend adapters, CLI behavior, release artifacts, or Agent Skill semantics.
- Keep code snippets on the public package surface and import from `orca-ts`.

## Site Infrastructure Agent

Goal: scaffold the isolated documentation app and verification path.

Context: Orca has no existing docs website. The site must live under `website/`, build with Astro Starlight, and publish to GitHub Pages at `https://ASRagab.github.io/orca-ts/`.

Constraints: keep the runtime package isolated; add docs-site scripts only; no live backend credentials; no changes to release binaries or CLI semantics.

Done when: `website/` builds locally, root scripts can build and preview it, CI verifies it, and a Pages workflow deploys the static output from pushes to `main` or manual dispatch.

## Content Architecture Agent

Goal: create the navigation, page inventory, and first-pass user docs.

Context: the website should be organized around user journeys: Start Here, Install, Guides, Reference, and Troubleshooting.

Constraints: use Orca vocabulary from `CONTEXT.md`; rewrite rather than copy implementation-only notes; keep README as a concise entry point.

Done when: the sidebar covers motivation, quickstart, concepts, install paths, skills, flows, loops, backend setup, monitoring, CLI, APIs, examples, release behavior, and troubleshooting.

## Technical Accuracy Agent

Goal: audit commands, snippets, supported surfaces, and unsupported paths.

Context: current supported backends are `claude`, `codex`, `opencode`, and `pi`; npm publishing is deferred; DBOS and Dolt are deferred; flows read task args with `flowArgs()`.

Constraints: snippets must import from `orca-ts`, use supported CLI verbs, and avoid internal runtime modules.

Done when: every command and code block matches current package scripts, CLI behavior, backend docs, loop docs, skill docs, and examples.

## Visual QA Agent

Goal: verify the built site is readable, navigable, and functional on desktop and mobile.

Context: Starlight provides sidebar, search, table of contents, dark mode, and code block UI.

Constraints: check the GitHub Pages base path, avoid text overflow, and keep code blocks readable on narrow screens.

Done when: local and static previews render home, quickstart, a guide, a reference page, and a troubleshooting page with working sidebar, search, dark mode, and internal links.
