import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "neverthrow";

import { ioFailed, type RuntimeError } from "../../model/index.ts";
import { createGitHubTool, type GitHubTool } from "../../tools/index.ts";

// Sink = the loop-level output boundary (spec loop-io, design D8). A Sink emits a typed output and
// returns a `Result`; an emit failure surfaces as `err(RuntimeError)`, never a thrown exception. A
// custom output implements only `Sink` — no engine change.

/** Bundled sink kinds. A custom output reuses the closest kind or its own structural object. */
export type SinkKind = "pr" | "file" | "slack" | "queue" | "stdout" | "linear-issue" | "linear-agent";

/** A loop output — the only loop-level emit boundary; Result-typed. */
export interface Sink<A = unknown> {
  readonly kind: SinkKind;
  emit(output: A): Promise<Result<void, RuntimeError>>;
}

/** Default rendering: strings pass through; everything else is pretty JSON. */
function renderOutput<A>(output: A, format?: (output: A) => string): string {
  if (format !== undefined) {
    return format(output);
  }
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

// --- stdout: write the rendered output to a stream (default process.stdout). ---

export interface StdoutOptions<A> {
  readonly format?: (output: A) => string;
  /** Write target; default: process.stdout. Injectable for tests. */
  readonly write?: (text: string) => void;
}

export function stdout<A = unknown>(options: StdoutOptions<A> = {}): Sink<A> {
  const write =
    options.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  return {
    kind: "stdout",
    emit(output) {
      try {
        const text = renderOutput(output, options.format);
        write(text.endsWith("\n") ? text : `${text}\n`);
        return Promise.resolve(ok(undefined));
      } catch (error) {
        return Promise.resolve(err(ioFailed("sink", "stdout", String(error))));
      }
    },
  };
}

// --- file: write the rendered output to a path (FileSystemError on failure, mirroring FsTool). ---

export interface FileSinkOptions<A> {
  readonly path: string;
  readonly format?: (output: A) => string;
}

export function file<A = unknown>(options: FileSinkOptions<A>): Sink<A> {
  return {
    kind: "file",
    async emit(output) {
      try {
        await mkdir(dirname(options.path), { recursive: true });
        await writeFile(options.path, renderOutput(output, options.format));
        return ok(undefined);
      } catch (error) {
        return err({ _tag: "FileSystemError", path: options.path, message: String(error) });
      }
    },
  };
}

// --- pr: write the rendered output to a body file, then open a PR via the gh CLI tool. ---

export interface PrSinkOptions<A> {
  readonly title: string;
  readonly base?: string;
  /** Body file written before `gh pr create --body-file`; default: a tmpdir file. */
  readonly bodyFile?: string;
  readonly format?: (output: A) => string;
  /** GitHub client; default: the repo gh CLI tool. Injectable for tests. */
  readonly gh?: GitHubTool;
}

export function pr<A = unknown>(options: PrSinkOptions<A>): Sink<A> {
  return {
    kind: "pr",
    async emit(output) {
      const gh = options.gh ?? createGitHubTool(process.cwd());
      const bodyFile = options.bodyFile ?? join(tmpdir(), `orca-pr-body-${String(Date.now())}.md`);
      try {
        await mkdir(dirname(bodyFile), { recursive: true });
        await writeFile(bodyFile, renderOutput(output, options.format));
      } catch (error) {
        return err({ _tag: "FileSystemError", path: bodyFile, message: String(error) });
      }
      const created = await gh.createPullRequest({
        title: options.title,
        bodyFile,
        ...(options.base === undefined ? {} : { base: options.base }),
      });
      return created.map(() => undefined);
    },
  };
}

// --- slack: POST the rendered output to a Slack incoming webhook; the post fn is injectable. ---

/** POSTs `body` to `url`; resolves to `ok` on a 2xx, `err(RuntimeError)` otherwise. */
export type SlackPost = (url: string, body: string) => Promise<Result<void, RuntimeError>>;

const defaultSlackPost: SlackPost = async (url, body) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    if (!response.ok) {
      return err(ioFailed("sink", "slack", `slack webhook returned HTTP ${String(response.status)}`));
    }
    return ok(undefined);
  } catch (error) {
    return err(ioFailed("sink", "slack", String(error)));
  }
};

export interface SlackOptions<A> {
  readonly webhookUrl: string;
  readonly format?: (output: A) => string;
  readonly post?: SlackPost;
}

export function slack<A = unknown>(options: SlackOptions<A>): Sink<A> {
  const post = options.post ?? defaultSlackPost;
  return {
    kind: "slack",
    emit(output) {
      return post(options.webhookUrl, renderOutput(output, options.format));
    },
  };
}

// --- queue: broker-backed output. There is no in-repo broker, so the producer is injected (the ---
// --- bundled Sink is the seam adapter). Exported as `queueSink` because the Source also ships a ---
// --- `queue`; the two factories cannot share a bare name across the io surface. ---

export interface QueueProducer<A> {
  push(message: A): Promise<Result<void, RuntimeError>>;
}

export interface QueueSinkOptions<A> {
  readonly producer: QueueProducer<A>;
}

export function queueSink<A = unknown>(options: QueueSinkOptions<A>): Sink<A> {
  return {
    kind: "queue",
    emit(output) {
      return options.producer.push(output);
    },
  };
}
