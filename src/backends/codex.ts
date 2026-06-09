import { spawn } from "node:child_process";
import type { AutonomousRequest, LlmBackend } from "./types.ts";
import {
  codexExecJsonlArgs,
  createCodexJsonlConsumer,
  type CodexExecArgs
} from "./codex-jsonl.ts";
import { StreamConversation } from "../conversation/index.ts";
import { backendFailed } from "../model/index.ts";

export interface CodexBackendOptions extends Omit<CodexExecArgs, "prompt"> {
  readonly command?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly capacity?: number;
  readonly spawnProcess?: CodexProcessSpawner;
}

export interface CodexProcess {
  readonly stdout: AsyncIterable<string | Uint8Array>;
  readonly stderr?: AsyncIterable<string | Uint8Array>;
  readonly exit: Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
}

export type CodexProcessSpawner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
) => CodexProcess;

export function codex(options: CodexBackendOptions = {}): LlmBackend<"codex"> {
  return {
    tag: "codex",
    autonomous<Output = unknown>(request: AutonomousRequest<Output>) {
      let child: CodexProcess | undefined;
      const conversation = new StreamConversation({
        backend: "codex",
        capacity: options.capacity ?? 256,
        onCancel: () => {
          child?.kill("SIGTERM");
        }
      });

      queueMicrotask(() => {
        void runCodexConversation(request, options, conversation, (process) => {
          child = process;
        });
      });

      return conversation;
    }
  };
}

async function runCodexConversation<Output>(
  request: AutonomousRequest<Output>,
  options: CodexBackendOptions,
  conversation: StreamConversation<"codex">,
  setProcess: (process: CodexProcess) => void
): Promise<void> {
  if (request.schema) {
    conversation.fail(backendFailed("codex", "Codex structured schema output is not implemented in v1"));
    return;
  }

  const command = options.command ?? "codex";
  const args = codexExecJsonlArgs({
    prompt: request.prompt,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.approvalPolicy !== undefined ? { approvalPolicy: options.approvalPolicy } : {})
  });

  try {
    const processOptions: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
    if (options.cwd !== undefined) {
      processOptions.cwd = options.cwd;
    }
    if (options.env !== undefined) {
      processOptions.env = options.env;
    }
    const process = (options.spawnProcess ?? spawnCodexProcess)(command, args, processOptions);
    setProcess(process);

    const stderr = collectText(process.stderr);
    const consumer = createCodexJsonlConsumer(conversation);

    for await (const line of splitLines(process.stdout)) {
      if (conversation.signal.aborted) {
        return;
      }
      await consumer.consume(line);
    }

    const exitCode = await process.exit;
    const stderrText = (await stderr).trim();
    if (conversation.signal.aborted) {
      return;
    }

    if (exitCode !== 0) {
      const exitCodeText = exitCode === null ? "unknown" : String(exitCode);
      conversation.fail(
        backendFailed(
          "codex",
          `codex exited with code ${exitCodeText}${stderrText ? `: ${stderrText}` : ""}`
        )
      );
      return;
    }

    consumer.finish();
  } catch (error) {
    if (!conversation.signal.aborted) {
      conversation.fail(backendFailed("codex", errorMessage(error)));
    }
  }
}

function spawnCodexProcess(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
): CodexProcess {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exit: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    }),
    kill(signal?: NodeJS.Signals) {
      child.kill(signal);
    }
  };
}

async function* splitLines(
  chunks: AsyncIterable<string | Uint8Array>
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      yield line;
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer.replace(/\r$/, "");
  }
}

async function collectText(chunks: AsyncIterable<string | Uint8Array> | undefined): Promise<string> {
  if (!chunks) {
    return "";
  }

  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of chunks) {
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
