import type { z } from "zod";
import type { Conversation } from "../conversation/index.ts";
import type { BackendConfig, BackendTag } from "../model/index.ts";
export type {
  BackendApprovalPolicy,
  BackendConfig,
  BackendResult,
  BackendRetryConfig,
  BackendSandboxMode,
  StructuredOutputConfig
} from "../model/index.ts";

export interface AutonomousRequest<Output = unknown, B extends BackendTag = BackendTag> {
  readonly prompt: string;
  readonly schema?: z.ZodType<Output>;
  readonly config?: BackendConfig<B, Output>;
}

export interface LlmBackend<B extends BackendTag = BackendTag> {
  readonly tag: B;
  autonomous<Output = unknown>(request: AutonomousRequest<Output, B>): Conversation<B>;
}

export interface LlmTool {
  autonomous<B extends BackendTag, Output = unknown>(
    backend: LlmBackend<B>,
    request: AutonomousRequest<Output, B>
  ): Conversation<B>;
}
