import { err, ok, type Result } from "neverthrow";

import { ioFailed, type RuntimeError } from "../model/index.ts";

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export type LinearAuth =
  | { readonly kind: "apiKey"; readonly token: string }
  | { readonly kind: "oauth"; readonly token: string };

export interface LinearGraphQLRequest {
  readonly endpoint: string;
  readonly query: string;
  readonly variables?: Record<string, unknown>;
  readonly headers: Record<string, string>;
  readonly operationName?: string;
}

export interface LinearGraphQLError {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly extensions?: Record<string, unknown>;
}

export interface LinearGraphQLResponse<TData = unknown> {
  readonly data?: TData | null;
  readonly errors?: readonly LinearGraphQLError[];
}

export type LinearGraphQLTransport = <TData = unknown>(
  request: LinearGraphQLRequest,
) => Promise<Result<LinearGraphQLResponse<TData>, RuntimeError>>;

export interface LinearTeamRef {
  readonly id: string;
  readonly key?: string | null;
  readonly name?: string | null;
}

export interface LinearProjectRef {
  readonly id: string;
  readonly name?: string | null;
}

export interface LinearWorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type?: string | null;
}

export interface LinearIssue {
  readonly id: string;
  readonly identifier?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly url?: string | null;
  readonly team?: LinearTeamRef | null;
  readonly project?: LinearProjectRef | null;
  readonly state?: LinearWorkflowState | null;
}

export interface LinearIssueUpdateInput {
  readonly issueId: string;
  readonly title?: string;
  readonly description?: string;
  readonly stateId?: string;
  readonly assigneeId?: string | null;
  readonly projectId?: string | null;
  readonly priority?: number | null;
  readonly labelIds?: readonly string[];
}

export interface LinearIssueComment {
  readonly id: string;
  readonly body?: string | null;
  readonly url?: string | null;
}

export interface LinearAgentActivity {
  readonly id: string;
  readonly type?: string | null;
  readonly body?: string | null;
}

export interface LinearExternalUrl {
  readonly label?: string;
  readonly url: string;
}

export interface LinearAgentSession {
  readonly id: string;
  readonly plan?: string | null;
  readonly externalUrl?: string | null;
  readonly externalUrls?: readonly LinearExternalUrl[];
}

export interface LinearAgentActivityInput {
  readonly agentSessionId: string;
  readonly type?: "action" | "response" | "error";
  readonly body: string;
  readonly metadata?: Record<string, unknown>;
}

export interface LinearAgentSessionUpdateInput {
  readonly agentSessionId: string;
  readonly plan?: string;
  readonly externalUrl?: string;
  readonly externalUrls?: readonly LinearExternalUrl[];
}

export interface LinearTool {
  fetchIssue(input: { readonly issueId: string }): Promise<Result<LinearIssue | null, RuntimeError>>;
  updateIssue(input: LinearIssueUpdateInput): Promise<Result<LinearIssue, RuntimeError>>;
  createIssueComment(input: {
    readonly issueId: string;
    readonly body: string;
  }): Promise<Result<LinearIssueComment, RuntimeError>>;
  createAgentActivity(input: LinearAgentActivityInput): Promise<Result<LinearAgentActivity, RuntimeError>>;
  updateAgentSession(input: LinearAgentSessionUpdateInput): Promise<Result<LinearAgentSession, RuntimeError>>;
  getTeamWorkflowStates(input: {
    readonly teamId: string;
  }): Promise<Result<readonly LinearWorkflowState[], RuntimeError>>;
}

export interface LinearToolOptions {
  readonly auth?: LinearAuth;
  readonly endpoint?: string;
  readonly transport?: LinearGraphQLTransport;
  readonly env?: Record<string, string | undefined>;
}

export function linearAuthFromEnv(env: Record<string, string | undefined> = process.env): LinearAuth | undefined {
  const oauth = env.LINEAR_ACCESS_TOKEN;
  if (oauth !== undefined && oauth.length > 0) {
    return { kind: "oauth", token: oauth };
  }
  const apiKey = env.LINEAR_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0) {
    return { kind: "apiKey", token: apiKey };
  }
  return undefined;
}

export function createFetchLinearGraphQLTransport(fetchImpl: typeof fetch = fetch): LinearGraphQLTransport {
  return async <TData>(request: LinearGraphQLRequest) => {
    try {
      const response = await fetchImpl(request.endpoint, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify({
          query: request.query,
          variables: request.variables ?? {},
          operationName: request.operationName,
        }),
      });
      const body = await response.text();
      if (!response.ok) {
        return err(linearFailed(`Linear GraphQL HTTP ${String(response.status)}: ${body}`));
      }
      return ok(JSON.parse(body) as LinearGraphQLResponse<TData>);
    } catch (error) {
      return err(linearFailed(`Linear GraphQL transport failed: ${String(error)}`));
    }
  };
}

export function createLinearTool(options: LinearToolOptions = {}): LinearTool {
  const auth = options.auth ?? linearAuthFromEnv(options.env);
  const endpoint = options.endpoint ?? DEFAULT_LINEAR_ENDPOINT;
  const transport = options.transport ?? createFetchLinearGraphQLTransport();
  const secrets = auth === undefined ? [] : [auth.token, authorizationHeader(auth)];

  async function execute<TData>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<Result<TData, RuntimeError>> {
    if (auth === undefined) {
      return err(linearFailed("Linear authentication is not configured"));
    }

    const sent = await transport<TData>({
      endpoint,
      query,
      variables,
      operationName,
      headers: {
        authorization: authorizationHeader(auth),
        "content-type": "application/json",
      },
    });
    if (sent.isErr()) {
      return err(redactRuntimeError(sent.error, secrets));
    }
    const response = sent.value;
    if (response.errors !== undefined && response.errors.length > 0) {
      const messages = response.errors.map((item) => item.message).join("; ");
      return err(linearFailed(redactSecrets(`Linear GraphQL ${operationName} failed: ${messages}`, secrets)));
    }
    return ok((response.data ?? {}) as TData);
  }

  return {
    async fetchIssue(input) {
      const result = await execute<{ readonly issue: LinearIssue | null }>(
        "Issue",
        `
          query Issue($id: String!) {
            issue(id: $id) {
              id
              identifier
              title
              description
              url
              team { id key name }
              project { id name }
              state { id name type }
            }
          }
        `,
        { id: input.issueId },
      );
      return result.map((data) => data.issue ?? null);
    },

    async updateIssue(input) {
      const result = await execute<{
        readonly issueUpdate?: { readonly success?: boolean; readonly issue?: LinearIssue | null } | null;
      }>(
        "IssueUpdate",
        `
          mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) {
              success
              issue {
                id
                identifier
                title
                description
                url
                team { id key name }
                project { id name }
                state { id name type }
              }
            }
          }
        `,
        { id: input.issueId, input: issueUpdateVariables(input) },
      );
      if (result.isErr()) return err(result.error);
      const issue = result.value.issueUpdate?.issue;
      if (issue === undefined || issue === null) {
        return err(linearFailed("Linear IssueUpdate did not return an issue"));
      }
      return ok(issue);
    },

    async createIssueComment(input) {
      const result = await execute<{
        readonly commentCreate?: { readonly success?: boolean; readonly comment?: LinearIssueComment | null } | null;
      }>(
        "CommentCreate",
        `
          mutation CommentCreate($input: CommentCreateInput!) {
            commentCreate(input: $input) {
              success
              comment { id body url }
            }
          }
        `,
        { input: { issueId: input.issueId, body: input.body } },
      );
      if (result.isErr()) return err(result.error);
      const comment = result.value.commentCreate?.comment;
      if (comment === undefined || comment === null) {
        return err(linearFailed("Linear CommentCreate did not return a comment"));
      }
      return ok(comment);
    },

    async createAgentActivity(input) {
      const result = await execute<{
        readonly agentActivityCreate?: {
          readonly success?: boolean;
          readonly agentActivity?: LinearAgentActivity | null;
        } | null;
      }>(
        "AgentActivityCreate",
        `
          mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
            agentActivityCreate(input: $input) {
              success
              agentActivity { id type body }
            }
          }
        `,
        {
          input: {
            agentSessionId: input.agentSessionId,
            body: input.body,
            type: input.type ?? "response",
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          },
        },
      );
      if (result.isErr()) return err(result.error);
      const activity = result.value.agentActivityCreate?.agentActivity;
      if (activity === undefined || activity === null) {
        return err(linearFailed("Linear AgentActivityCreate did not return an activity"));
      }
      return ok(activity);
    },

    async updateAgentSession(input) {
      const result = await execute<{
        readonly agentSessionUpdate?: {
          readonly success?: boolean;
          readonly agentSession?: LinearAgentSession | null;
        } | null;
      }>(
        "AgentSessionUpdate",
        `
          mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
            agentSessionUpdate(id: $id, input: $input) {
              success
              agentSession { id plan externalUrl externalUrls { label url } }
            }
          }
        `,
        { id: input.agentSessionId, input: agentSessionUpdateVariables(input) },
      );
      if (result.isErr()) return err(result.error);
      const session = result.value.agentSessionUpdate?.agentSession;
      if (session === undefined || session === null) {
        return err(linearFailed("Linear AgentSessionUpdate did not return a session"));
      }
      return ok(session);
    },

    async getTeamWorkflowStates(input) {
      const result = await execute<{
        readonly team?: {
          readonly states?: { readonly nodes?: readonly LinearWorkflowState[] | null } | null;
        } | null;
      }>(
        "TeamWorkflowStates",
        `
          query TeamWorkflowStates($id: String!) {
            team(id: $id) {
              states {
                nodes { id name type }
              }
            }
          }
        `,
        { id: input.teamId },
      );
      return result.map((data) => data.team?.states?.nodes ?? []);
    },
  };
}

function issueUpdateVariables(input: LinearIssueUpdateInput): Record<string, unknown> {
  return pruneUndefined({
    title: input.title,
    description: input.description,
    stateId: input.stateId,
    assigneeId: input.assigneeId,
    projectId: input.projectId,
    priority: input.priority,
    labelIds: input.labelIds,
  });
}

function agentSessionUpdateVariables(input: LinearAgentSessionUpdateInput): Record<string, unknown> {
  return pruneUndefined({
    plan: input.plan,
    externalUrl: input.externalUrl,
    externalUrls: input.externalUrls,
  });
}

function pruneUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function authorizationHeader(auth: LinearAuth): string {
  return auth.kind === "oauth" ? `Bearer ${auth.token}` : auth.token;
}

function linearFailed(message: string): RuntimeError {
  return ioFailed("tool", "linear", message);
}

function redactRuntimeError(error: RuntimeError, secrets: readonly string[]): RuntimeError {
  switch (error._tag) {
    case "IoFailed":
      return { ...error, message: redactSecrets(error.message, secrets) };
    case "BackendFailed":
      return { ...error, message: redactSecrets(error.message, secrets) };
    case "CommandFailed":
      return {
        ...error,
        command: redactSecrets(error.command, secrets),
        stdout: redactSecrets(error.stdout, secrets),
        stderr: redactSecrets(error.stderr, secrets),
      };
    case "FileSystemError":
      return { ...error, message: redactSecrets(error.message, secrets), path: redactSecrets(error.path, secrets) };
    case "StructuredOutputValidationFailed":
    case "TypecheckFailed":
    case "UnsupportedFeature":
    case "NothingToCommit":
    case "BranchAlreadyExists":
    case "PushRejected":
      return error;
  }
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted;
}
