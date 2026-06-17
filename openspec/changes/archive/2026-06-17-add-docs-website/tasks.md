## 1. Subagent Preparation

- [x] 1.1 Create four subagent briefs with goal, context, constraints, and done-when for site infrastructure, content architecture, technical accuracy, and visual QA.
- [x] 1.2 Identify shared source material for subagents: README, `docs/`, `skills/`, `examples/`, `CONTEXT.md`, and this change's proposal/design/spec.
- [x] 1.3 Define integration rules: user-facing prose only, no unsupported npm publishing path, supported backend tags only, no selectable DBOS/Dolt adapter, and no runtime behavior changes.

## 2. Site Infrastructure Agent

- [x] 2.1 Scaffold an isolated Astro Starlight docs app under `website/`.
- [x] 2.2 Configure the site name, repository links, navigation shell, `site`, and `/orca-ts` base path for GitHub Pages.
- [x] 2.3 Add local docs-site scripts for development, build, and preview without changing runtime CLI scripts.
- [x] 2.4 Add a GitHub Pages workflow that builds `website/` and deploys on pushes to `main` and manual dispatch.
- [x] 2.5 Add deterministic CI verification for the docs-site build and internal docs links.

## 3. Content Architecture Agent

- [x] 3.1 Create the Starlight sidebar and page inventory for Start Here, Install, Guides, Reference, and Troubleshooting.
- [x] 3.2 Write the home/start page with Orca motivation, audience, and links into quickstart and install paths.
- [x] 3.3 Write quickstart and concepts pages using the project vocabulary from `CONTEXT.md`.
- [x] 3.4 Write installation pages for standalone binary, typed Git/source authoring, source checkout, and Agent Skills.
- [x] 3.5 Write guide pages for first flow, saved workflow, backend setup, loops, served loops, monitoring, and recovery.
- [x] 3.6 Write reference pages for CLI, public API, backend matrix, loop API, state stores, Agent Skills, examples, distribution, and release behavior.
- [x] 3.7 Write troubleshooting pages for install, typecheck, backend/auth, loops, workflow execution, and docs-site build issues.

## 4. Technical Accuracy Agent

- [x] 4.1 Audit every command snippet against current package scripts, CLI behavior, and release/install docs.
- [x] 4.2 Audit backend documentation against supported constructors and tags: `claude`, `codex`, `opencode`, and `pi`.
- [x] 4.3 Audit loop documentation against current loop APIs, presets, state stores, CLI verbs, and deferred DBOS/Dolt decisions.
- [x] 4.4 Audit Agent Skills documentation against all three `skills/orca-ts-*` SKILL.md files and install commands.
- [x] 4.5 Audit examples and code snippets so public docs import from `orca-ts` and avoid internal runtime symbols.
- [x] 4.6 Remove or rewrite implementation-only material copied from `AGENTS.md` or archived OpenSpec notes.

## 5. Integration

- [x] 5.1 Reconcile subagent outputs into one coherent site with consistent terminology, tone, and navigation labels.
- [x] 5.2 Update README to remain concise and point users to the documentation website for deeper guides and reference.
- [x] 5.3 Update repository docs-link checking scope or add a website-aware link check so internal links are covered.
- [x] 5.4 Ensure docs-site dependencies and lockfiles are committed in the correct location.
- [x] 5.5 Ensure no site implementation changes runtime exports, backend adapters, CLI behavior, release artifacts, or skill semantics.

## 6. Visual QA Agent

- [x] 6.1 Run the docs site locally and capture desktop and mobile screenshots of the home page, quickstart, guide, reference, and troubleshooting pages.
- [x] 6.2 Verify sidebar navigation, table of contents, search, dark mode, code blocks, copyable commands, and base-path links.
- [x] 6.3 Fix text overflow, cramped code blocks, broken navigation, inaccessible contrast, and any mobile layout issues found during inspection.
- [x] 6.4 Verify the built site can be previewed from static output without missing assets.

## 7. Final Verification

- [x] 7.1 Run the docs-site build command.
- [x] 7.2 Run the internal documentation link check.
- [x] 7.3 Run `bun run verify` or explain why a narrower check is sufficient if full verification is not run.
- [x] 7.4 Run `openspec status --change add-docs-website` and confirm the change remains apply-ready.
- [x] 7.5 Summarize changed files, verification results, residual risks, and the GitHub Pages publish path.
