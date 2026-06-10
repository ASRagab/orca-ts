export interface ToolApprovalRequest {
  readonly toolName: string;
  readonly input: unknown;
}

export function requestToolApproval(request: ToolApprovalRequest): never {
  throw new Error(
    `Tool approval for ${request.toolName} is intentionally unsupported in v1`
  );
}
