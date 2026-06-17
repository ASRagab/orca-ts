// Doc link checker — offline, deterministic, dependency-free (no network).
// Verifies internal links in the repo's prose docs:
//   - relative file links ([x](docs/foo.md), [x](../LICENSE)) resolve on disk
//   - intra/cross-doc anchors ([x](#heading), [x](other.md#heading)) match a
//     real heading slug in the target file (GitHub-style slug)
//   - website content links use generated site routes instead of source .md paths
//   - generated website links resolve under website/dist when the site has been built
// External links (http/https/mailto/protocol-relative) and pure in-page links
// to non-doc targets are intentionally NOT fetched — CI must stay offline.
//
// Usage:
//   bun run scripts/check-doc-links.ts                 # default doc set
//   bun run scripts/check-doc-links.ts README.md docs/backends.md
// Exits 0 when all internal links resolve, 1 otherwise.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

function markdownFilesUnder(dir: string): string[] {
  const absolute = resolve(process.cwd(), dir);
  if (!existsSync(absolute)) return [];

  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const child = join(absolute, entry);
    const stat = statSync(child);
    if (stat.isDirectory()) {
      files.push(...markdownFilesUnder(child.slice(process.cwd().length + 1)));
    } else if (/\.(md|mdx)$/.test(child)) {
      files.push(child.slice(process.cwd().length + 1));
    }
  }
  return files.sort();
}

const DEFAULT_DOCS = [
  "README.md",
  "AGENTS.md",
  "CONTEXT.md",
  ...markdownFilesUnder("docs"),
  ...markdownFilesUnder("website/src/content/docs")
];

const root = process.cwd();
const argDocs = process.argv.slice(2);
const docs = (argDocs.length > 0 ? argDocs : DEFAULT_DOCS).filter((d) => existsSync(resolve(root, d)));
const websiteDocsRoot = "website/src/content/docs";

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

function websiteRouteForDoc(doc: string): string | undefined {
  if (!doc.startsWith(`${websiteDocsRoot}/`)) return undefined;
  const withoutRoot = doc.slice(websiteDocsRoot.length + 1).replace(/\.(md|mdx)$/, "");
  if (withoutRoot === "index") return "/";
  return `/${withoutRoot}/`;
}

function websiteDocForRoute(route: string): string | undefined {
  const normalized = route.replace(/^\/+|\/+$/g, "");
  const candidates =
    normalized.length === 0
      ? [join(websiteDocsRoot, "index.md"), join(websiteDocsRoot, "index.mdx")]
      : [
          join(websiteDocsRoot, `${normalized}.md`),
          join(websiteDocsRoot, `${normalized}.mdx`),
          join(websiteDocsRoot, normalized, "index.md"),
          join(websiteDocsRoot, normalized, "index.mdx")
        ];
  return candidates.find((candidate) => existsSync(resolve(root, candidate)));
}

function resolveWebsiteDocTarget(doc: string, target: string): string | undefined {
  const sourceRoute = websiteRouteForDoc(doc);
  if (!sourceRoute) return undefined;
  const resolved = new URL(target, `https://docs.local${sourceRoute}`).pathname;
  return websiteDocForRoute(resolved);
}

function parseSiteBase(): string {
  const configPath = resolve(root, "website/astro.config.mjs");
  if (!existsSync(configPath)) return "/";
  const config = readFileSync(configPath, "utf8");
  const match = /base:\s*["']([^"']+)["']/.exec(config);
  if (!match?.[1]) return "/";
  return match[1].startsWith("/") ? match[1].replace(/\/$/, "") : `/${match[1].replace(/\/$/, "")}`;
}

function htmlFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const child = join(dir, entry);
    const stat = statSync(child);
    if (stat.isDirectory()) {
      files.push(...htmlFilesUnder(child));
    } else if (child.endsWith(".html")) {
      files.push(child);
    }
  }
  return files.sort();
}

function hrefTargets(html: string): string[] {
  const targets: string[] = [];
  const re = /<a\b[^>]*\bhref=(["'])(.*?)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[2]) targets.push(m[2].replace(/&amp;/g, "&"));
  }
  return targets;
}

function pagePathForHtml(htmlFile: string, siteDist: string, siteBase: string): string {
  const rel = relative(siteDist, htmlFile).split(sep).join("/");
  if (rel === "index.html") return `${siteBase}/`;
  if (rel.endsWith("/index.html")) return `${siteBase}/${rel.slice(0, -"index.html".length)}`;
  return `${siteBase}/${rel}`;
}

function distFileForPathname(siteDist: string, siteBase: string, pathname: string): string | undefined {
  const baseWithSlash = siteBase === "/" ? "/" : `${siteBase}/`;
  if (pathname !== siteBase && !pathname.startsWith(baseWithSlash)) return undefined;

  const rel = pathname === siteBase ? "" : pathname.slice(baseWithSlash.length);
  const candidates = rel.length === 0 || rel.endsWith("/")
    ? [join(siteDist, rel, "index.html")]
    : [join(siteDist, rel), join(siteDist, rel, "index.html")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function htmlHasAnchor(htmlFile: string, anchor: string): boolean {
  if (anchor.length === 0) return true;
  const html = readFileSync(htmlFile, "utf8");
  const decoded = decodeURIComponent(anchor);
  const anchorRe = new RegExp(`\\b(?:id|name)=["']${escapeRegExp(decoded)}["']`);
  return anchorRe.test(html);
}

function checkRepoEditLink(htmlRel: string, target: string): void {
  const prefix = "https://github.com/ASRagab/orca-ts/edit/main/";
  if (!target.startsWith(prefix)) return;
  const repoPath = target.slice(prefix.length).split(/[?#]/, 1)[0] ?? "";
  if (!existsSync(resolve(root, repoPath))) {
    failures.push(`${htmlRel}: edit link "${target}" points at missing repo file ${repoPath}`);
  }
}

function checkBuiltSiteLinks(): void {
  const siteDist = resolve(root, "website/dist");
  if (!existsSync(siteDist)) return;

  const siteBase = parseSiteBase();
  const siteOrigin = "https://docs.local";
  for (const htmlFile of htmlFilesUnder(siteDist)) {
    const htmlRel = relative(root, htmlFile);
    const pagePath = pagePathForHtml(htmlFile, siteDist, siteBase);
    const html = readFileSync(htmlFile, "utf8");

    for (const target of hrefTargets(html)) {
      checkRepoEditLink(htmlRel, target);
      if (EXTERNAL.test(target)) continue;

      const url = new URL(target, `${siteOrigin}${pagePath}`);
      const targetFile = distFileForPathname(siteDist, siteBase, url.pathname);
      if (!targetFile) {
        failures.push(`${htmlRel}: generated link "${target}" resolves outside site base ${siteBase}`);
        continue;
      }
      if (!existsSync(targetFile)) {
        failures.push(`${htmlRel}: generated link "${target}" resolves to missing site path ${url.pathname}`);
        continue;
      }
      if (url.hash && extname(targetFile) === ".html" && !htmlHasAnchor(targetFile, url.hash.slice(1))) {
        failures.push(`${htmlRel}: generated link "${target}" points at missing anchor ${url.hash}`);
      }
    }
  }
}

for (const doc of docs) {
  const docPath = resolve(root, doc);
  const markdown = readFileSync(docPath, "utf8");
  const docDir = dirname(docPath);

  for (const target of linkTargets(markdown)) {
    if (EXTERNAL.test(target)) continue; // external — not our job to fetch

    const [filePart, anchor] = target.split("#", 2);

    if (filePart) {
      if (websiteRouteForDoc(doc) && /\.(md|mdx)$/.test(filePart)) {
        failures.push(`${doc}: website docs must link to generated routes, not source file "${target}"`);
        continue;
      }
      const websiteTarget = resolveWebsiteDocTarget(doc, filePart);
      if (websiteTarget) {
        if (anchor && !slugsFor(resolve(root, websiteTarget)).has(anchor.toLowerCase())) {
          failures.push(`${doc}: link "${target}" points at a missing heading "#${anchor}"`);
        }
        continue;
      }

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

checkBuiltSiteLinks();

if (failures.length > 0) {
  console.error(`✖ doc link check failed (${String(failures.length)} issue(s)):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`✓ doc links OK (${String(docs.length)} file(s) checked)`);
