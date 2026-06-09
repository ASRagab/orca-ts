import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const ReviewerIds = [
  "code-functionality",
  "test",
  "readability",
  "code-structure",
  "simplicity",
  "performance",
  "security",
  "scala-fp"
] as const;

export type ReviewerId = (typeof ReviewerIds)[number];

export interface ReviewerPrompt {
  readonly id: ReviewerId;
  readonly name?: string;
  readonly description?: string;
  readonly files?: string;
  readonly prompt: string;
}

export async function loadReviewerPrompts(
  root = join(process.cwd(), "src", "review", "prompts", "reviewers")
): Promise<ReviewerPrompt[]> {
  return await Promise.all(
    ReviewerIds.map(async (id) => {
      const content = await readFile(join(root, `${id}.md`), "utf8");
      return parseReviewerPrompt(id, content);
    })
  );
}

export function selectReviewers(
  prompts: readonly ReviewerPrompt[],
  requested: readonly ReviewerId[] = ["code-functionality", "readability", "test"]
): ReviewerPrompt[] {
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  return requested.map((id) => {
    const prompt = byId.get(id);
    if (!prompt) {
      throw new Error(`Reviewer prompt not loaded: ${id}`);
    }
    return prompt;
  });
}

export function parseReviewerPrompt(id: ReviewerId, content: string): ReviewerPrompt {
  if (!content.startsWith("---\n")) {
    return { id, prompt: content };
  }

  const end = content.indexOf("\n---\n", 4);
  if (end === -1) {
    return { id, prompt: content };
  }

  const frontmatter = content.slice(4, end);
  const prompt = content.slice(end + 5).replace(/^\n/, "");
  const metadata: {
    name?: string;
    description?: string;
    files?: string;
  } = {};
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2] ?? "";
    if (key === "name" || key === "description" || key === "files") {
      metadata[key] = value;
    }
  }

  return {
    id,
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.files === undefined ? {} : { files: metadata.files }),
    prompt
  };
}
