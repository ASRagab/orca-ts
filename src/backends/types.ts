import type { z } from "zod";
import type { Conversation } from "../conversation/index.ts";
import type { BackendTag, LlmResult } from "../model/index.ts";

export interface AutonomousRequest<Output = unknown> {
  readonly prompt: string;
  readonly schema?: z.ZodType<Output>;
}

export interface LlmBackend<B extends BackendTag = BackendTag> {
  readonly tag: B;
  autonomous<Output = unknown>(request: AutonomousRequest<Output>): Conversation<B>;
}

export interface LlmTool {
  autonomous<B extends BackendTag, Output = unknown>(
    backend: LlmBackend<B>,
    request: AutonomousRequest<Output>
  ): Conversation<B>;
}

export type BackendResult<B extends BackendTag> = LlmResult & { readonly backend: B };
