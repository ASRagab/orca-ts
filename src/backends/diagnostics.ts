import { activeRunReporter } from "../run-output/index.ts";
import type { BackendTag } from "../model/index.ts";

export function activeArtifactPath(fallback?: string): string {
  const started = activeRunReporter()
    ?.events()
    .findLast((event) => event.type === "run_started" && event.label !== undefined);
  return started?.type === "run_started" && started.label !== undefined
    ? started.label
    : fallback ?? process.cwd();
}

export function backendRecovery(backend: BackendTag, transport: string): string {
  if (backend === "claude") {
    return transport === "acp" ? "claude-agent-acp --version" : "claude --version";
  }
  return `${backend} --version`;
}
