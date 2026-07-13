import { BackendTagSchema, type BackendConfig, type BackendTag } from "../model/index.ts";
import { claude } from "./claude-run.ts";
import { codex } from "./codex.ts";
import { opencode } from "./opencode-run.ts";
import { pi } from "./pi-run.ts";
import type { LlmBackend } from "./types.ts";

export type PortableBackendConfig = Omit<
  BackendConfig,
  "reasoningEffort" | "resumeSessionId" | "structuredOutput"
>;

export interface SelectBackendOptions {
  readonly default: BackendTag;
  readonly config?: PortableBackendConfig;
  readonly perBackend?: Partial<Record<BackendTag, PortableBackendConfig>>;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SelectedBackend {
  readonly tag: BackendTag;
  readonly backend: LlmBackend;
  readonly model?: string;
  readonly shutdown?: () => Promise<void>;
}

export function selectBackend(options: SelectBackendOptions): SelectedBackend {
  const env = options.env ?? process.env;
  const raw = env.ORCA_BACKEND;
  const candidate = raw === undefined || raw === "" ? options.default : raw;
  const parsed = BackendTagSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Unsupported backend "${candidate}" (expected one of: ${BackendTagSchema.options.join(", ")})`
    );
  }

  const tag = parsed.data;
  const mergedConfig: PortableBackendConfig = {
    ...(options.config ?? {}),
    ...(options.perBackend?.[tag] ?? {})
  };
  const model = env.ORCA_BACKEND_MODEL === undefined || env.ORCA_BACKEND_MODEL === ""
    ? mergedConfig.model
    : env.ORCA_BACKEND_MODEL;
  const config: PortableBackendConfig = {
    ...mergedConfig,
    ...(model === undefined ? {} : { model })
  };

  switch (tag) {
    case "claude":
      return {
        tag,
        backend: claude({ config }),
        ...(model === undefined ? {} : { model })
      };
    case "codex":
      return {
        tag,
        backend: codex({ config }),
        ...(model === undefined ? {} : { model })
      };
    case "opencode": {
      const backend = opencode({ config });
      return {
        tag,
        backend,
        ...(model === undefined ? {} : { model }),
        shutdown: () => backend.shutdown()
      };
    }
    case "pi":
      return {
        tag,
        backend: pi({ config }),
        ...(model === undefined ? {} : { model })
      };
  }
}
