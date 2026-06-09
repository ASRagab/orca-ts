import { unsupportedFeature } from "../model/index.ts";

export interface ToolApprovalRequest {
  readonly toolName: string;
  readonly input: unknown;
}

export function requestToolApproval(_request: ToolApprovalRequest): never {
  throw unsupportedFeature(
    "tool approval",
    "Live human approval prompts are intentionally unsupported in v1"
  );
}
