import type { z } from "zod";
import type { BackendTag, LlmResult } from "./schemas.ts";
import type { SessionId } from "./brand.ts";

export type BackendApprovalPolicy = "auto" | "never" | "on-request";
export type BackendSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface BackendRetryConfig {
  readonly attempts: number;
}

export interface StructuredOutputConfig<Output = unknown> {
  readonly schema: z.ZodType<Output>;
  readonly name?: string;
  readonly description?: string;
}

export interface BackendConfig<B extends BackendTag = BackendTag, Output = unknown> {
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly approvalPolicy?: BackendApprovalPolicy;
  readonly readOnly?: boolean;
  readonly sandbox?: BackendSandboxMode;
  readonly selfManagedGit?: boolean;
  readonly retry?: BackendRetryConfig;
  readonly structuredOutput?: StructuredOutputConfig<Output>;
  readonly resumeSessionId?: SessionId<B>;
  readonly interactive?: boolean;
}

export type BackendResult<B extends BackendTag> = Omit<LlmResult, "backend" | "sessionId"> & {
  readonly backend: B;
  readonly sessionId: SessionId<B>;
};
