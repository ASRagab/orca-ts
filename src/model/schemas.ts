import { z } from "zod";

const TokenCountSchema = z.number().int().nonnegative();
const ExitCodeSchema = z.number().int().nullable();

export const BackendTagSchema = z.enum([
  "claude",
  "codex",
  "opencode",
  "pi"
]);

export const UsageSchema = z.object({
  input: TokenCountSchema,
  output: TokenCountSchema,
  reasoning: TokenCountSchema.optional()
});

export const AssistantTextDeltaSchema = z.object({
  type: z.literal("assistant_text_delta"),
  text: z.string()
});

export const AssistantTurnEndSchema = z.object({
  type: z.literal("assistant_turn_end")
});

export const AssistantThinkingDeltaSchema = z.object({
  type: z.literal("assistant_thinking_delta"),
  text: z.string()
});

export const AssistantToolCallSchema = z.object({
  type: z.literal("assistant_tool_call"),
  id: z.string(),
  name: z.string(),
  input: z.unknown()
});

export const ToolResultSchema = z.object({
  type: z.literal("tool_result"),
  toolCallId: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional()
});

export const ConversationErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string().optional(),
  message: z.string()
});

export const UserPromptSchema = z.object({
  type: z.literal("user_prompt"),
  text: z.string()
});

export const UserQuestionSchema = z.object({
  type: z.literal("user_question"),
  question: z.string()
});

export const ApproveToolSchema = z.object({
  type: z.literal("approve_tool"),
  toolCallId: z.string(),
  name: z.string(),
  input: z.unknown()
});

export const ConversationEventSchema = z.discriminatedUnion("type", [
  AssistantTextDeltaSchema,
  AssistantTurnEndSchema,
  AssistantThinkingDeltaSchema,
  AssistantToolCallSchema,
  ToolResultSchema,
  ConversationErrorSchema,
  UserPromptSchema,
  UserQuestionSchema,
  ApproveToolSchema
]);

export const StructuredResultEventSchema = z.object({
  type: z.literal("structured_result"),
  raw: z.unknown(),
  summary: z.string().optional()
});

export const ToolUseEventSchema = z.object({
  type: z.literal("tool_use"),
  name: z.string(),
  input: z.unknown()
});

export const AssistantMessageEventSchema = z.object({
  type: z.literal("assistant_message"),
  text: z.string()
});

export const TokensUsedEventSchema = z.object({
  type: z.literal("tokens_used"),
  usage: UsageSchema
});

export const StepEventSchema = z.object({
  type: z.literal("step"),
  name: z.string(),
  status: z.enum(["started", "completed", "failed"])
});

export const OrcaEventSchema = z.discriminatedUnion("type", [
  UserPromptSchema,
  ToolUseEventSchema,
  AssistantMessageEventSchema,
  TokensUsedEventSchema,
  StructuredResultEventSchema,
  StepEventSchema,
  ConversationErrorSchema
]);

export const LlmResultSchema = z.object({
  backend: BackendTagSchema,
  sessionId: z.string(),
  output: z.string(),
  structured: z.unknown().optional(),
  usage: UsageSchema.optional()
});

export const NothingToCommitErrorSchema = z.object({
  _tag: z.literal("NothingToCommit")
});

export const BranchAlreadyExistsErrorSchema = z.object({
  _tag: z.literal("BranchAlreadyExists"),
  branch: z.string()
});

export const PushRejectedErrorSchema = z.object({
  _tag: z.literal("PushRejected"),
  remote: z.string().optional(),
  stderr: z.string()
});

export const CommandFailedErrorSchema = z.object({
  _tag: z.literal("CommandFailed"),
  command: z.string(),
  exitCode: ExitCodeSchema,
  stdout: z.string(),
  stderr: z.string()
});

export const StructuredOutputValidationFailedErrorSchema = z.object({
  _tag: z.literal("StructuredOutputValidationFailed"),
  issues: z.array(z.string()),
  raw: z.unknown()
});

export const UnsupportedFeatureErrorSchema = z.object({
  _tag: z.literal("UnsupportedFeature"),
  feature: z.string(),
  reason: z.string()
});

export const BackendFailedErrorSchema = z.object({
  _tag: z.literal("BackendFailed"),
  backend: BackendTagSchema,
  message: z.string()
});

export const TypecheckFailedErrorSchema = z.object({
  _tag: z.literal("TypecheckFailed"),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: ExitCodeSchema
});

export const FileSystemErrorSchema = z.object({
  _tag: z.literal("FileSystemError"),
  path: z.string(),
  message: z.string()
});

// Runtime IO seams report failures here. `kind` is modelled as a plain string so this schema stays
// free of tool and loop-module dependencies (model must not import either).
export const IoFailedErrorSchema = z.object({
  _tag: z.literal("IoFailed"),
  seam: z.enum(["source", "sink", "tool"]),
  kind: z.string(),
  message: z.string()
});

export const RuntimeErrorSchema = z.discriminatedUnion("_tag", [
  NothingToCommitErrorSchema,
  BranchAlreadyExistsErrorSchema,
  PushRejectedErrorSchema,
  CommandFailedErrorSchema,
  StructuredOutputValidationFailedErrorSchema,
  UnsupportedFeatureErrorSchema,
  BackendFailedErrorSchema,
  TypecheckFailedErrorSchema,
  FileSystemErrorSchema,
  IoFailedErrorSchema
]);

export type BackendTag = z.infer<typeof BackendTagSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
export type OrcaEvent = z.infer<typeof OrcaEventSchema>;
export type LlmResult = z.infer<typeof LlmResultSchema>;
export type RuntimeError = z.infer<typeof RuntimeErrorSchema>;

export const CanonicalSchemas = {
  BackendTag: BackendTagSchema,
  Usage: UsageSchema,
  ConversationEvent: ConversationEventSchema,
  OrcaEvent: OrcaEventSchema,
  LlmResult: LlmResultSchema,
  RuntimeError: RuntimeErrorSchema
} as const;
