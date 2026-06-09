import type { AutonomousRequest, LlmBackend } from "./types.ts";
import {
  runCodexConversation,
  type CodexBackendOptions,
  type CodexProcess
} from "./codex-run.ts";
import { StreamConversation } from "../conversation/index.ts";

export type {
  CodexBackendOptions,
  CodexProcess,
  CodexProcessSpawner
} from "./codex-run.ts";

export function codex(options: CodexBackendOptions = {}): LlmBackend<"codex"> {
  return {
    tag: "codex",
    autonomous<Output = unknown>(request: AutonomousRequest<Output, "codex">) {
      let child: CodexProcess | undefined;
      const interactive = request.config?.interactive ?? options.config?.interactive ?? false;
      const conversation = new StreamConversation({
        backend: "codex",
        capacity: options.capacity ?? 256,
        canAskUser: interactive,
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
