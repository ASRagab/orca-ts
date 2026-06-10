import type { z } from "zod";

export interface SharedBackendConfig<Output> {
  model?: string;
  systemPrompt?: string;
  readOnly?: boolean;
  selfManagedGit?: boolean;
  retryAttempts?: number;
  schema?: z.ZodType<Output>;
  resumeSessionId?: string;
}

export function composeBackendPrompt(prompt: string, config: SharedBackendConfig<unknown>): string {
  return [
    config.systemPrompt ? `System instructions:\n${config.systemPrompt}` : "",
    config.selfManagedGit === false
      ? "Git policy: Orca is the parent runtime. Do not create commits, branches, pushes, or pull requests; leave repository mutation to the parent workflow."
      : "",
    config.retryAttempts === undefined
      ? ""
      : `Retry policy: maximum attempts ${String(config.retryAttempts)}.`,
    prompt
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}
