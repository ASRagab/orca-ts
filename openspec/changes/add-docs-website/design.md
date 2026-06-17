## Context

Orca currently has a concise README, focused Markdown guides in `docs/`, three
installable Agent Skills under `skills/`, checked examples, and implementation
context in `AGENTS.md` and OpenSpec archives. There is no docs website, no
GitHub Pages workflow, and no site build in `bun run verify`.

The website must serve two audiences: users who are new to Orca and need a
safe path from install to first run, and advanced users who need references for
loops, backends, state, skills, CLI behavior, and troubleshooting. It must not
turn agent-facing implementation notes into public user guidance.

## Goals / Non-Goals

**Goals:**

- Publish a public GitHub Pages documentation website for Orca TypeScript.
- Use a documentation-first static site generator with built-in navigation,
  search, code highlighting, accessible typography, and dark mode.
- Organize content around user tasks and concepts, not repository file layout.
- Preserve the README as a compact entry point that links to the website.
- Keep the docs app isolated from Orca runtime/package code.
- Add deterministic local and CI verification for site build and links.
- Make implementation subagent-driven with clear independent workstreams.

**Non-Goals:**

- No runtime API, CLI, backend, release-binary, or Agent Skill behavior changes.
- No npm publishing path; the site must continue to document GitHub Release
  binaries and Git/source authoring until package publishing is restored.
- No live backend tests, external link fetching, analytics, hosted search
  service, or docs CMS.
- No wholesale migration of implementation-only notes from `AGENTS.md` or
  archived OpenSpec changes into public docs.

## Decisions

### Use Astro Starlight in a dedicated `website/` app

Use Astro Starlight for the docs site and place it under `website/`. Starlight
is documentation-specific and provides the baseline UI primitives this site
needs without building a custom React/Vite app: sidebar navigation, local
search, syntax highlighting, SEO defaults, dark mode, and Markdown/MDX content.

Alternatives considered:

- VitePress: good Markdown docs tool, but Vue-powered and less aligned with a
  standalone content app that may later need Astro components.
- Docusaurus: mature and feature-rich, but heavier than needed for a concise
  project docs site.
- Plain GitHub Pages/Jekyll: lowest dependency footprint, but weaker local
  authoring, navigation, and search out of the box.

### Keep source docs separate from generated site content

Use `website/src/content/docs/**` as the website content source. Migrate and
rewrite material from README, `docs/`, `skills/`, `examples/`, and `CONTEXT.md`
into user-facing pages instead of rendering repository Markdown in place.

Rationale: the existing files have different audiences. `docs/loops.md` is a
canonical Markdown guide today, while skills and AGENTS notes include agent
operator instructions. Rewriting into site pages allows the site to be
navigable without exposing implementation-only context.

### Use Diataxis as the information architecture, with product-specific entry points

Structure the site into:

- Start Here: motivation, quickstart, core concepts.
- Install: binary, typed authoring, source checkout, Agent Skills.
- Guides: first flow, saved workflow, backend setup, loops, served loops,
  monitoring and recovery.
- Reference: CLI, public API, backend matrix, loop API, state stores, skills,
  examples, release/distribution details.
- Troubleshooting: installation, typecheck, backend/auth, loops, docs site.

This preserves different reading modes: learn, accomplish a task, look up a
detail, and understand the model.

### Deploy with GitHub Actions Pages

Add a Pages workflow that builds the `website/` app and deploys the static
output. Configure Astro with the repository Pages URL and `/orca-ts` base path
for `https://ASRagab.github.io/orca-ts/`.

The workflow must be independent from release publishing. CI can build the site
for pull requests, while deployment should run on pushes to `main` and manual
dispatch.

### Add docs verification without weakening runtime verification

Add scripts for local docs-site development and build, and include the site
build in the deterministic verification path or a dedicated CI job that blocks
docs changes. Extend internal link checking to include website content or rely
on Starlight/Astro build failures plus the existing Markdown checker for root
docs.

No verification step may require live backend credentials or network access
after dependencies are installed.

### Use subagents for implementation workstreams

Implementation should be split into independent workstreams:

- Site Infrastructure Agent: scaffold Starlight, config, scripts, Pages
  workflow, and build verification.
- Content Architecture Agent: create navigation, page inventory, and migrated
  first-pass content.
- Technical Accuracy Agent: audit commands, backend matrix, loop API, skills,
  examples, and deferred npm/DBOS/Dolt/Gemini claims.
- Visual QA Agent: run local site, inspect desktop/mobile screenshots, check
  readability, navigation, search, code blocks, and base-path behavior.

The main implementer owns integration, final edits, link/build verification,
and conflict resolution.

## Risks / Trade-offs

- Site content drifts from README or `docs/` -> keep source links in page
  frontmatter or comments out of rendered prose, and add a maintenance checklist
  in tasks.
- New dependency surface slows CI -> isolate dependencies in `website/` and use
  a dedicated build script so failures are easy to diagnose.
- GitHub Pages base path breaks links/assets -> configure Astro `site` and
  `base`, then verify the built output with a local preview or static smoke.
- Public docs expose implementation-only notes -> use `AGENTS.md` and OpenSpec
  only as source context, not copy/paste content.
- Subagent outputs conflict or duplicate prose -> assign non-overlapping
  deliverables and have the main implementer do one integrated editorial pass.

## Migration Plan

1. Add the isolated Starlight app and local build scripts.
2. Add the initial content set and navigation.
3. Update README to point to the website while remaining usable on GitHub.
4. Add GitHub Pages deployment and deterministic site build verification.
5. Run link/build/visual checks, then merge.

Rollback is simple: remove the Pages workflow and `website/` app, and keep the
existing README/docs Markdown as the canonical documentation.

## Open Questions

- Should the published URL be the default repository Pages URL or a custom
  domain later?
- Should root `docs/*.md` remain full standalone guides long term, or become
  maintenance mirrors/redirect-style summaries once the website is established?
