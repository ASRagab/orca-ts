import type { AutonomousRequest, LlmBackend } from "./types.ts";
import {
  codexAcpCommand,
  experimentalAcpBackendEnabled,
  runAcpConversation
} from "./acp-run.ts";
import {
  resolveCodexConfig,
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
      let cancelAcp: (() => Promise<void>) | undefined;
      const useAcp = experimentalAcpBackendEnabled("codex");
      const conversation = new StreamConversation({
        backend: "codex",
        capacity: options.capacity ?? 256,
        canAskUser: request.config?.interactive ?? options.config?.interactive ?? false,
        onCancel: async () => {
          if (useAcp && cancelAcp) {
            await cancelAcp();
            return;
          }
          child?.kill("SIGTERM");
        }
      });

      queueMicrotask(() => {
        if (conversation.signal.aborted) {
          return;
        }
        if (useAcp) {
          const acp = codexAcpCommand();
          const config = resolveCodexConfig(request, options);
          void runAcpConversation(
            request,
            {
              backend: "codex",
              command: acp.command,
              args: acp.args,
              config,
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options.env === undefined ? {} : { env: options.env }),
              ...(options.wallClockTimeoutMs === undefined ? {} : { requestTimeoutMs: options.wallClockTimeoutMs }),
              ...(options.inactivityTimeoutMs === undefined ? {} : { inactivityTimeoutMs: options.inactivityTimeoutMs }),
              setProcess: (process) => {
                child = process;
                if (conversation.signal.aborted) {
                  process.kill("SIGTERM");
                }
              },
              setCancel: (cancel) => {
                cancelAcp = cancel;
              }
            },
            conversation
          );
          return;
        }
        void runCodexConversation(request, options, conversation, (process) => {
          child = process;
          if (conversation.signal.aborted) {
            process.kill("SIGTERM");
          }
        });
      });

      return conversation;
    }
  };
}
