// Doc link checker — offline, deterministic, dependency-free (no network).
// Verifies internal links in the repo's prose docs:
//   - relative file links ([x](docs/foo.md), [x](../LICENSE)) resolve on disk
//   - intra/cross-doc anchors ([x](#heading), [x](other.md#heading)) match a
//     real heading slug in the target file (GitHub-style slug)
// External links (http/https/mailto/protocol-relative) and pure in-page links
// to non-doc targets are intentionally NOT fetched — CI must stay offline.
//
// Usage:
//   bun run scripts/check-doc-links.ts                 # default doc set
//   bun run scripts/check-doc-links.ts README.md docs/backends.md
// Exits 0 when all internal links resolve, 1 otherwise.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Default scope mirrors the doc-refresh workflow's tracked doc set.
const DEFAULT_DOCS = [
  "README.md",
  "AGENTS.md",
  "CONTEXT.md",
  "docs/backends.md",
  "docs/distribution.md",
  "docs/parity.md",
  "docs/plans.md",
  "docs/release.md",
  "docs/review.md",
];

const root = process.cwd();
const argDocs = process.argv.slice(2);
const docs = (argDocs.length > 0 ? argDocs : DEFAULT_DOCS).filter((d) => existsSync(resolve(root, d)));

// GitHub-flavored heading slug: lowercase, drop chars that aren't word/space/hyphen,
// collapse spaces to hyphens. Duplicate headings get -1, -2, … suffixes.
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m?.[1]) continue;
    const base = slugify(m[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.add(seen === 0 ? base : `${base}-${String(seen)}`);
  }
  return slugs;
}

// Pull [text](target) link targets, skipping fenced code and inline code.
function linkTargets(markdown: string): string[] {
  const targets: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const stripped = line.replace(/`[^`]*`/g, ""); // drop inline code spans
    const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      if (m[1]) targets.push(m[1]);
    }
  }
  return targets;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i; // scheme: or protocol-relative //

const slugCache = new Map<string, Set<string>>();
function slugsFor(path: string): Set<string> {
  let s = slugCache.get(path);
  if (!s) {
    s = headingSlugs(readFileSync(path, "utf8"));
    slugCache.set(path, s);
  }
  return s;
}

const failures: string[] = [];

for (const doc of docs) {
  const docPath = resolve(root, doc);
  const markdown = readFileSync(docPath, "utf8");
  const docDir = dirname(docPath);

  for (const target of linkTargets(markdown)) {
    if (EXTERNAL.test(target)) continue; // external — not our job to fetch

    const [filePart, anchor] = target.split("#", 2);

    if (filePart) {
      const resolved = join(docDir, filePart);
      if (!existsSync(resolved)) {
        failures.push(`${doc}: broken link target "${target}" (no file at ${resolved})`);
        continue;
      }
      if (anchor && resolved.endsWith(".md") && !slugsFor(resolved).has(anchor.toLowerCase())) {
        failures.push(`${doc}: link "${target}" points at a missing heading "#${anchor}"`);
      }
    } else if (anchor) {
      // Pure in-page anchor: [x](#heading)
      if (!slugsFor(docPath).has(anchor.toLowerCase())) {
        failures.push(`${doc}: in-page anchor "#${anchor}" has no matching heading`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`✖ doc link check failed (${String(failures.length)} issue(s)):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`✓ doc links OK (${String(docs.length)} file(s) checked)`);
