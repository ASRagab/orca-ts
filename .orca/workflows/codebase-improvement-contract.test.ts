import { runInNewContext } from "node:vm";
import { renameSync, rmSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import * as ts from "typescript";
import {
  assertMergedPullRequestState,
  assertReadyPullRequestHead,
  DeliveryRecordSchema,
  remoteCheckState,
  type PullRequestIdentity,
} from "./codebase-improvement-lib.ts";
import {
  ConversationTimeoutError,
  rethrowAfterFinalizationCleanup,
} from "./codebase-improvement-runtime.ts";

const path = ".orca/workflows/codebase-improvement.ts";
const runtimePath = ".orca/workflows/codebase-improvement-runtime.ts";
const EXPECTED_AUTONOMOUS_STAGE_CALLS = 8;
const EXPECTED_SIMPLE_STAGE_LIMITS = {
  preflight: 300_000,
  scout: 155_000,
  reproduce: 120_000,
  implement: 300_000,
  repairs: 180_000,
  review: 180_000,
  verify: 180_000,
  delivery: 180_000,
} as const;
const EXPECTED_SIMPLE_STAGE_TOTAL = 1_595_000;
const EXPECTED_SCOUT_NUMERIC_CONSTANTS = {
  SCOUT_GATHER_LIMIT_MS: 15_000,
  SCOUT_MODEL_LIMIT_MS: 120_000,
  SCOUT_VALIDATION_LIMIT_MS: 20_000,
  SCOUT_EVIDENCE_MAX_FILES: 8,
  SCOUT_EVIDENCE_MAX_CHARS: 10_000,
  FALLBACK_CONTROL_LIMIT_MS: 10_000,
} as const;
const EXPECTED_PROFILE_SCALE = {
  simple: 1,
  medium: 2,
  challenging: 4,
} as const;
const REQUIRED_REPRODUCE_PROMPT_SNIPPETS = [
  '`Allowed repository paths: ${candidate.allowedPaths.join(", ")}.`',
  '`The failure must include this exact marker: ${candidateRedMarker(candidate.id)}.`',
  '`Name the new regression test with ${candidateRedMarker(candidate.id)} as an exact standalone token.`',
  '`Preserve the pre-existing top-level passing control test named exactly "${controlTestName(candidate)}" byte-for-byte in AST.`',
  '`That control must continue to prove ${candidate.controlBrief} by importing and observing ${candidate.controlProductionPath}. Do not add, rewrite, rename, repurpose, delete, weaken, skip, or mock the control.`',
  '"Make the new RED assertion observe the same exported production entrypoint as the control; only the defect input may differ."',
  '`Before stopping, run ${renderShellCommand("bun", controlTestArgs(candidate))} and require exactly one passing control.`',
  '`Then run only the new regression test with --test-name-pattern anchored to its escaped exact static name and require it to fail with ${candidateRedMarker(candidate.id)}. Do not run the whole test file as RED proof. If it passes, strengthen only the target assertion; incidental runner, stack, or source text must not satisfy it. Rerun the control and exact-name RED commands.`',
  '"The parent independently repeats both gates and saves the test diff only after they pass."',
  '"Never rename, repurpose, delete, or weaken an existing test; add only the new regression case."',
  '"For this reproduction, treat current implementation and existing tests as stronger evidence than speculative defect claims."',
  '"If no legitimate RED exists, leave the baseline unchanged and report the candidate non-reproducible; never manufacture a failure."',
  '"After required skill and context setup, inspect only the candidate allowed repository paths before editing. If they disprove the causal claim, stop immediately, leave the baseline unchanged, and report the candidate non-reproducible; do not search for a replacement."',
] as const;
const STALE_REPRODUCE_PROMPT_DIRECTIVES = [
  "After applying the test patch, stop. The parent runs the targeted red gate.",
  "After applying both tests, stop. The parent runs the positive control and targeted red gates.",
  '`Then run ${renderShellCommand("bun", candidate.targetedTestArgs)} and require it to fail with ${candidateRedMarker(candidate.id)}. If it passes, strengthen only the target assertion; incidental runner, stack, or source text must not satisfy it. Rerun both commands.`',
] as const;

interface PublicationContextProbe {
  readonly signal: AbortSignal;
  readonly attempt: 1 | 2;
  readonly remainingMs: () => number;
  readonly isCurrent: () => boolean;
  readonly commitPublication: () => { readonly remainingMs: number };
}

function finalizationContext(
  commitPublication: () => { readonly remainingMs: number },
): PublicationContextProbe {
  return {
    signal: new AbortController().signal,
    attempt: 1,
    remainingMs: () => 1_000,
    isCurrent: () => true,
    commitPublication,
  };
}

async function expectRealOwnerOnlyDirectory(path: string): Promise<void> {
  const status = await lstat(path);
  expect(status.isDirectory()).toBe(true);
  expect(status.isSymbolicLink()).toBe(false);
  expect(status.mode & 0o777).toBe(0o700);
}

async function createOwnerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

type FinalizationTextPublisher = (
  destination: string,
  value: string,
  runId: string,
  context: PublicationContextProbe,
) => Promise<{ readonly remainingMs: number }>;

async function loadFinalizationTextPublisher(
  source: string,
): Promise<FinalizationTextPublisher> {
  const runtime = (await import(
    "./codebase-improvement-runtime.ts"
  )) as unknown as Record<string, unknown>;
  const securePublisher = runtime.publishFinalizationText;
  if (typeof securePublisher === "function") {
    return async (destination, value, _runId, context) =>
      await (securePublisher as (
        destination: string,
        value: string,
        context: PublicationContextProbe,
      ) => Promise<{ readonly remainingMs: number }>)(
        destination,
        value,
        context,
      );
  }

  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = functionDeclarationsNamed(
    sourceFile,
    "publishFinalizationText",
  );
  if (declarations.length !== 1 || declarations[0] === undefined) {
    throw new Error("expected one finalization text publisher");
  }
  const emitted = ts.transpileModule(declarations[0].getText(sourceFile), {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded: unknown = runInNewContext(
    `${emitted}\npublishFinalizationText;`,
    {
      renameSync,
      rethrowAfterFinalizationCleanup,
      rmSync,
      writeText: async (target: string, value: string): Promise<void> => {
        await writeFile(target, value);
      },
    },
  );
  if (typeof loaded !== "function") {
    throw new Error("finalization text publisher did not evaluate to a function");
  }
  return loaded as FinalizationTextPublisher;
}

type PublishActiveReadyDeliveryRecord = (
  destination: string,
  value: string,
  runId: string,
  context: PublicationContextProbe,
  onPublished: () => void,
) => Promise<{ readonly remainingMs: number }>;

function loadPublishActiveReadyDeliveryRecord(
  source: string,
  publisher: FinalizationTextPublisher,
): PublishActiveReadyDeliveryRecord | undefined {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = functionDeclarationsNamed(
    sourceFile,
    "publishActiveReadyDeliveryRecord",
  );
  if (declarations.length !== 1 || declarations[0] === undefined) {
    return undefined;
  }
  const emitted = ts.transpileModule(declarations[0].getText(sourceFile), {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded: unknown = runInNewContext(
    `${emitted}\npublishActiveReadyDeliveryRecord;`,
    { publishFinalizationText: publisher },
  );
  return typeof loaded === "function"
    ? (loaded as PublishActiveReadyDeliveryRecord)
    : undefined;
}

function activeReadyBoundaryContractIssues(source: string): string[] {
  const issues = [...immutablePushContractIssues(source)];
  const remoteProof = source.indexOf("const remoteBranch = await runRequired(");
  const readyProof = source.indexOf(
    "await assertPullRequestHead(prUrl, pullRequestIdentity);",
    remoteProof,
  );
  const record = source.indexOf("DeliveryRecordSchema.parse(", readyProof);
  if (remoteProof < 0 || readyProof <= remoteProof || record <= readyProof) {
    issues.push("ready PR proof must follow exact remote branch proof");
  }

  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const finalizer = callsNamed(sourceFile, "finalizeWorkflowEvidence")[0];
  const options = finalizer?.arguments[0];
  const artifacts =
    options !== undefined && ts.isObjectLiteralExpression(options)
      ? propertyAssignmentNamed(options, "artifacts")?.initializer
      : undefined;
  const labels =
    artifacts !== undefined && ts.isArrayLiteralExpression(artifacts)
      ? artifacts.elements.map((artifact) => {
          if (!ts.isObjectLiteralExpression(artifact)) return undefined;
          const label = propertyAssignmentNamed(artifact, "label")?.initializer;
          return label !== undefined && ts.isStringLiteralLike(label)
            ? label.text
            : undefined;
        })
      : [];
  if (
    labels.join("\n") !==
    ["issue ledger", "delivery record", "monitor"].join("\n")
  ) {
    issues.push("delivery record must publish before monitor and terminal report");
  }

  const publisher = functionDeclarationsNamed(
    sourceFile,
    "publishActiveReadyDeliveryRecord",
  )[0];
  const publisherText = publisher?.getText(sourceFile) ?? "";
  const publish = publisher === undefined
    ? undefined
    : callsNamed(publisher, "publishFinalizationText")[0];
  if (
    publisher === undefined ||
    publish === undefined ||
    !publisherText.includes("const decision = await publishFinalizationText(") ||
    !publisherText.includes("onPublished();") ||
    publisherText.indexOf("onPublished();") <
      publisherText.indexOf("const decision = await publishFinalizationText(") ||
    !publisherText.includes("return decision;")
  ) {
    issues.push("delivery record publication must gate active-ready monitor success");
  }

  const workflowEnd = source.indexOf("\n  }\n});", record);
  const afterRecord = source.slice(
    record,
    workflowEnd < 0 ? source.length : workflowEnd,
  );
  if (
    [
      "resolveAllOpenIssuesForProvingRun",
      'runRequired("gh", ["pr", "checks"]',
      'enter("remote-checks")',
      'enter("merge")',
    ].some((forbidden) => afterRecord.includes(forbidden))
  ) {
    issues.push(
      "active-ready publication must not start checks, merge, or issue closure",
    );
  }
  return issues;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  let didReject = false;
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    didReject = true;
    rejection = error;
  }
  if (!didReject) throw new Error("expected promise to reject");
  return rejection;
}

type AssertPullRequestHeadBounded = (
  prUrl: string,
  identity: PullRequestIdentity,
  timeoutMs: number,
) => Promise<void>;

interface ReadyProofCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

function loadAssertPullRequestHeadBounded(
  source: string,
  runRequired: (command: ReadyProofCommand) => Promise<{ readonly stdout: string }>,
): AssertPullRequestHeadBounded {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = [
    "readPullRequestHeadBounded",
    "assertPullRequestHeadBounded",
  ].map((name) => functionDeclarationsNamed(sourceFile, name)[0]);
  if (declarations.some((declaration) => declaration === undefined)) {
    throw new Error("expected ready-PR reader and assertion helpers");
  }
  const emitted = declarations
    .map((declaration) =>
      ts.transpileModule(declaration!.getText(sourceFile), {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    )
    .join("\n");
  const loaded: unknown = runInNewContext(
    `${emitted}\nassertPullRequestHeadBounded;`,
    {
      PullRequestHeadSchema: { parse: (value: unknown): unknown => value },
      assertReadyPullRequestHead,
      parseJson: (value: string): unknown => JSON.parse(value),
      runRequired: async (
        command: string,
        args: readonly string[],
        timeoutMs: number,
      ) => await runRequired({ command, args, timeoutMs }),
    },
  );
  if (typeof loaded !== "function") {
    throw new Error("ready-PR assertion helper did not evaluate to a function");
  }
  return loaded as AssertPullRequestHeadBounded;
}

interface TimeoutUsage {
  readonly input: number;
  readonly output: number;
  readonly reasoning?: number;
}

interface TimeoutConversation<T> {
  awaitResult(): Promise<T>;
  cancel(reason?: string): Promise<void>;
}

type AwaitConversationWithinBudget = <T>(
  conversation: TimeoutConversation<T>,
  availableMs: number,
  stage: string,
  recordUsage: (usage: TimeoutUsage | undefined) => void,
) => Promise<T>;

function loadAwaitConversationWithinBudget(
  source: string,
  awaitBoundedImpl: () => Promise<unknown>,
): AwaitConversationWithinBudget {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = functionDeclarationsNamed(
    sourceFile,
    "awaitConversationWithinBudget",
  );
  if (declarations.length !== 1 || declarations[0] === undefined) {
    throw new Error("expected one awaitConversationWithinBudget function");
  }
  const emitted = ts.transpileModule(declarations[0].getText(sourceFile), {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded: unknown = runInNewContext(
    `${emitted}\nawaitConversationWithinBudget;`,
    {
      CONVERSATION_SETTLEMENT_RESERVE_MS: 5_000,
      ConversationTimeoutError,
      awaitBounded: awaitBoundedImpl,
      reserveConversationTimeouts: () => ({
        activeTimeoutMs: 50,
        settlementTimeoutMs: 10,
      }),
    },
  );
  if (typeof loaded !== "function") {
    throw new Error("awaitConversationWithinBudget did not evaluate to a function");
  }
  return loaded as AwaitConversationWithinBudget;
}

interface AutonomousStageInspection {
  readonly callCount: number;
  readonly firstArguments: readonly string[];
  readonly aliasKinds: readonly string[];
}

interface SimpleStageLimitInspection {
  readonly values: Readonly<Record<string, number>>;
  readonly total: number;
  readonly structuralIssues: readonly string[];
}

interface NumericConstantInspection {
  readonly values: Readonly<Record<string, number>>;
  readonly declarationCounts: Readonly<Record<string, number>>;
  readonly structuralIssues: readonly string[];
}

function inspectAutonomousStages(source: string): AutonomousStageInspection {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const firstArguments: string[] = [];
  const aliasKinds = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "autonomous"
    ) {
      firstArguments.push(
        node.arguments[0]?.getText(sourceFile) ?? "<missing>",
      );
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "autonomous" &&
      !(
        ts.isCallExpression(node.parent) && node.parent.expression === node
      )
    ) {
      aliasKinds.add("direct-reference");
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression !== undefined &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "autonomous"
    ) {
      aliasKinds.add("element-access");
    }
    if (
      ts.isBindingElement(node) &&
      bindingName(node.propertyName ?? node.name) === "autonomous"
    ) {
      aliasKinds.add("destructured");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "autonomous"
    ) {
      aliasKinds.add("direct-call");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    callCount: firstArguments.length,
    firstArguments,
    aliasKinds: [...aliasKinds].sort(),
  };
}

function bindingName(node: ts.Node): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node)
    ? node.text
    : undefined;
}

function expressionPath(expression: ts.Expression): readonly string[] | undefined {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  const parent = expressionPath(expression.expression);
  return parent === undefined ? undefined : [...parent, expression.name.text];
}

function hasExpressionPath(
  expression: ts.Expression | undefined,
  expected: readonly string[],
): boolean {
  if (expression === undefined) return false;
  const actual = expressionPath(expression);
  return (
    actual !== undefined &&
    actual.length === expected.length &&
    actual.every((part, index) => part === expected[index])
  );
}

function isCallAtPath(
  expression: ts.Expression | undefined,
  expected: readonly string[],
): expression is ts.CallExpression {
  return (
    expression !== undefined &&
    ts.isCallExpression(expression) &&
    hasExpressionPath(expression.expression, expected)
  );
}

function isIdentifierNamed(
  expression: ts.Expression | undefined,
  expected: string,
): boolean {
  return (
    expression !== undefined &&
    ts.isIdentifier(expression) &&
    expression.text === expected
  );
}

function isSingleIdentifierCall(
  expression: ts.Expression | undefined,
  callee: string,
  argument: string,
): boolean {
  return (
    isCallAtPath(expression, [callee]) &&
    expression.arguments.length === 1 &&
    isIdentifierNamed(expression.arguments[0], argument)
  );
}

function inspectSimpleStageLimits(source: string): SimpleStageLimitInspection {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const values: Record<string, number> = {};
  const structuralIssues: string[] = [];
  let declarationCount = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "SIMPLE_STAGE_LIMITS"
    ) {
      declarationCount += 1;
      const initializer = node.initializer;
      const expression =
        initializer !== undefined && ts.isAsExpression(initializer)
          ? initializer.expression
          : initializer;
      if (expression === undefined || !ts.isObjectLiteralExpression(expression)) {
        structuralIssues.push("SIMPLE_STAGE_LIMITS must be an object literal");
      } else {
        for (const property of expression.properties) {
          if (!ts.isPropertyAssignment(property)) {
            structuralIssues.push(
              `SIMPLE_STAGE_LIMITS property must be a direct assignment: ${property.getText(sourceFile)}`,
            );
            continue;
          }
          const name = bindingName(property.name);
          if (name === undefined) {
            structuralIssues.push(
              `SIMPLE_STAGE_LIMITS property name must be static: ${property.name.getText(sourceFile)}`,
            );
            continue;
          }
          if (Object.hasOwn(values, name)) {
            structuralIssues.push(`duplicate SIMPLE_STAGE_LIMITS key: ${name}`);
            continue;
          }
          if (!ts.isNumericLiteral(property.initializer)) {
            structuralIssues.push(
              `SIMPLE_STAGE_LIMITS.${name} must be a numeric literal`,
            );
            continue;
          }
          values[name] = Number(
            property.initializer.getText(sourceFile).replaceAll("_", ""),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (declarationCount !== 1) {
    structuralIssues.push(
      `expected one SIMPLE_STAGE_LIMITS declaration; received ${String(declarationCount)}`,
    );
  }

  return {
    values,
    total: Object.values(values).reduce((sum, value) => sum + value, 0),
    structuralIssues,
  };
}

function simpleStageLimitContractIssues(source: string): string[] {
  const inspection = inspectSimpleStageLimits(source);
  const issues = [...inspection.structuralIssues];
  const expectedKeys = Object.keys(EXPECTED_SIMPLE_STAGE_LIMITS).sort();
  const receivedKeys = Object.keys(inspection.values).sort();
  if (receivedKeys.join("\n") !== expectedKeys.join("\n")) {
    issues.push(
      `SIMPLE_STAGE_LIMITS keys must be ${expectedKeys.join(", ")}; received ${receivedKeys.join(", ")}`,
    );
  }
  for (const [name, expected] of Object.entries(
    EXPECTED_SIMPLE_STAGE_LIMITS,
  )) {
    const received = inspection.values[name];
    if (received !== expected) {
      issues.push(
        `SIMPLE_STAGE_LIMITS.${name} must be ${String(expected)}; received ${String(received)}`,
      );
    }
  }
  if (inspection.total !== EXPECTED_SIMPLE_STAGE_TOTAL) {
    issues.push(
      `SIMPLE_STAGE_LIMITS total must be ${String(EXPECTED_SIMPLE_STAGE_TOTAL)}; received ${String(inspection.total)}`,
    );
  }
  return issues;
}

function numericObjectLiteralContractIssues(
  source: string,
  variableName: string,
  expected: Readonly<Record<string, number>>,
): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const values: Record<string, number> = {};
  const issues: string[] = [];
  let declarationCount = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName
    ) {
      declarationCount += 1;
      const initializer = node.initializer;
      const expression =
        initializer !== undefined && ts.isAsExpression(initializer)
          ? initializer.expression
          : initializer;
      if (expression === undefined || !ts.isObjectLiteralExpression(expression)) {
        issues.push(`${variableName} must be an object literal`);
      } else {
        for (const property of expression.properties) {
          if (!ts.isPropertyAssignment(property)) {
            issues.push(`${variableName} properties must be direct assignments`);
            continue;
          }
          const name = bindingName(property.name);
          if (name === undefined || !ts.isNumericLiteral(property.initializer)) {
            issues.push(`${variableName} properties must be static numeric literals`);
            continue;
          }
          values[name] = Number(
            property.initializer.getText(sourceFile).replaceAll("_", ""),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (declarationCount !== 1) {
    issues.push(
      `expected one ${variableName} declaration; received ${String(declarationCount)}`,
    );
  }
  const expectedKeys = Object.keys(expected).sort();
  const receivedKeys = Object.keys(values).sort();
  if (receivedKeys.join("\n") !== expectedKeys.join("\n")) {
    issues.push(
      `${variableName} keys must be ${expectedKeys.join(", ")}; received ${receivedKeys.join(", ")}`,
    );
  }
  for (const [name, expectedValue] of Object.entries(expected)) {
    if (values[name] !== expectedValue) {
      issues.push(
        `${variableName}.${name} must be ${String(expectedValue)}; received ${String(values[name])}`,
      );
    }
  }
  return issues;
}

function inspectScoutNumericConstants(
  source: string,
): NumericConstantInspection {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const expectedNames = new Set(Object.keys(EXPECTED_SCOUT_NUMERIC_CONSTANTS));
  const values: Record<string, number> = {};
  const declarationCounts: Record<string, number> = {};
  const structuralIssues: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      expectedNames.has(node.name.text)
    ) {
      const name = node.name.text;
      declarationCounts[name] = (declarationCounts[name] ?? 0) + 1;
      if (node.initializer === undefined || !ts.isNumericLiteral(node.initializer)) {
        structuralIssues.push(`${name} must be a direct numeric literal`);
      } else {
        values[name] = Number(
          node.initializer.getText(sourceFile).replaceAll("_", ""),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { values, declarationCounts, structuralIssues };
}

function scoutNumericConstantContractIssues(source: string): string[] {
  const inspection = inspectScoutNumericConstants(source);
  const issues = [...inspection.structuralIssues];
  for (const [name, expected] of Object.entries(
    EXPECTED_SCOUT_NUMERIC_CONSTANTS,
  )) {
    const count = inspection.declarationCounts[name] ?? 0;
    if (count !== 1) {
      issues.push(`expected one ${name} declaration; received ${String(count)}`);
    }
    const received = inspection.values[name];
    if (received !== expected) {
      issues.push(`${name} must be ${String(expected)}; received ${String(received)}`);
    }
  }
  return issues;
}

function fallbackControlBudgetContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const resolver = variableNamed(sourceFile, "resolveFallbackControl");
  const calls =
    resolver?.initializer === undefined
      ? []
      : callsNamed(resolver.initializer, "remainingTimeout");
  const call = calls[0];
  if (
    calls.length !== 1 ||
    call?.arguments[0]?.getText(sourceFile) !== "FALLBACK_CONTROL_LIMIT_MS" ||
    call.arguments[1]?.getText(sourceFile) !== 'budget("reproduce")' ||
    call.arguments[2]?.getText(sourceFile) !== "label"
  ) {
    return [
      "fallback control must use its exact cap inside the shared reproduce budget",
    ];
  }
  return [];
}

function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function propertyCallsNamed(root: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === name
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function functionDeclarationsNamed(
  root: ts.Node,
  name: string,
): ts.FunctionDeclaration[] {
  const declarations: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return declarations;
}

function directThrowStatement(
  statement: ts.Statement | undefined,
): ts.ThrowStatement | undefined {
  if (statement === undefined) return undefined;
  if (ts.isThrowStatement(statement)) return statement;
  if (!ts.isBlock(statement) || statement.statements.length !== 1) {
    return undefined;
  }
  const nested = statement.statements.at(0);
  return nested !== undefined && ts.isThrowStatement(nested)
    ? nested
    : undefined;
}

function propertyAssignmentNamed(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && bindingName(property.name) === name,
  );
}

function variableNamed(
  root: ts.Node,
  name: string,
): ts.VariableDeclaration | undefined {
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (
      declaration === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      declaration = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return declaration;
}

function variablesNamed(
  root: ts.Node,
  name: string,
): ts.VariableDeclaration[] {
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return declarations;
}

function ancestorCallNamed(
  node: ts.Node,
  name: string,
): ts.CallExpression | undefined {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === name
    ) {
      return parent;
    }
  }
  return undefined;
}

function immediateDeadlineWrapper(
  operation: ts.CallExpression,
): ts.CallExpression | undefined {
  const awaited = operation.parent;
  if (!ts.isAwaitExpression(awaited) || awaited.expression !== operation) {
    return undefined;
  }
  let callback: ts.ArrowFunction | undefined;
  if (ts.isArrowFunction(awaited.parent) && awaited.parent.body === awaited) {
    callback = awaited.parent;
  } else {
    const statement = awaited.parent;
    const block = statement.parent;
    const blockCallback = block.parent;
    if (
      ts.isExpressionStatement(statement) &&
      statement.expression === awaited &&
      ts.isBlock(block) &&
      block.statements.length === 1 &&
      block.statements[0] === statement &&
      ts.isArrowFunction(blockCallback) &&
      blockCallback.body === block
    ) {
      callback = blockCallback;
    }
  }
  if (callback === undefined || callback.parameters.length !== 0) {
    return undefined;
  }
  const wrapper = callback.parent;
  if (
    !isCallAtPath(wrapper, ["awaitWithinDeadline"]) ||
    wrapper.arguments[2] !== callback
  ) {
    return undefined;
  }
  const outerAwait = wrapper.parent;
  return ts.isAwaitExpression(outerAwait) && outerAwait.expression === wrapper
    ? wrapper
    : undefined;
}

function activeFilesystemDeadlineContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const callsWhere = (
    name: string,
    predicate: (call: ts.CallExpression) => boolean,
  ): ts.CallExpression[] =>
    propertyCallsNamed(sourceFile, name).filter(predicate);
  const directWhere = (
    name: string,
    predicate: (call: ts.CallExpression) => boolean,
  ): ts.CallExpression[] => callsNamed(sourceFile, name).filter(predicate);
  const operations = [
    {
      label: "preflight attestation read",
      calls: callsWhere(
        "readText",
        (call) => call.arguments[0]?.getText(sourceFile) === "report.preflightPath",
      ),
      wrapperLabel: "preflight attestation read",
      remaining: '() => budget("preflight")',
    },
    {
      label: "workflow config read",
      calls: directWhere("readConfig", () => true),
      wrapperLabel: "workflow config read",
      remaining: '() => budget("preflight")',
    },
    {
      label: "reproduced test read",
      calls: directWhere(
        "readFile",
        (call) => call.arguments[0]?.getText(sourceFile) === "chosen.testPath",
      ),
      wrapperLabel: "reproduced test read",
      remaining: '() => budget("reproduce")',
    },
    {
      label: "RED diff write",
      calls: directWhere(
        "writeText",
        (call) => call.arguments[0]?.getText(sourceFile) === "RED_DIFF_PATH",
      ),
      wrapperLabel: "RED diff write",
      remaining: '() => budget("reproduce")',
    },
    {
      label: "rejected candidate artifact write",
      calls: directWhere(
        "writeJson",
        (call) =>
          call.arguments[0]?.getText(sourceFile) === "artifactPath" &&
          call.arguments[1]?.getText(sourceFile) === "rejected",
      ).slice(0, 1),
      wrapperLabel: "rejected candidate artifact write",
      remaining: '() => budget("reproduce")',
    },
    {
      label: "rejected restoration artifact write",
      calls: directWhere(
        "writeJson",
        (call) =>
          call.arguments[0]?.getText(sourceFile) === "artifactPath" &&
          call.arguments[1]?.getText(sourceFile) === "rejected",
      ).slice(1, 2),
      wrapperLabel: "rejected restoration artifact write",
      remaining: '() => budget("reproduce")',
    },
    {
      label: "accepted plan write",
      calls: directWhere(
        "writeJson",
        (call) => call.arguments[0]?.getText(sourceFile) === "PLAN_PATH",
      ),
      wrapperLabel: "accepted plan write",
      remaining: "workRemaining",
    },
    {
      label: "PR body write",
      calls: directWhere(
        "writeText",
        (call) => call.arguments[0]?.getText(sourceFile) === "bodyPath",
      ),
      wrapperLabel: "PR body write",
      remaining: '() => budget("delivery")',
    },
    {
      label: "test snapshot existence check",
      calls: callsWhere(
        "exists",
        (call) => call.expression.getText(sourceFile) === "file.exists",
      ),
      wrapperLabel: "test snapshot existence check",
      remaining: "remaining",
    },
    {
      label: "test snapshot read",
      calls: callsWhere(
        "arrayBuffer",
        (call) => call.expression.getText(sourceFile) === "file.arrayBuffer",
      ),
      wrapperLabel: "test snapshot read",
      remaining: "remaining",
    },
    {
      label: "test snapshot write",
      calls: callsWhere(
        "write",
        (call) => call.expression.getText(sourceFile) === "Bun.write",
      ),
      wrapperLabel: "test snapshot write",
      remaining: "remaining",
    },
  ] as const;

  for (const operation of operations) {
    if (operation.calls.length !== 1) {
      issues.push(
        `${operation.label} must have one operation; received ${String(operation.calls.length)}`,
      );
      continue;
    }
    const wrapper = immediateDeadlineWrapper(operation.calls[0]!);
    if (
      wrapper === undefined ||
      wrapper.arguments[0]?.getText(sourceFile) !==
        JSON.stringify(operation.wrapperLabel) ||
      wrapper.arguments[1]?.getText(sourceFile) !== operation.remaining
    ) {
      issues.push(
        `${operation.label} must be an immediate awaitWithinDeadline descendant using ${operation.remaining}`,
      );
    }
  }

  const workRemaining = variablesNamed(sourceFile, "workRemaining");
  const workInitializer = workRemaining[0]?.initializer;
  const workBody =
    workInitializer !== undefined && ts.isArrowFunction(workInitializer)
      ? workInitializer.body
      : undefined;
  if (
    workRemaining.length !== 1 ||
    workInitializer === undefined ||
    !ts.isArrowFunction(workInitializer) ||
    workInitializer.parameters.length !== 0 ||
    workInitializer.type?.getText(sourceFile) !== "number" ||
    !isCallAtPath(workBody as ts.Expression | undefined, ["stageBudgetMs"]) ||
    workBody.arguments.map((argument) => argument.getText(sourceFile)).join("\n") !==
      [
        "startedAtMs",
        "workDeadlineMs()",
        "Date.now()",
        "workDeadlineMs()",
      ].join("\n")
  ) {
    issues.push("workRemaining must own the exact active-work cutoff");
  }

  const budget = variablesNamed(sourceFile, "budget");
  const budgetBody =
    budget[0]?.initializer !== undefined &&
    ts.isArrowFunction(budget[0].initializer) &&
    ts.isBlock(budget[0].initializer.body)
      ? budget[0].initializer.body
      : undefined;
  const budgetReturn = budgetBody?.statements[1];
  const budgetExpression =
    budgetReturn !== undefined && ts.isReturnStatement(budgetReturn)
      ? budgetReturn.expression
      : undefined;
  if (
    budget.length !== 1 ||
    budgetBody?.statements.length !== 2 ||
    !isCallAtPath(budgetExpression, ["Math", "min"]) ||
    budgetExpression.arguments[1]?.getText(sourceFile) !== "workRemaining()"
  ) {
    issues.push("stage budgets must reuse workRemaining exactly");
  }

  const preflightRead = operations[0].calls[0];
  const configRead = operations[1].calls[0];
  const enter = callsNamed(sourceFile, "enter").find(
    (call) => call.arguments[0]?.getText(sourceFile) === '"preflight"',
  );
  const begin = callsNamed(sourceFile, "beginBudget").find(
    (call) => call.arguments[0]?.getText(sourceFile) === '"preflight"',
  );
  if (
    enter === undefined ||
    begin === undefined ||
    preflightRead === undefined ||
    configRead === undefined ||
    !(enter.getStart(sourceFile) < begin.getStart(sourceFile) &&
      begin.getStart(sourceFile) < preflightRead.getStart(sourceFile) &&
      preflightRead.getStart(sourceFile) < configRead.getStart(sourceFile))
  ) {
    issues.push("preflight must activate before attestation and config reads");
  }
  return issues;
}

function ciPollDeadlineContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const pollInterval = variablesNamed(sourceFile, "CI_POLL_INTERVAL_MS");
  if (
    pollInterval.length !== 1 ||
    pollInterval[0]?.initializer?.getText(sourceFile) !== "5_000"
  ) {
    issues.push("CI poll interval must be exactly 5,000 ms");
  }
  const terminalReserve = variablesNamed(sourceFile, "deliveryTerminalReserve");
  if (
    terminalReserve.length !== 1 ||
    terminalReserve[0]?.initializer?.getText(sourceFile) !==
      "MERGE_CONFIRMATION_LIMIT_MS + ISSUE_CLOSURE_RESERVE_MS" ||
    variableNamed(sourceFile, "MERGE_CONFIRMATION_LIMIT_MS")?.initializer?.getText(
      sourceFile,
    ) !== "5_000" ||
    variableNamed(sourceFile, "ISSUE_CLOSURE_RESERVE_MS")?.initializer?.getText(
      sourceFile,
    ) !== "5_000"
  ) {
    issues.push("CI polling must preserve the exact 10,000 ms terminal reserve");
  }
  const pollRemaining = variablesNamed(sourceFile, "ciPollRemaining");
  const pollInitializer = pollRemaining[0]?.initializer;
  if (
    pollRemaining.length !== 1 ||
    pollInitializer === undefined ||
    !ts.isArrowFunction(pollInitializer) ||
    pollInitializer.parameters.length !== 0 ||
    pollInitializer.type?.getText(sourceFile) !== "number" ||
    compactSource(pollInitializer.body.getText(sourceFile)) !==
      'budget("delivery") - deliveryTerminalReserve'
  ) {
    issues.push("ciPollRemaining must subtract the terminal reserve from delivery");
  }
  const sleeps = propertyCallsNamed(sourceFile, "sleep").filter(
    (call) => call.expression.getText(sourceFile) === "Bun.sleep",
  );
  if (sleeps.length !== 1) {
    issues.push(`expected one CI pending sleep; received ${String(sleeps.length)}`);
    return issues;
  }
  const [sleep] = sleeps;
  if (sleep === undefined) return issues;
  const wrapper = immediateDeadlineWrapper(sleep);
  const sleepCallback = wrapper?.arguments[2];
  if (
    sleepCallback === undefined ||
    !ts.isArrowFunction(sleepCallback) ||
    !ts.isBlock(sleepCallback.body) ||
    sleepCallback.body.statements.length !== 1
  ) {
    issues.push("CI pending sleep callback must use a single-statement block");
  }
  if (
    sleep.arguments[0]?.getText(sourceFile) !==
      "Math.min(CI_POLL_INTERVAL_MS, ciPollRemaining())" ||
    wrapper?.arguments[0]?.getText(sourceFile) !== '"CI poll interval"' ||
    wrapper.arguments[1]?.getText(sourceFile) !== "ciPollRemaining"
  ) {
    issues.push("CI pending sleep must be bound by ciPollRemaining");
  }
  const outerAwait = wrapper?.parent;
  const statement = outerAwait?.parent;
  const block = statement?.parent;
  const statementIndex =
    statement !== undefined && ts.isExpressionStatement(statement) && ts.isBlock(block)
      ? block.statements.indexOf(statement)
      : -1;
  const guard =
    statementIndex > 0 && ts.isBlock(block)
      ? block.statements[statementIndex - 1]
      : undefined;
  if (
    guard === undefined ||
    !ts.isIfStatement(guard) ||
    compactSource(guard.expression.getText(sourceFile)) !==
      "!(ciPollRemaining() > CI_POLL_INTERVAL_MS)" ||
    directThrowStatement(guard.thenStatement) === undefined
  ) {
    issues.push("CI pending sleep must require a strict interval remainder");
  }
  return issues;
}

function mutateDeadlineWrapper(
  source: string,
  wrapperLabel: string,
  mutation: "remove" | "infinite" | "drop-await",
): string {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const wrapper = callsNamed(sourceFile, "awaitWithinDeadline").find(
    (call) =>
      ts.isStringLiteralLike(call.arguments[0]) &&
      call.arguments[0].text === wrapperLabel,
  );
  if (wrapper === undefined) return source;
  if (mutation === "infinite") {
    const remaining = wrapper.arguments[1];
    if (remaining === undefined) return source;
    return `${source.slice(0, remaining.getStart(sourceFile))}() => Number.POSITIVE_INFINITY${source.slice(remaining.getEnd())}`;
  }
  if (mutation === "drop-await") {
    const awaited = wrapper.parent;
    if (!ts.isAwaitExpression(awaited) || awaited.expression !== wrapper) {
      return source;
    }
    return `${source.slice(0, awaited.getStart(sourceFile))}${wrapper.getText(sourceFile)}${source.slice(awaited.getEnd())}`;
  }
  const callback = wrapper.arguments[2];
  if (
    callback === undefined ||
    !ts.isArrowFunction(callback)
  ) {
    return source;
  }
  let awaitedBody: ts.AwaitExpression | undefined;
  if (ts.isAwaitExpression(callback.body)) {
    awaitedBody = callback.body;
  } else if (ts.isBlock(callback.body) && callback.body.statements.length === 1) {
    const [statement] = callback.body.statements;
    if (
      statement !== undefined &&
      ts.isExpressionStatement(statement) &&
      ts.isAwaitExpression(statement.expression)
    ) {
      awaitedBody = statement.expression;
    }
  }
  if (awaitedBody === undefined) return source;
  return `${source.slice(0, wrapper.getStart(sourceFile))}${awaitedBody.expression.getText(sourceFile)}${source.slice(wrapper.getEnd())}`;
}

function staticStringArray(node: ts.Node | undefined): string[] | undefined {
  if (node === undefined || !ts.isArrayLiteralExpression(node)) {
    return undefined;
  }
  const values: string[] = [];
  for (const element of node.elements) {
    if (!ts.isStringLiteralLike(element)) return undefined;
    values.push(element.text);
  }
  return values;
}

function hasImmediateCallAfterVariable(
  declaration: ts.VariableDeclaration | undefined,
  name: string,
): boolean {
  const statement = declaration?.parent.parent;
  const block = statement?.parent;
  if (
    statement === undefined ||
    block === undefined ||
    !ts.isVariableStatement(statement) ||
    !ts.isBlock(block)
  ) {
    return false;
  }
  const index = block.statements.indexOf(statement);
  const next = block.statements[index + 1];
  return (
    next !== undefined &&
    ts.isExpressionStatement(next) &&
    ts.isCallExpression(next.expression) &&
    ts.isIdentifier(next.expression.expression) &&
    next.expression.expression.text === name
  );
}

function scoutGatherContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const gatherDeadline = variableNamed(sourceFile, "gatherDeadlineMs");
  if (
    gatherDeadline?.initializer === undefined ||
    gatherDeadline.initializer.getText(sourceFile) !==
      "Date.now() + SCOUT_GATHER_LIMIT_MS"
  ) {
    issues.push("scout gather missing shared 10-second absolute deadline");
  }
  const gatherRemainingDeclarations: ts.VariableDeclaration[] = [];
  const visitGatherRemaining = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "gatherRemaining"
    ) {
      gatherRemainingDeclarations.push(node);
    }
    ts.forEachChild(node, visitGatherRemaining);
  };
  visitGatherRemaining(sourceFile);
  const gatherRemaining = gatherRemainingDeclarations[0];
  const gatherRemainingBody =
    gatherRemaining?.initializer !== undefined &&
    ts.isArrowFunction(gatherRemaining.initializer)
      ? gatherRemaining.initializer.body
      : undefined;
  const remainingCall =
    gatherRemainingBody !== undefined &&
    ts.isCallExpression(gatherRemainingBody) &&
    ts.isIdentifier(gatherRemainingBody.expression) &&
    gatherRemainingBody.expression.text === "remainingTimeout"
      ? gatherRemainingBody
      : undefined;
  const minCall =
    remainingCall?.arguments[1] !== undefined &&
    ts.isCallExpression(remainingCall.arguments[1]) &&
    ts.isPropertyAccessExpression(remainingCall.arguments[1].expression) &&
    remainingCall.arguments[1].expression.expression.getText(sourceFile) ===
      "Math" &&
    remainingCall.arguments[1].expression.name.text === "min"
      ? remainingCall.arguments[1]
      : undefined;
  const absoluteRemainder = minCall?.arguments[0];
  const sharedReserve = minCall?.arguments[1];
  const dateNow =
    absoluteRemainder !== undefined &&
    ts.isBinaryExpression(absoluteRemainder) &&
    absoluteRemainder.operatorToken.kind === ts.SyntaxKind.MinusToken &&
    absoluteRemainder.left.getText(sourceFile) === "gatherDeadlineMs" &&
    ts.isCallExpression(absoluteRemainder.right) &&
    ts.isPropertyAccessExpression(absoluteRemainder.right.expression) &&
    absoluteRemainder.right.expression.expression.getText(sourceFile) ===
      "Date" &&
    absoluteRemainder.right.expression.name.text === "now" &&
    absoluteRemainder.right.arguments.length === 0;
  if (
    gatherRemainingDeclarations.length !== 1 ||
    gatherRemaining?.initializer === undefined ||
    !ts.isArrowFunction(gatherRemaining.initializer) ||
    gatherRemaining.initializer.parameters.length !== 0 ||
    remainingCall === undefined ||
    remainingCall.arguments[0]?.getText(sourceFile) !==
      "SCOUT_GATHER_LIMIT_MS" ||
    minCall === undefined ||
    !dateNow ||
    remainingCall.arguments[2]?.getText(sourceFile) !==
      '"scout evidence gather"'
  ) {
    issues.push(
      "gatherRemaining must derive directly from gatherDeadlineMs - Date.now()",
    );
  }
  if (
    sharedReserve === undefined ||
    !ts.isBinaryExpression(sharedReserve) ||
    sharedReserve.operatorToken.kind !== ts.SyntaxKind.MinusToken ||
    !isIdentifierNamed(
      sharedReserve.right,
      "SCOUT_VALIDATION_LIMIT_MS",
    ) ||
    !ts.isBinaryExpression(sharedReserve.left) ||
    sharedReserve.left.operatorToken.kind !== ts.SyntaxKind.MinusToken ||
    !isCallAtPath(sharedReserve.left.left, ["budget"]) ||
    sharedReserve.left.left.arguments[0]?.getText(sourceFile) !== '"scout"' ||
    !isIdentifierNamed(sharedReserve.left.right, "SCOUT_MODEL_LIMIT_MS")
  ) {
    issues.push(
      "scout gather must reserve model and validation constants from stage budget",
    );
  }

  const gatherRequired = variableNamed(sourceFile, "gatherRequired");
  const gatherCommandCalls =
    gatherRequired?.initializer === undefined
      ? []
      : callsNamed(gatherRequired.initializer, "runLogged");
  if (gatherCommandCalls.length !== 1) {
    issues.push(
      `expected one gatherRequired command call; received ${String(gatherCommandCalls.length)}`,
    );
  }

  const rgCalls: ts.CallExpression[] = [];
  const readCalls: ts.CallExpression[] = [];
  const visitOperations = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "runLogged" &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === "rg"
    ) {
      rgCalls.push(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "readText" &&
      node.arguments[0]?.getText(sourceFile) === "selectedPath"
    ) {
      readCalls.push(node);
    }
    ts.forEachChild(node, visitOperations);
  };
  visitOperations(sourceFile);

  for (const [label, calls] of [
    ["gatherRequired command", gatherCommandCalls],
    ["rg command", rgCalls],
    ["selected-file read", readCalls],
  ] as const) {
    if (calls.length !== 1) {
      issues.push(
        `expected one ${label}; received ${String(calls.length)}`,
      );
      continue;
    }
    const operation = calls[0]!;
    const wrapper = ancestorCallNamed(operation, "awaitWithinDeadline");
    if (wrapper === undefined) {
      issues.push(`${label} must pass through awaitWithinDeadline`);
      continue;
    }
    if (wrapper.arguments[1]?.getText(sourceFile) !== "gatherRemaining") {
      issues.push(`${label} must use shared gatherRemaining deadline`);
    }
    if (
      (label === "gatherRequired command" || label === "rg command") &&
      operation.arguments[2]?.getText(sourceFile) !== "gatherRemaining()"
    ) {
      issues.push(`${label} must retain command timeout`);
    }
  }

  const gatherCalls = callsNamed(sourceFile, "gatherRequired");
  const gatherArgs = gatherCalls.map((call) => ({
    command: ts.isStringLiteralLike(call.arguments[0])
      ? call.arguments[0].text
      : call.arguments[0]?.getText(sourceFile),
    args: staticStringArray(call.arguments[1]),
  }));
  const expectedGatherArgs = [
    { command: "git", args: ["status", "--porcelain=v1"] },
    { command: "git", args: ["ls-files", "src", "tests"] },
    {
      command: "git",
      args: [
        "log",
        "-40",
        "--format=",
        "--name-only",
        "--",
        "src",
        "tests",
      ],
    },
    {
      command: "git",
      args: [
        "show",
        "--format=Latest commit: %H%nSubject: %s",
        "--name-only",
        "--first-parent",
        "HEAD",
      ],
    },
    { command: "git", args: ["status", "--porcelain=v1"] },
  ];
  if (JSON.stringify(gatherArgs) !== JSON.stringify(expectedGatherArgs)) {
    issues.push(
      "gatherRequired calls must be exact status/list/history/latest/status",
    );
  }

  if (rgCalls.length !== 1) {
    issues.push(`expected one bounded rg scan; received ${String(rgCalls.length)}`);
    return issues;
  }
  const args = rgCalls[0]?.arguments[1];
  if (args === undefined || !ts.isArrayLiteralExpression(args)) {
    issues.push("bounded rg scan args must be a direct array literal");
    return issues;
  }
  const received = args.elements.map((element) => {
    if (ts.isStringLiteralLike(element)) return element.text;
    if (
      ts.isSpreadElement(element) &&
      ts.isIdentifier(element.expression)
    ) {
      return `...${element.expression.text}`;
    }
    return element.getText(sourceFile);
  });
  const expected = [
    "-n",
    "--no-heading",
    "-m",
    "8",
    "TODO|FIXME|HACK|XXX|throw new Error|catch",
    "--",
    "...selectedPaths",
  ];
  if (received.join("\n") !== expected.join("\n")) {
    issues.push(
      `bounded rg scan args must be ${expected.join(", ")}; received ${received.join(", ")}`,
    );
  }

  const selectCalls = callsNamed(sourceFile, "selectScoutEvidence");
  if (
    selectCalls.length !== 1 ||
    selectCalls[0]?.arguments[2]?.getText(sourceFile) !==
      "SCOUT_EVIDENCE_MAX_FILES"
  ) {
    issues.push(
      "SCOUT_EVIDENCE_MAX_FILES must be selectScoutEvidence third argument",
    );
  }
  const selectedPaths = variableNamed(sourceFile, "selectedPaths");
  if (
    selectedPaths?.initializer === undefined ||
    selectedPaths.initializer.getText(sourceFile) !== "[...selection.paths]"
  ) {
    issues.push("selected paths must come directly from preserved selection metadata");
  }
  const renderCalls = callsNamed(sourceFile, "renderScoutEvidence");
  if (
    renderCalls.length !== 1 ||
    renderCalls[0]?.arguments[1]?.getText(sourceFile) !==
      "SCOUT_EVIDENCE_MAX_CHARS" ||
    renderCalls[0]?.arguments[2]?.getText(sourceFile) !==
      "latestCommitEvidencePrefix(latestCommit.stdout)" ||
    renderCalls[0]?.arguments[3]?.getText(sourceFile) !==
      "selection.sourceTestPairs"
  ) {
    issues.push(
      "renderScoutEvidence must receive cap, prefix, and source-test pairs",
    );
  }
  if (
    !source.includes(
      "report.scoutEvidence.sourceTestPairs = evidence.sourceTestPairs.map(",
    )
  ) {
    issues.push("run report must persist rendered source-test pairs");
  }
  const evidence = variableNamed(sourceFile, "evidence");
  const evidenceSha = variableNamed(sourceFile, "evidenceSha256");
  if (!hasImmediateCallAfterVariable(evidence, "gatherRemaining")) {
    issues.push("renderScoutEvidence must be followed by a deadline check");
  }
  if (!hasImmediateCallAfterVariable(evidenceSha, "gatherRemaining")) {
    issues.push("evidence SHA-256 must be followed by a deadline check");
  }
  if (
    evidenceSha?.initializer === undefined ||
    evidenceSha.initializer.getText(sourceFile) !==
      'createHash("sha256").update(evidence.text).digest("hex")'
  ) {
    issues.push("evidence SHA-256 must hash the rendered packet");
  }

  const parseCalls = callsNamed(sourceFile, "parseScoutMatchLines");
  if (parseCalls.length !== 1) {
    issues.push(
      `expected one rg match parser call; received ${String(parseCalls.length)}`,
    );
  }
  const statusComparisons: ts.BinaryExpression[] = [];
  const visitComparisons = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      node.left.getText(sourceFile) === "statusBefore.stdout" &&
      node.right.getText(sourceFile) === "statusAfter.stdout"
    ) {
      statusComparisons.push(node);
    }
    ts.forEachChild(node, visitComparisons);
  };
  visitComparisons(sourceFile);
  if (statusComparisons.length !== 1) {
    issues.push("before/after status must have one byte-equality comparison");
  }

  const recordGather = variableNamed(sourceFile, "recordGather");
  const recordText = recordGather?.initializer?.getText(sourceFile) ?? "";
  if (
    !recordText.includes("gatherCommands.push(log)") ||
    !recordText.includes("report.validation.push(log)")
  ) {
    issues.push("recordGather must write both report command collections");
  }
  const commandProperties: ts.PropertyAssignment[] = [];
  const visitProperties = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      bindingName(node.name) === "commands" &&
      node.initializer.getText(sourceFile) === "gatherCommands"
    ) {
      commandProperties.push(node);
    }
    ts.forEachChild(node, visitProperties);
  };
  visitProperties(sourceFile);
  if (commandProperties.length !== 1) {
    issues.push("scout evidence report must retain gatherCommands");
  }
  return issues;
}

function scoutValidationContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const scoutAttempt = variableNamed(sourceFile, "scoutAttempt");
  const validationDeadline = variableNamed(sourceFile, "validationDeadlineMs");
  const validationRemainingDeclarations = variablesNamed(
    sourceFile,
    "validationRemaining",
  );
  const validationRemaining = validationRemainingDeclarations[0];
  const variableStatement = (
    declaration: ts.VariableDeclaration | undefined,
  ): ts.VariableStatement | undefined => {
    const statement = declaration?.parent.parent;
    return statement !== undefined && ts.isVariableStatement(statement)
      ? statement
      : undefined;
  };
  const scoutAttemptStatement = variableStatement(scoutAttempt);
  const validationDeadlineStatement = variableStatement(validationDeadline);
  const validationRemainingStatement = variableStatement(validationRemaining);
  const block = scoutAttemptStatement?.parent;
  const scoutAttemptIndex =
    block !== undefined && ts.isBlock(block)
      ? block.statements.indexOf(scoutAttemptStatement)
      : -1;

  if (
    validationDeadline?.initializer === undefined ||
    validationDeadline.initializer.getText(sourceFile) !==
      "Date.now() + SCOUT_VALIDATION_LIMIT_MS"
  ) {
    issues.push("scout validation missing shared 10-second absolute deadline");
  }
  if (
    block === undefined ||
    !ts.isBlock(block) ||
    validationDeadlineStatement?.parent !== block ||
    validationRemainingStatement?.parent !== block ||
    block.statements[scoutAttemptIndex + 1] !== validationDeadlineStatement ||
    block.statements[scoutAttemptIndex + 2] !== validationRemainingStatement
  ) {
    issues.push(
      "scout validation deadline and remainder must immediately follow synthesis settlement",
    );
  }

  const validationRemainingBody =
    validationRemaining?.initializer !== undefined &&
    ts.isArrowFunction(validationRemaining.initializer) &&
    validationRemaining.initializer.parameters.length === 0
      ? validationRemaining.initializer.body
      : undefined;
  const remainingCall =
    validationRemainingBody !== undefined &&
    ts.isCallExpression(validationRemainingBody) &&
    isCallAtPath(validationRemainingBody, ["remainingTimeout"])
      ? validationRemainingBody
      : undefined;
  const minCall =
    remainingCall?.arguments[1] !== undefined &&
    isCallAtPath(remainingCall.arguments[1], ["Math", "min"])
      ? remainingCall.arguments[1]
      : undefined;
  const absoluteRemainder = minCall?.arguments[0];
  const dateNow =
    absoluteRemainder !== undefined &&
    ts.isBinaryExpression(absoluteRemainder) &&
    absoluteRemainder.operatorToken.kind === ts.SyntaxKind.MinusToken &&
    isIdentifierNamed(absoluteRemainder.left, "validationDeadlineMs") &&
    isCallAtPath(absoluteRemainder.right, ["Date", "now"]) &&
    absoluteRemainder.right.arguments.length === 0;
  const scoutBudget = minCall?.arguments[1];
  if (
    validationRemainingDeclarations.length !== 1 ||
    remainingCall === undefined ||
    !isIdentifierNamed(
      remainingCall.arguments[0],
      "SCOUT_VALIDATION_LIMIT_MS",
    ) ||
    minCall === undefined ||
    !dateNow ||
    !isCallAtPath(scoutBudget, ["budget"]) ||
    scoutBudget.arguments[0]?.getText(sourceFile) !== '"scout"' ||
    remainingCall.arguments[2]?.getText(sourceFile) !== '"scout validation"'
  ) {
    issues.push(
      "validationRemaining must bound the absolute deadline by the scout remainder",
    );
  }

  const trackedPathCalls = callsNamed(sourceFile, "assertTrackedPaths");
  const trackedPathCall = trackedPathCalls[0];
  const wrapper =
    trackedPathCall === undefined
      ? undefined
      : ancestorCallNamed(trackedPathCall, "awaitWithinDeadline");
  if (
    trackedPathCalls.length !== 1 ||
    wrapper === undefined ||
    wrapper.arguments[1]?.getText(sourceFile) !== "validationRemaining" ||
    trackedPathCall?.arguments[1]?.getText(sourceFile) !==
      "validationRemaining()"
  ) {
    issues.push(
      "tracked-path validation must use awaitWithinDeadline and shared validationRemaining",
    );
  }

  const structuredReturns =
    block !== undefined && ts.isBlock(block)
      ? block.statements.filter(
          (statement): statement is ts.ReturnStatement =>
            ts.isReturnStatement(statement) &&
            statement.expression?.getText(sourceFile) === "structured.data",
        )
      : [];
  const structuredReturn = structuredReturns[0];
  const returnBlock = structuredReturn?.parent;
  const returnIndex =
    returnBlock !== undefined && ts.isBlock(returnBlock)
      ? returnBlock.statements.indexOf(structuredReturn)
      : -1;
  const finalCheck =
    returnBlock !== undefined && ts.isBlock(returnBlock)
      ? returnBlock.statements[returnIndex - 1]
      : undefined;
  if (
    structuredReturns.length !== 1 ||
    finalCheck === undefined ||
    !ts.isExpressionStatement(finalCheck) ||
    !isCallAtPath(finalCheck.expression, ["validationRemaining"]) ||
    finalCheck.expression.arguments.length !== 0
  ) {
    issues.push(
      "scout validation must check the shared remainder immediately before return",
    );
  }
  return issues;
}

function scoutToolGuardContractIssues(runtimeSource: string): string[] {
  const sourceFile = ts.createSourceFile(
    runtimePath,
    runtimeSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const guard = functionDeclarationsNamed(sourceFile, "awaitToolFreeOutcome")[0];
  const text = guard?.getText(sourceFile) ?? "";
  const issues: string[] = [];
  for (const eventType of ["assistant_tool_call", "tool_result"] as const) {
    if (!text.includes(`event.type === "${eventType}"`)) {
      issues.push(`runtime tool guard missing ${eventType} check`);
    }
  }
  if (
    !text.includes(
      'cancelBestEffort(conversation, "scout attempted tool use")',
    )
  ) {
    issues.push("runtime tool guard must cancel best-effort once; received 0 callsites");
  }
  return issues;
}

function scoutReasoningConfigContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues = autonomousStageContractIssues(source);
  const scoutConfigs: ts.VariableDeclaration[] = [];
  const reasoningProperties: ts.PropertyAssignment[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "scoutConfig"
    ) {
      scoutConfigs.push(node);
    }
    if (
      ts.isPropertyAssignment(node) &&
      bindingName(node.name) === "reasoningEffort"
    ) {
      reasoningProperties.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (scoutConfigs.length !== 1) {
    issues.push(
      `expected one scoutConfig declaration; received ${String(scoutConfigs.length)}`,
    );
  }
  const scoutConfig = scoutConfigs[0];
  const initializer = scoutConfig?.initializer;
  if (initializer === undefined) {
    issues.push("scoutConfig must have an initializer");
  } else {
    const stageCalls = callsNamed(initializer, "stageConfig");
    const stageCall = stageCalls[0];
    if (
      stageCalls.length !== 1 ||
      stageCall?.arguments.length !== 3 ||
      stageCall.arguments[0] === undefined ||
      !ts.isStringLiteralLike(stageCall.arguments[0]) ||
      stageCall.arguments[0].text !== "scout" ||
      !hasExpressionPath(stageCall.arguments[1], ["config", "stages", "scout"]) ||
      stageCall.arguments[2]?.kind !== ts.SyntaxKind.TrueKeyword
    ) {
      issues.push("scoutConfig must wrap the exact read-only scout stageConfig");
    }
  }

  if (reasoningProperties.length !== 1) {
    issues.push(
      `expected one reasoningEffort property; received ${String(reasoningProperties.length)}`,
    );
  }
  const reasoningProperty = reasoningProperties[0];
  if (reasoningProperty !== undefined) {
    const value = ts.isAsExpression(reasoningProperty.initializer)
      ? reasoningProperty.initializer.expression
      : reasoningProperty.initializer;
    if (!ts.isStringLiteralLike(value) || value.text !== "low") {
      issues.push("scoutConfig reasoningEffort must be low");
    }

    let insideScoutConfig = false;
    for (
      let current: ts.Node | undefined = reasoningProperty.parent;
      current !== undefined;
      current = current.parent
    ) {
      if (current === scoutConfig) {
        insideScoutConfig = true;
        break;
      }
    }
    if (!insideScoutConfig) {
      issues.push("reasoningEffort must exist only inside scoutConfig");
    }
  }

  const scoutConversation = variableNamed(sourceFile, "scoutConversation");
  const autonomousCall = scoutConversation?.initializer;
  const request =
    autonomousCall !== undefined &&
    ts.isCallExpression(autonomousCall) &&
    autonomousCall.arguments[1] !== undefined &&
    ts.isObjectLiteralExpression(autonomousCall.arguments[1])
      ? autonomousCall.arguments[1]
      : undefined;
  const configProperties =
    request?.properties.filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) && bindingName(property.name) === "config",
    ) ?? [];
  const requestConfig = configProperties[0]?.initializer;
  if (
    configProperties.length !== 1 ||
    !isSingleIdentifierCall(requestConfig, "selectedStageConfig", "scoutConfig")
  ) {
    issues.push("scout autonomous request must consume only scoutConfig");
  }

  return issues;
}

function matcherProofPreloadContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const compilerOptions: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const compilerHost = ts.createCompilerHost(compilerOptions, true);
  compilerHost.fileExists = (fileName) => fileName === sourceFile.fileName;
  compilerHost.getSourceFile = (fileName) =>
    fileName === sourceFile.fileName ? sourceFile : undefined;
  compilerHost.readFile = (fileName) =>
    fileName === sourceFile.fileName ? source : undefined;
  const checker = ts
    .createProgram({
      rootNames: [sourceFile.fileName],
      options: compilerOptions,
      host: compilerHost,
    })
    .getTypeChecker();
  const issues: string[] = [];
  const runtimeImports = sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./codebase-improvement-runtime.ts",
  );
  const importedNames = runtimeImports.flatMap((statement) => {
    const bindings = statement.importClause?.namedBindings;
    return bindings !== undefined && ts.isNamedImports(bindings)
      ? bindings.elements.map((element) =>
          element.propertyName === undefined ? element.name.text : "<aliased>",
        )
      : [];
  });
  const matcherProofArgsImport = runtimeImports
    .flatMap((statement) => {
      const bindings = statement.importClause?.namedBindings;
      return bindings !== undefined && ts.isNamedImports(bindings)
        ? [...bindings.elements]
        : [];
    })
    .find(
      (element) =>
        element.propertyName === undefined &&
        element.name.text === "matcherProofArgs",
    );
  const matcherProofArgsSymbol =
    matcherProofArgsImport === undefined
      ? undefined
      : checker.getSymbolAtLocation(matcherProofArgsImport.name);
  for (const required of [
    "matcherProofArgs",
    "MATCHER_PROOF_PRELOAD_SOURCE",
  ]) {
    if (importedNames.filter((name) => name === required).length !== 1) {
      issues.push(`matcher proof must import ${required} exactly once`);
    }
  }

  const pathDeclarations = variablesNamed(
    sourceFile,
    "MATCHER_PROOF_PRELOAD_PATH",
  );
  const pathDeclaration = pathDeclarations[0];
  if (
    pathDeclarations.length !== 1 ||
    pathDeclaration?.initializer === undefined ||
    !ts.isStringLiteralLike(pathDeclaration.initializer) ||
    pathDeclaration.initializer.text !==
      ".orca/improvement-loop/matcher-proof-preload.ts" ||
    !ts.isVariableDeclarationList(pathDeclaration.parent) ||
    (pathDeclaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    issues.push("matcher proof preload path must be one exact const literal");
  }

  const writers = functionDeclarationsNamed(sourceFile, "writeMatcherProofPreload");
  const writer = writers[0];
  const writerSymbol =
    writer?.name === undefined
      ? undefined
      : checker.getSymbolAtLocation(writer.name);
  const callsBoundTo = (symbol: ts.Symbol | undefined): ts.CallExpression[] => {
    if (symbol === undefined) return [];
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        checker.getSymbolAtLocation(node.expression) === symbol
      ) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return calls;
  };
  const statements = writer?.body?.statements;
  if (
    writers.length !== 1 ||
    writer?.parameters.length !== 1 ||
    writer.parameters[0]?.name.getText(sourceFile) !== "remainingMs" ||
    statements === undefined ||
    statements.length !== 3
  ) {
    issues.push(
      "matcher proof preload writer must be one three-step deadline-bound function",
    );
  } else {
    const deadlineCalls = callsNamed(writer, "awaitWithinDeadline");
    const writeDeadline = deadlineCalls[0];
    const verifyDeadline = deadlineCalls[1];
    const writeStatement = statements[0];
    const writeAwait =
      writeStatement !== undefined &&
      ts.isExpressionStatement(writeStatement) &&
      ts.isAwaitExpression(writeStatement.expression)
        ? writeStatement.expression
        : undefined;
    const writeOperation = writeDeadline?.arguments[2];
    const writeBody =
      writeOperation !== undefined &&
      ts.isArrowFunction(writeOperation) &&
      writeOperation.parameters.length === 0 &&
      writeOperation.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      ) === true &&
      ts.isBlock(writeOperation.body)
        ? writeOperation.body
        : undefined;
    const writeBodyStatement = writeBody?.statements[0];
    const writeBodyAwait =
      writeBody?.statements.length === 1 &&
      writeBodyStatement !== undefined &&
      ts.isExpressionStatement(writeBodyStatement) &&
      ts.isAwaitExpression(writeBodyStatement.expression)
        ? writeBodyStatement.expression
        : undefined;
    const writeCall = writeBodyAwait?.expression;
    if (
      deadlineCalls.length !== 2 ||
      writeAwait?.expression !== writeDeadline ||
      writeDeadline?.arguments.length !== 3 ||
      writeDeadline.arguments[0]?.getText(sourceFile) !==
        '"matcher proof preload write"' ||
      !isIdentifierNamed(writeDeadline.arguments[1], "remainingMs") ||
      !isCallAtPath(writeCall, ["writeText"]) ||
      writeCall.arguments.length !== 2 ||
      !isIdentifierNamed(writeCall.arguments[0], "MATCHER_PROOF_PRELOAD_PATH") ||
      !isIdentifierNamed(writeCall.arguments[1], "MATCHER_PROOF_PRELOAD_SOURCE")
    ) {
      issues.push(
        "matcher proof preload writer must write exact source under shared deadline",
      );
    }

    const verificationStatement = statements[1];
    const verificationDeclaration =
      verificationStatement !== undefined &&
      ts.isVariableStatement(verificationStatement) &&
      verificationStatement.declarationList.declarations.length === 1
        ? verificationStatement.declarationList.declarations[0]
        : undefined;
    const verificationAwait =
      verificationDeclaration?.initializer !== undefined &&
      ts.isAwaitExpression(verificationDeclaration.initializer)
        ? verificationDeclaration.initializer
        : undefined;
    const verifyOperation = verifyDeadline?.arguments[2];
    const readAwait =
      verifyOperation !== undefined &&
      ts.isArrowFunction(verifyOperation) &&
      verifyOperation.parameters.length === 0 &&
      verifyOperation.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      ) === true &&
      ts.isAwaitExpression(verifyOperation.body)
        ? verifyOperation.body
        : undefined;
    const readCall = readAwait?.expression;
    if (
      verificationDeclaration?.name.getText(sourceFile) !== "written" ||
      verificationAwait?.expression !== verifyDeadline ||
      verifyDeadline?.arguments.length !== 3 ||
      verifyDeadline.arguments[0]?.getText(sourceFile) !==
        '"matcher proof preload verification"' ||
      !isIdentifierNamed(verifyDeadline.arguments[1], "remainingMs") ||
      !isCallAtPath(readCall, ["readFile"]) ||
      readCall.arguments.length !== 1 ||
      !isIdentifierNamed(readCall.arguments[0], "MATCHER_PROOF_PRELOAD_PATH")
    ) {
      issues.push(
        "matcher proof preload writer must read exact bytes under shared deadline",
      );
    }

    const guard = statements[2];
    const equalsCall =
      guard !== undefined &&
      ts.isIfStatement(guard) &&
      ts.isPrefixUnaryExpression(guard.expression) &&
      guard.expression.operator === ts.SyntaxKind.ExclamationToken
        ? guard.expression.operand
        : undefined;
    const expectedBytes =
      isCallAtPath(equalsCall, ["written", "equals"]) &&
      equalsCall.arguments.length === 1
        ? equalsCall.arguments[0]
        : undefined;
    if (
      !isCallAtPath(expectedBytes, ["Buffer", "from"]) ||
      expectedBytes.arguments.length !== 2 ||
      !isIdentifierNamed(
        expectedBytes.arguments[0],
        "MATCHER_PROOF_PRELOAD_SOURCE",
      ) ||
      expectedBytes.arguments[1]?.getText(sourceFile) !== '"utf8"' ||
      guard === undefined ||
      !ts.isIfStatement(guard) ||
      directThrowStatement(guard.thenStatement) === undefined
    ) {
      issues.push("matcher proof preload writer must fail closed on byte mismatch");
    }
  }

  const installCalls = callsBoundTo(writerSymbol);
  const installCall = installCalls[0];
  const installAwait =
    installCall?.parent !== undefined && ts.isAwaitExpression(installCall.parent)
      ? installCall.parent
      : undefined;
  const installStatement = installAwait?.parent;
  const installBlock = installStatement?.parent;
  const installIndex =
    installStatement !== undefined &&
    ts.isExpressionStatement(installStatement) &&
    ts.isBlock(installBlock)
      ? installBlock.statements.indexOf(installStatement)
      : -1;
  const remaining = installCall?.arguments[0];
  const remainingBody =
    remaining !== undefined &&
    ts.isArrowFunction(remaining) &&
    remaining.parameters.length === 0
      ? remaining.body
      : undefined;
  if (
    installCalls.length !== 1 ||
    installCall?.arguments.length !== 1 ||
    installAwait?.expression !== installCall ||
    installStatement === undefined ||
    !ts.isExpressionStatement(installStatement) ||
    !isCallAtPath(remainingBody, ["budget"]) ||
    remainingBody.arguments.length !== 1 ||
    remainingBody.arguments[0]?.getText(sourceFile) !== '"reproduce"' ||
    installIndex <= 0 ||
    !ts.isBlock(installBlock) ||
    installBlock.statements[installIndex - 1]?.getText(sourceFile) !==
      'beginBudget("reproduce");'
  ) {
    issues.push(
      "matcher proof preload must install directly after reproduce budget starts",
    );
  }

  const enclosingNamedFunction = (
    node: ts.Node,
  ): ts.FunctionDeclaration | undefined => {
    for (
      let ancestor = node.parent;
      ancestor !== undefined;
      ancestor = ancestor.parent
    ) {
      if (ts.isFunctionDeclaration(ancestor) && ancestor.name !== undefined) {
        return ancestor;
      }
    }
    return undefined;
  };
  const proofCalls = callsBoundTo(matcherProofArgsSymbol);
  const proofWrappers = new Set<ts.Symbol>();
  const wrapperSymbol = (
    wrapper: ts.FunctionDeclaration | undefined,
  ): ts.Symbol | undefined =>
    wrapper?.name === undefined
      ? undefined
      : checker.getSymbolAtLocation(wrapper.name);
  let controls = 0;
  let reds = 0;
  let targeted = 0;
  for (const proofCall of proofCalls) {
    const wrapper = enclosingNamedFunction(proofCall);
    const symbol = wrapperSymbol(wrapper);
    if (symbol !== undefined) {
      proofWrappers.add(symbol);
    }
    if (
      proofCall.arguments.length !== 2 ||
      !isIdentifierNamed(
        proofCall.arguments[1],
        "MATCHER_PROOF_PRELOAD_PATH",
      )
    ) {
      issues.push("every matcher proof command must use the exact preload path");
      continue;
    }
    const args = proofCall.arguments[0];
    if (isSingleIdentifierCall(args, "controlTestArgs", "chosen")) {
      controls += 1;
    } else if (
      isCallAtPath(args, ["namedTestArgs"]) &&
      args.arguments.length === 2 &&
      hasExpressionPath(args.arguments[0], ["chosen", "testPath"]) &&
      isIdentifierNamed(args.arguments[1], "candidateRedTestName")
    ) {
      reds += 1;
    } else if (hasExpressionPath(args, ["candidate", "targetedTestArgs"])) {
      targeted += 1;
    } else {
      issues.push("matcher proof wrapped an unrecognized command");
    }
    if (
      installCall !== undefined &&
      wrapper === undefined &&
      proofCall.getStart(sourceFile) < installCall.getEnd()
    ) {
      issues.push("matcher proof command may not run before preload installation");
    }
  }
  let discoveredWrapper = true;
  while (discoveredWrapper) {
    discoveredWrapper = false;
    for (const wrapper of [...proofWrappers]) {
      for (const call of callsBoundTo(wrapper)) {
        const enclosing = enclosingNamedFunction(call);
        const enclosingSymbol = wrapperSymbol(enclosing);
        if (
          enclosingSymbol !== undefined &&
          !proofWrappers.has(enclosingSymbol)
        ) {
          proofWrappers.add(enclosingSymbol);
          discoveredWrapper = true;
        }
      }
    }
  }
  for (const wrapper of proofWrappers) {
    let hasIndirectReference = false;
    const visitWrapperReferences = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        checker.getSymbolAtLocation(node) === wrapper
      ) {
        const parent = node.parent;
        const isDeclaration =
          ts.isFunctionDeclaration(parent) && parent.name === node;
        const isDirectCall =
          ts.isCallExpression(parent) && parent.expression === node;
        if (!isDeclaration && !isDirectCall) {
          hasIndirectReference = true;
        }
      }
      ts.forEachChild(node, visitWrapperReferences);
    };
    visitWrapperReferences(sourceFile);
    if (hasIndirectReference) {
      issues.push("matcher proof wrapper must only be invoked directly");
    }
    if (
      installCall !== undefined &&
      callsBoundTo(wrapper).some(
        (call) => {
          const enclosingSymbol = wrapperSymbol(enclosingNamedFunction(call));
          return (
            (enclosingSymbol === undefined ||
              !proofWrappers.has(enclosingSymbol)) &&
            call.getStart(sourceFile) < installCall.getEnd()
          );
        },
      )
    ) {
      issues.push("matcher proof wrapper may not run before preload installation");
    }
  }
  if (
    proofCalls.length !== 4 ||
    controls !== 2 ||
    reds !== 1 ||
    targeted !== 1
  ) {
    issues.push(
      `matcher proof must wrap two controls, one RED, and one targeted gate; received ${String(controls)}/${String(reds)}/${String(targeted)}`,
    );
  }
  return issues;
}

function redGateContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const redGateCalls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === "monitor" &&
      node.expression.name.text === "stage" &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === "red-gate"
    ) {
      redGateCalls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const issues: string[] = [];
  if (redGateCalls.length !== 1) {
    issues.push(
      `expected one red-gate stage; received ${String(redGateCalls.length)}`,
    );
    return issues;
  }
  const callback = redGateCalls[0]?.arguments[1];
  if (
    callback === undefined ||
    !ts.isArrowFunction(callback) ||
    !ts.isBlock(callback.body)
  ) {
    issues.push("red-gate stage must use a direct block callback");
    return issues;
  }

  const statements = callback.body.statements;
  const received = (index: number): string =>
    statements[index]?.getText(sourceFile) ?? "<missing>";
  const awaitedVariableCall = (
    index: number,
    variable: string,
    callee: string,
    label: string,
  ): ts.CallExpression | undefined => {
    const statement = statements[index];
    const declaration =
      statement !== undefined &&
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      statement.declarationList.declarations.length === 1
        ? statement.declarationList.declarations[0]
        : undefined;
    const initializer = declaration?.initializer;
    if (
      declaration === undefined ||
      !ts.isIdentifier(declaration.name) ||
      declaration.name.text !== variable ||
      initializer === undefined ||
      !ts.isAwaitExpression(initializer) ||
      !isCallAtPath(initializer.expression, [callee])
    ) {
      issues.push(
        `red-gate step ${String(index + 1)} must be ${label}; received ${received(index)}`,
      );
      return undefined;
    }
    return initializer.expression;
  };
  const validateRunLogged = (
    call: ts.CallExpression,
    expectedArgs: "control" | "target",
    label: string,
  ): void => {
    if (call.arguments.length !== 3) {
      issues.push(`${label} must pass exactly three runLogged arguments`);
      return;
    }
    const binary = call.arguments[0];
    if (!ts.isStringLiteralLike(binary) || binary.text !== "bun") {
      issues.push(`${label} binary must be the exact literal bun`);
    }
    const args = call.arguments[1];
    const proofArgs =
      isCallAtPath(args, ["matcherProofArgs"]) &&
      args.arguments.length === 2 &&
      isIdentifierNamed(args.arguments[1], "MATCHER_PROOF_PRELOAD_PATH")
        ? args.arguments[0]
        : undefined;
    const hasExpectedArgs =
      expectedArgs === "control"
        ? isSingleIdentifierCall(proofArgs, "controlTestArgs", "chosen")
        : isCallAtPath(proofArgs, ["namedTestArgs"]) &&
          proofArgs.arguments.length === 2 &&
          hasExpressionPath(proofArgs.arguments[0], ["chosen", "testPath"]) &&
          isIdentifierNamed(proofArgs.arguments[1], "candidateRedTestName");
    if (!hasExpectedArgs) {
      issues.push(`${label} arguments must be ${expectedArgs}`);
    }
    const budget = call.arguments[2];
    if (
      !isCallAtPath(budget, ["budget"]) ||
      budget.arguments.length !== 1 ||
      !ts.isStringLiteralLike(budget.arguments[0]) ||
      budget.arguments[0].text !== "reproduce"
    ) {
      issues.push(`${label} must use the remaining reproduce budget`);
    }
  };
  const validateLogAppend = (
    index: number,
    expected: string,
    label: string,
  ): void => {
    const statement = statements[index];
    const call =
      statement !== undefined && ts.isExpressionStatement(statement)
        ? statement.expression
        : undefined;
    if (
      !isCallAtPath(call, ["report", "validation", "push"]) ||
      call.arguments.length !== 1 ||
      !isIdentifierNamed(call.arguments[0], expected)
    ) {
      issues.push(
        `red-gate step ${String(index + 1)} must be ${label}; received ${received(index)}`,
      );
    }
  };

  const controlCall = awaitedVariableCall(
    0,
    "control",
    "runLogged",
    "positive control command",
  );
  if (controlCall !== undefined) {
    validateRunLogged(controlCall, "control", "positive control command");
  }
  validateLogAppend(1, "control", "positive control log");

  const guardedTargetCall = awaitedVariableCall(
    2,
    "red",
    "runTargetAfterPositiveControl",
    "validated exact named red command",
  );
  if (guardedTargetCall !== undefined) {
    const [control, controlName, runner] = guardedTargetCall.arguments;
    if (
      guardedTargetCall.arguments.length !== 3 ||
      !isIdentifierNamed(control, "control") ||
      !isSingleIdentifierCall(controlName, "controlTestName", "chosen") ||
      runner === undefined ||
      !ts.isArrowFunction(runner) ||
      runner.parameters.length !== 0 ||
      !ts.isCallExpression(runner.body) ||
      !isCallAtPath(runner.body, ["runLogged"])
    ) {
      issues.push(
        "validated target must guard one direct runLogged continuation with the exact control name",
      );
    } else {
      validateRunLogged(runner.body, "target", "exact named red command");
    }
  }
  validateLogAppend(3, "red", "targeted red log");

  const assertionStatement = statements[4];
  const assertion =
    assertionStatement !== undefined &&
    ts.isExpressionStatement(assertionStatement)
      ? assertionStatement.expression
      : undefined;
  if (
    !isCallAtPath(assertion, ["assertRedGateEvidence"]) ||
    assertion.arguments.length !== 5 ||
    !isIdentifierNamed(assertion.arguments[0], "control") ||
    !isSingleIdentifierCall(
      assertion.arguments[1],
      "controlTestName",
      "chosen",
    ) ||
    !isIdentifierNamed(assertion.arguments[2], "red") ||
    !isIdentifierNamed(assertion.arguments[3], "candidateRedTestName") ||
    !isCallAtPath(assertion.arguments[4], ["candidateRedMarker"]) ||
    assertion.arguments[4].arguments.length !== 1 ||
    !hasExpressionPath(assertion.arguments[4].arguments[0], ["chosen", "id"])
  ) {
    issues.push(
      `red-gate step 5 must be red evidence assertion; received ${received(4)}`,
    );
  }

  const persistenceStatement = statements[5];
  const persistence =
    persistenceStatement === undefined
      ? undefined
      : callsNamed(persistenceStatement, "writeText")[0];
  const persistenceWrapper =
    persistence === undefined ? undefined : immediateDeadlineWrapper(persistence);
  if (
    statements.length !== 6 ||
    persistence === undefined ||
    persistence.arguments.length !== 2 ||
    !isIdentifierNamed(persistence.arguments[0], "RED_DIFF_PATH") ||
    !isIdentifierNamed(persistence.arguments[1], "capturedTestDiff") ||
    persistenceWrapper?.arguments[0]?.getText(sourceFile) !==
      '"RED diff write"' ||
    persistenceWrapper.arguments[1]?.getText(sourceFile) !==
      '() => budget("reproduce")'
  ) {
    issues.push(
      `red-gate step 6 must be deadline-bound red diff persistence; received ${received(5)}`,
    );
  }
  return issues;
}

function baselinePositiveControlContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const declarations = variablesNamed(sourceFile, "baselineControl");
  const declaration = declarations[0];
  const initializer = declaration?.initializer;
  const controlCall =
    initializer !== undefined &&
    ts.isAwaitExpression(initializer) &&
    isCallAtPath(initializer.expression, ["runLogged"])
      ? initializer.expression
      : undefined;
  const statement = declaration?.parent.parent;
  const block = statement?.parent;
  const controlIndex =
    statement !== undefined &&
    ts.isVariableStatement(statement) &&
    ts.isBlock(block)
       ? block.statements.indexOf(statement)
       : -1;
  const [binary, args, remaining] = controlCall?.arguments ?? [];
  const proofArgs =
    isCallAtPath(args, ["matcherProofArgs"]) &&
    args.arguments.length === 2 &&
    isIdentifierNamed(args.arguments[1], "MATCHER_PROOF_PRELOAD_PATH")
      ? args.arguments[0]
      : undefined;
  if (
    declarations.length !== 1 ||
    controlCall === undefined ||
    controlCall.arguments.length !== 3 ||
    binary === undefined ||
    !ts.isStringLiteralLike(binary) ||
    binary.text !== "bun" ||
    !isSingleIdentifierCall(proofArgs, "controlTestArgs", "chosen") ||
    !isCallAtPath(remaining, ["budget"]) ||
    remaining.arguments.length !== 1 ||
    !ts.isStringLiteralLike(remaining.arguments[0]) ||
    remaining.arguments[0].text !== "reproduce" ||
    controlIndex < 0 ||
    !ts.isBlock(block)
  ) {
    issues.push("baseline positive control must run directly on the reproduce budget");
    return issues;
  }

  const logStatement = block.statements[controlIndex + 1];
  const logCall =
    logStatement !== undefined && ts.isExpressionStatement(logStatement)
      ? logStatement.expression
      : undefined;
  const assertionStatement = block.statements[controlIndex + 2];
  const assertion =
    assertionStatement !== undefined && ts.isExpressionStatement(assertionStatement)
      ? assertionStatement.expression
      : undefined;
  const guardedStatement = block.statements[controlIndex + 3];
  const guardedDeclaration =
    guardedStatement !== undefined && ts.isVariableStatement(guardedStatement)
      ? guardedStatement.declarationList.declarations[0]
      : undefined;
  const guardedInitializer = guardedDeclaration?.initializer;
  const guardedCall =
    guardedInitializer !== undefined &&
    ts.isAwaitExpression(guardedInitializer) &&
    isCallAtPath(guardedInitializer.expression, ["withStableIgnoredOrcaGuard"])
      ? guardedInitializer.expression
      : undefined;
  if (
    !isCallAtPath(logCall, ["report", "validation", "push"]) ||
    logCall.arguments.length !== 1 ||
    !isIdentifierNamed(logCall.arguments[0], "baselineControl") ||
    !isCallAtPath(assertion, ["assertPositiveControlEvidence"]) ||
    assertion.arguments.map((argument) => argument.getText(sourceFile)).join("\n") !==
      ["baselineControl", "controlTestName(chosen)"].join("\n") ||
    guardedDeclaration?.name.getText(sourceFile) !== "guardedReproduction" ||
    guardedCall === undefined ||
    guardedCall.arguments[0]?.getText(sourceFile) !== '"reproduce"' ||
    propertyCallsNamed(guardedCall, "autonomous").length !== 1
  ) {
    issues.push(
      "logged exact-name baseline positive control must directly dominate reproduce agent execution",
    );
  }
  return issues;
}

function semanticControlPreservationContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const baselineSource = variableNamed(sourceFile, "baselineTestSource");
  const baselineDecode = baselineSource?.initializer;
  if (
    !isCallAtPath(baselineDecode, ["decodeUtf8Source"]) ||
    baselineDecode.arguments.length !== 2 ||
    baselineDecode.arguments[0]?.getText(sourceFile) !== "snapshot.bytes" ||
    baselineDecode.arguments[1]?.getText(sourceFile) !== "chosen.testPath"
  ) {
    issues.push(
      "reproduce must retain the complete baseline test source losslessly",
    );
  }
  const controlSource = variableNamed(sourceFile, "controlSource");
  const candidateDecode = controlSource?.initializer;
  const candidateBytes =
    candidateDecode !== undefined &&
    isCallAtPath(candidateDecode, ["decodeUtf8Source"])
      ? candidateDecode.arguments[0]
      : undefined;
  const candidateDeadline =
    candidateBytes !== undefined && ts.isAwaitExpression(candidateBytes)
      ? candidateBytes.expression
      : undefined;
  const candidateCallback =
    isCallAtPath(candidateDeadline, ["awaitWithinDeadline"])
      ? candidateDeadline.arguments[2]
      : undefined;
  const candidateRead =
    candidateCallback !== undefined &&
    ts.isArrowFunction(candidateCallback) &&
    ts.isAwaitExpression(candidateCallback.body) &&
    isCallAtPath(candidateCallback.body.expression, ["readFile"])
      ? candidateCallback.body.expression
      : undefined;
  if (
    !isCallAtPath(candidateDecode, ["decodeUtf8Source"]) ||
    candidateDecode.arguments.length !== 2 ||
    !isCallAtPath(candidateDeadline, ["awaitWithinDeadline"]) ||
    candidateDeadline.arguments[0]?.getText(sourceFile) !==
      '"reproduced test read"' ||
    candidateDeadline.arguments[1]?.getText(sourceFile) !==
      '() => budget("reproduce")' ||
    candidateRead?.arguments.length !== 1 ||
    candidateRead.arguments[0]?.getText(sourceFile) !== "chosen.testPath" ||
    candidateDecode.arguments[1]?.getText(sourceFile) !== "chosen.testPath"
  ) {
    issues.push("reproduce must decode candidate test bytes losslessly");
  }

  const evidenceCalls = callsNamed(sourceFile, "semanticPositiveControlEvidence");
  const argumentLists = evidenceCalls.map((call) =>
    call.arguments.map((argument) => argument.getText(sourceFile)).join("\n"),
  );
  if (
    argumentLists.length !== 2 ||
    !argumentLists.includes(["chosen", "baselineTestSource"].join("\n")) ||
    !argumentLists.includes(
      ["chosen", "controlSource", "baselineTestSource"].join("\n"),
    )
  ) {
    issues.push(
      "post-reproduce semantic evidence must compare the full baseline source",
    );
  }

  const helper = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "semanticPositiveControlEvidence",
  );
  const baselineParameter = helper?.parameters[2];
  const semanticCalls =
    helper === undefined ? [] : callsNamed(helper, "assertSemanticPositiveControl");
  const options = semanticCalls[0]?.arguments[1];
  const baselineProperties =
    options !== undefined && ts.isObjectLiteralExpression(options)
      ? options.properties.filter(
          (property) =>
            ts.isShorthandPropertyAssignment(property) &&
            property.name.text === "baselineSource",
        )
      : [];
  const candidateMarkerProperties =
    options !== undefined && ts.isObjectLiteralExpression(options)
      ? options.properties.filter(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(sourceFile) === "candidateRedMarker" &&
            property.initializer.getText(sourceFile) ===
              "candidateRedMarker(candidate.id)",
        )
      : [];
  const additiveEvidenceCall = evidenceCalls.find(
    (call) =>
      call.arguments.length === 3 &&
      call.arguments[2]?.getText(sourceFile) === "baselineTestSource",
  );
  const evidenceAssignment = additiveEvidenceCall?.parent;
  const evidenceStatement =
    evidenceAssignment !== undefined &&
    ts.isBinaryExpression(evidenceAssignment) &&
    evidenceAssignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    evidenceAssignment.left.getText(sourceFile) === "semanticControlEvidence" &&
    evidenceAssignment.right === additiveEvidenceCall &&
    ts.isExpressionStatement(evidenceAssignment.parent)
      ? evidenceAssignment.parent
      : undefined;
  const evidenceBlock = evidenceStatement?.parent;
  const evidenceIndex =
    evidenceStatement !== undefined && ts.isBlock(evidenceBlock)
      ? evidenceBlock.statements.indexOf(evidenceStatement)
      : -1;
  const nameStatement =
    evidenceIndex >= 0 && ts.isBlock(evidenceBlock)
      ? evidenceBlock.statements[evidenceIndex + 1]
      : undefined;
  const nameDeclaration =
    nameStatement !== undefined &&
    ts.isVariableStatement(nameStatement) &&
    (nameStatement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
    nameStatement.declarationList.declarations.length === 1
      ? nameStatement.declarationList.declarations[0]
      : undefined;
  if (
    !isIdentifierNamed(nameDeclaration?.name, "candidateRedTestName") ||
    !hasExpressionPath(nameDeclaration.initializer, [
      "semanticControlEvidence",
      "candidateRedTestName",
    ])
  ) {
    issues.push(
      "post-reproduce semantic evidence must immediately capture candidate RED test name",
    );
  }
  const missingNameGuard =
    evidenceIndex >= 0 && ts.isBlock(evidenceBlock)
      ? evidenceBlock.statements[evidenceIndex + 2]
      : undefined;
  const missingNameThrow =
    missingNameGuard !== undefined &&
    ts.isIfStatement(missingNameGuard) &&
    missingNameGuard.expression.getText(sourceFile) ===
      "candidateRedTestName === undefined" &&
    ts.isBlock(missingNameGuard.thenStatement) &&
    missingNameGuard.thenStatement.statements.length === 1 &&
    ts.isThrowStatement(missingNameGuard.thenStatement.statements[0])
      ? missingNameGuard.thenStatement.statements[0].expression
      : undefined;
  if (
    missingNameThrow === undefined ||
    !ts.isNewExpression(missingNameThrow) ||
    !isIdentifierNamed(
      missingNameThrow.expression,
      "InvalidReproductionProofError",
    ) ||
    missingNameThrow.arguments?.[0]?.getText(sourceFile) !==
      '"target-wrong-pattern"'
  ) {
    issues.push(
      "post-reproduce semantic evidence must fail closed when candidate RED test name is missing",
    );
  }
  if (
    baselineParameter?.name.getText(sourceFile) !== "baselineSource" ||
    semanticCalls.length !== 1 ||
    baselineProperties.length !== 1
  ) {
    issues.push("semantic helper must enforce additive-only source preservation");
  }
  if (candidateMarkerProperties.length !== 1) {
    issues.push("semantic helper must bind the exact candidate RED marker");
  }
  return issues;
}

function semanticCausalityRuntimeContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    runtimePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const helper = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "expressionProductionState",
  );
  if (helper?.body === undefined) {
    return ["runtime must define expressionProductionState"];
  }
  return helper.body.getText(sourceFile).includes("ts.forEachChild(node")
    ? ["production causality may not use generic descendant scanning"]
    : [];
}

function rejectedArtifactBudgetContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const writes: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      isCallAtPath(node, ["writeJson"]) &&
      node.arguments.length === 2 &&
      isIdentifierNamed(node.arguments[0], "artifactPath") &&
      isIdentifierNamed(node.arguments[1], "rejected")
    ) {
      writes.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const issues: string[] = [];
  const expectedLabels = [
    "rejected candidate artifact write",
    "rejected restoration artifact write",
  ] as const;
  if (writes.length !== expectedLabels.length) {
    return [
      `expected two rejected-artifact writes; received ${String(writes.length)}`,
    ];
  }

  for (const [index, write] of writes.entries()) {
    const expected = expectedLabels[index]!;
    const wrapper = immediateDeadlineWrapper(write);
    const awaited = wrapper?.parent;
    const statement = awaited?.parent;
    if (
      wrapper === undefined ||
      wrapper.arguments[0]?.getText(sourceFile) !== JSON.stringify(expected) ||
      wrapper.arguments[1]?.getText(sourceFile) !==
        '() => budget("reproduce")' ||
      awaited === undefined ||
      !ts.isAwaitExpression(awaited) ||
      !ts.isExpressionStatement(statement) ||
      statement.expression !== awaited
    ) {
      issues.push(
        `rejected-artifact write ${String(index + 1)} must bind ${expected} to the reproduce deadline`,
      );
    }
  }
  for (const stale of [
    "red diff persistence",
    "rejected candidate persistence",
    "rejected restoration persistence",
  ]) {
    if (source.includes(`assertRemainingBudget(budget("reproduce"), "${stale}")`)) {
      issues.push(`post-write-only assertion must be removed: ${stale}`);
    }
  }
  return issues;
}

function reproduceEventContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const helperCalls = callsNamed(sourceFile, "awaitExpectedFileChange");
  if (helperCalls.length !== 1) {
    issues.push(
      `expected one awaitExpectedFileChange call; received ${String(helperCalls.length)}`,
    );
  } else {
    const helper = helperCalls[0]!;
    if (helper.arguments[0]?.getText(sourceFile) !== "reproduceConversation") {
      issues.push("reproduce helper must observe reproduceConversation");
    }
    if (helper.arguments[1]?.getText(sourceFile) !== "chosen.testPath") {
      issues.push("reproduce helper expected path must be chosen.testPath");
    }
    const outcomeClosure = helper.arguments[2];
    if (outcomeClosure === undefined || !ts.isArrowFunction(outcomeClosure)) {
      issues.push("reproduce helper must receive a bounded outcome closure");
    } else {
      const boundedCalls = callsNamed(
        outcomeClosure,
        "awaitConversationWithinBudget",
      );
      if (
        boundedCalls.length !== 1 ||
        boundedCalls[0]?.arguments.length !== 4 ||
        boundedCalls[0]?.arguments[0]?.getText(sourceFile) !==
          "reproduceConversation" ||
        boundedCalls[0]?.arguments[1]?.getText(sourceFile) !==
          'budget("reproduce")' ||
        boundedCalls[0]?.arguments[2]?.getText(sourceFile) !== '"reproduce"' ||
        boundedCalls[0]?.arguments[3]?.getText(sourceFile) !== "recordUsage"
      ) {
        issues.push("reproduce helper closure must retain the bounded outcome");
      }
    }
    if (
      !ts.isAwaitExpression(helper.parent) ||
      !ts.isVariableDeclaration(helper.parent.parent) ||
      helper.parent.parent.name.getText(sourceFile) !== "reproduceResult"
    ) {
      issues.push("reproduce helper result must bind to reproduceResult");
    }
  }

  const result = variableNamed(sourceFile, "reproduceResult");
  const resultStatement = result?.parent.parent;
  const resultBlock = resultStatement?.parent;
  if (
    resultStatement === undefined ||
    resultBlock === undefined ||
    !ts.isVariableStatement(resultStatement) ||
    !ts.isBlock(resultBlock)
  ) {
    issues.push("reproduce result must be owned by a block");
    return issues;
  }
  const resultIndex = resultBlock.statements.indexOf(resultStatement);
  const terminalStatements = resultBlock.statements.slice(
    resultIndex + 1,
    resultIndex + 4,
  );
  const terminalText = terminalStatements
    .map((statement) => statement.getText(sourceFile))
    .join("\n");
  if (!terminalText.startsWith("const outcome = reproduceResult.outcome;")) {
    issues.push("reproduce must always read its terminal outcome");
  }
  if (!terminalText.includes('if (outcome.type !== "success")')) {
    issues.push("reproduce must always reject a non-success terminal outcome");
  }
  if (!terminalText.endsWith("recordUsage(outcome.result.usage);")) {
    issues.push("reproduce must always retain terminal usage");
  }
  if (terminalStatements.some(ts.isIfStatement) &&
      terminalStatements.some((statement) =>
        statement.getText(sourceFile).includes("expectedFileChangeState"))) {
    issues.push("terminal outcome and usage must not depend on file-change proof");
  }

  const proofCalls = callsNamed(sourceFile, "hasConfirmedExpectedFileChange");
  if (proofCalls.length !== 1) {
    issues.push(
      `expected one terminal/event file-change proof; received ${String(proofCalls.length)}`,
    );
  } else {
    const proof = proofCalls[0]!;
    const received = proof.arguments.map((argument) =>
      argument.getText(sourceFile),
    );
    if (
      received.length !== 3 ||
      received[0] !== "reproduceResult.expectedFileChangeState" ||
      received[1] !== "paths" ||
      received[2] !== "chosen.testPath"
    ) {
      issues.push(
        `terminal/event file-change proof arguments invalid: ${received.join(", ")}`,
      );
    }
    const negation = proof.parent;
    const guard = negation.parent;
    if (
      !ts.isPrefixUnaryExpression(negation) ||
      negation.operator !== ts.SyntaxKind.ExclamationToken ||
      !ts.isIfStatement(guard) ||
      guard.expression !== negation
    ) {
      issues.push(
        "terminal/event file-change proof must directly guard invalid proof",
      );
    } else {
      const body = guard.thenStatement;
      const rejection =
        ts.isBlock(body) &&
        body.statements.length === 1 &&
        ts.isThrowStatement(body.statements[0])
          ? body.statements[0].expression
          : undefined;
      const argumentsList =
        rejection !== undefined && ts.isNewExpression(rejection)
          ? rejection.arguments
          : undefined;
      if (
        rejection === undefined ||
        !ts.isNewExpression(rejection) ||
        !isIdentifierNamed(rejection.expression, "InvalidReproductionProofError") ||
        argumentsList === undefined ||
        argumentsList.length !== 2 ||
        !ts.isStringLiteralLike(argumentsList[0]) ||
        argumentsList[0].text !== "no-change" ||
        argumentsList[1]?.getText(sourceFile) !==
          "`reproduce did not provide confirmed change evidence for ${chosen.testPath}`"
      ) {
        issues.push(
          "terminal/event proof guard must throw the typed accurate no-change rejection",
        );
      }
    }
  }

  return issues;
}

function rankedReproductionContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const reportTypeStart = source.indexOf("interface RunReport {");
  const reportTypeEnd = source.indexOf("\n}", reportTypeStart);
  const reportType = source.slice(reportTypeStart, reportTypeEnd);
  const rejectedTypeStart = source.indexOf("interface RejectedCandidateEvidence {");
  const rejectedTypeEnd = source.indexOf("\n}", rejectedTypeStart);
  const rejectedType = source.slice(rejectedTypeStart, rejectedTypeEnd);

  if (!reportType.includes("rejectedCandidates: RejectedCandidateEvidence[];")) {
    issues.push("report must own rejected candidate evidence");
  }
  for (const field of [
    "candidate: Candidate;",
    'control: ScoutResult["selectedControl"];',
    "reason: string;",
    "redDiff: string;",
    "validation: CommandLog[];",
    "snapshotSha256: string;",
  ]) {
    if (!rejectedType.includes(field)) {
      issues.push(`rejected evidence missing ${field}`);
    }
  }

  const fallbackCalls = callsNamed(sourceFile, "runRankedCandidateFallback");
  if (fallbackCalls.length !== 1) {
    issues.push(
      `expected one ranked candidate fallback; received ${String(fallbackCalls.length)}`,
    );
    return issues;
  }
  const fallback = fallbackCalls[0]!;
  if (
    fallback.arguments[0]?.getText(sourceFile) !==
    "scoutResult.rankedCandidateIds"
  ) {
    issues.push("ranked fallback must consume scout ranking directly");
  }
  const attempt = fallback.arguments[1];
  if (
    attempt === undefined ||
    !(ts.isArrowFunction(attempt) || ts.isFunctionExpression(attempt))
  ) {
    issues.push("ranked fallback must own an attempt callback");
    return issues;
  }
  const attemptText = attempt.getText(sourceFile);
  if (!attemptText.includes("hydrateCandidate(scoutResult, control)")) {
    issues.push("each attempted rank must hydrate its own control lazily");
  }
  if (
    !attemptText.includes("scoutResult.selectedControl") ||
    !attemptText.includes("await resolveFallbackControl(")
  ) {
    issues.push("fallback controls must be resolved only when their rank is attempted");
  }
  if (!attemptText.includes('budget("reproduce")')) {
    issues.push("all ranked attempts must share the reproduce budget");
  }
  if (!attemptText.includes("report.rejectedCandidates.push({")) {
    issues.push("rejected attempts must append full report evidence");
  }
  for (const property of [
    "candidate:",
    "control:",
    "reason:",
    "redDiff:",
    "validation:",
    "snapshotSha256:",
  ]) {
    if (!attemptText.includes(property)) {
      issues.push(`rejected attempt artifact missing ${property}`);
    }
  }
  if (
    !attemptText.includes(
      "validation: [...report.validation.slice(validationStart)]",
    )
  ) {
    issues.push("rejected validation must be copied from candidate-local logs");
  }
  if (!source.includes("structured.data.candidateId !== candidateId")) {
    issues.push("lazy fallback control must match the attempted candidate ID");
  }
  if (
    !attemptText.includes("restore: async () =>") ||
    !attemptText.includes("await restoreExactTestSnapshot(")
  ) {
    issues.push("ranked rejection must restore and verify its exact test snapshot");
  }
  const captureCalls = callsNamed(attempt, "captureExactTestSnapshot");
  const restoreCalls = callsNamed(attempt, "restoreExactTestSnapshot");
  const snapshotDeclarations = variablesNamed(attempt, "snapshot");
  const attemptBlock = ts.isBlock(attempt.body) ? attempt.body : undefined;
  const directTry = attemptBlock?.statements.find(ts.isTryStatement);
  const snapshotDeclaration = snapshotDeclarations[0];
  const snapshotStatement = snapshotDeclaration?.parent.parent;
  const snapshotInitializer = snapshotDeclaration?.initializer;
  const snapshotInitializerExpression =
    snapshotInitializer !== undefined && ts.isAwaitExpression(snapshotInitializer)
      ? snapshotInitializer.expression
      : snapshotInitializer;
  if (
    captureCalls.length !== 1 ||
    snapshotDeclarations.length !== 1 ||
    snapshotInitializerExpression !== captureCalls[0]
  ) {
    issues.push("ranked rejection must capture one uniquely bound pre-edit snapshot");
  }
  if (
    attemptBlock === undefined ||
    directTry === undefined ||
    snapshotStatement === undefined ||
    snapshotStatement.parent !== attemptBlock ||
    snapshotStatement.getStart(sourceFile) >= directTry.getStart(sourceFile)
  ) {
    issues.push("ranked snapshot capture must directly precede the edit try block");
  }
  const restoreCall = restoreCalls[0];
  if (
    restoreCalls.length !== 1 ||
    restoreCall?.arguments[1]?.getText(sourceFile) !== "snapshot"
  ) {
    issues.push("ranked restoration must use the unique pre-edit snapshot binding");
  }
  let restoreClosure: ts.ArrowFunction | ts.FunctionExpression | undefined;
  for (
    let parent = restoreCall?.parent;
    parent !== undefined && parent !== attempt;
    parent = parent.parent
  ) {
    if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) {
      restoreClosure = parent;
      break;
    }
  }
  if (
    restoreClosure === undefined ||
    restoreClosure.parameters.length !== 0 ||
    variablesNamed(restoreClosure.body, "snapshot").length !== 0
  ) {
    issues.push("ranked restoration closure must not shadow the snapshot binding");
  }
  const restorationDeclarations =
    restoreClosure === undefined
      ? []
      : variablesNamed(restoreClosure.body, "restoration");
  const restorationInitializer = restorationDeclarations[0]?.initializer;
  const restorationStatement = restorationDeclarations[0]?.parent.parent;
  if (
    restorationDeclarations.length !== 1 ||
    restoreCall === undefined ||
    restorationInitializer === undefined ||
    !ts.isAwaitExpression(restorationInitializer) ||
    restorationInitializer.expression !== restoreCall ||
    restorationStatement === undefined ||
    !ts.isVariableStatement(restorationStatement) ||
    restoreClosure === undefined ||
    !ts.isBlock(restoreClosure.body) ||
    restorationStatement.parent !== restoreClosure.body
  ) {
    issues.push(
      "ranked restoration must be one direct awaited binding without recovery",
    );
  }
  if (
    !attemptText.includes("isInvalidReproductionProof(") ||
    !attemptText.includes("throw error;")
  ) {
    issues.push("only invalid proof may fall back; operational failures must escape");
  }

  const gatherCalls = callsNamed(sourceFile, "gatherRequired");
  const latestCommit = gatherCalls.find((call) => {
    const command = call.arguments[0];
    const args = staticStringArray(call.arguments[1]);
    return (
      command !== undefined &&
      ts.isStringLiteralLike(command) &&
      command.text === "git" &&
      args !== undefined &&
      ((args[0] === "show" && args.includes("HEAD")) ||
        (args[0] === "log" && args.includes("-1")))
    );
  });
  if (latestCommit === undefined) {
    issues.push("scout packet must include latest commit evidence");
  } else {
    const latestArgs = staticStringArray(latestCommit.arguments[1]) ?? [];
    if (
      latestArgs[0] !== "show" ||
      !latestArgs.includes("HEAD") ||
      !latestArgs.includes("--name-only") ||
      !latestArgs.includes("--first-parent") ||
      !latestArgs.some((arg) => arg.startsWith("--format=Latest commit:")) ||
      latestArgs.includes("--")
    ) {
      issues.push(
        "latest commit evidence must include subject and all first-parent changed paths",
      );
    }
    const declaration = latestCommit.parent;
    const name =
      ts.isAwaitExpression(declaration) &&
      ts.isVariableDeclaration(declaration.parent)
        ? declaration.parent.name.getText(sourceFile)
        : undefined;
    const inclusionCalls = callsNamed(sourceFile, "latestCommitEvidencePrefix");
    if (
      name === undefined ||
      inclusionCalls.length !== 1 ||
      inclusionCalls[0]?.arguments[0]?.getText(sourceFile) !== `${name}.stdout`
    ) {
      issues.push("latest commit command output must reach scout evidence");
    }
  }

  return issues;
}

function reproducePromptContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "reproducePrompt"
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const issues: string[] = [];
  if (declarations.length !== 1) {
    issues.push(
      `expected one reproducePrompt function; received ${String(declarations.length)}`,
    );
  }
  const declaration = declarations[0];
  if (declaration?.body === undefined) return issues;

  const body = declaration.body.getText(sourceFile);
  const statements = [...declaration.body.statements];
  if (statements.length !== 1 || !ts.isReturnStatement(statements[0])) {
    issues.push("reproducePrompt body must contain exactly one return statement");
  }
  const returns = statements.filter(ts.isReturnStatement);
  if (returns.length !== 1) {
    issues.push(
      `reproducePrompt body must have one direct return; received ${String(returns.length)}`,
    );
    return issues;
  }

  const expression = returns[0]?.expression;
  if (
    expression === undefined ||
    !ts.isCallExpression(expression) ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== "join" ||
    !ts.isArrayLiteralExpression(expression.expression.expression)
  ) {
    issues.push("reproducePrompt return must join a direct array literal");
    return issues;
  }
  if (
    expression.arguments.length !== 1 ||
    !ts.isStringLiteralLike(expression.arguments[0]) ||
    expression.arguments[0].text !== "\n"
  ) {
    issues.push('reproducePrompt return must join with exactly "\\n"');
  }

  const emittedElements = expression.expression.expression.elements.map(
    (element) => element.getText(sourceFile),
  );
  for (const snippet of REQUIRED_REPRODUCE_PROMPT_SNIPPETS) {
    if (!emittedElements.includes(snippet)) {
      issues.push(`reproducePrompt missing control contract: ${snippet}`);
    }
  }
  for (const directive of STALE_REPRODUCE_PROMPT_DIRECTIVES) {
    if (body.includes(directive)) {
      issues.push(`reproducePrompt retains stale directive: ${directive}`);
    }
  }
  return issues;
}

function boundedRuntimeGuardContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let runtimeImportCount = 0;
  let localDeclarationCount = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./codebase-improvement-runtime.ts" &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      runtimeImportCount += node.importClause.namedBindings.elements.filter(
        (element) => element.name.text === "awaitBounded",
      ).length;
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "awaitBounded"
    ) {
      localDeclarationCount += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const issues: string[] = [];
  if (runtimeImportCount !== 1) {
    issues.push(
      `workflow must import awaitBounded once from runtime; received ${String(runtimeImportCount)}`,
    );
  }
  if (localDeclarationCount !== 0) {
    issues.push(
      `workflow must not shadow runtime awaitBounded; received ${String(localDeclarationCount)} local declarations`,
    );
  }
  return issues;
}

function timeoutUsageContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const runtimeImports = sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./codebase-improvement-runtime.ts",
  );
  const timeoutImports = runtimeImports.flatMap((statement) => {
    const bindings = statement.importClause?.namedBindings;
    return bindings !== undefined && ts.isNamedImports(bindings)
      ? bindings.elements.filter(
          (element) =>
            element.propertyName === undefined &&
            element.name.text === "ConversationTimeoutError",
        )
      : [];
  });
  const wrappers = functionDeclarationsNamed(
    sourceFile,
    "awaitConversationWithinBudget",
  );
  const wrapper = wrappers[0];
  if (
    timeoutImports.length !== 1 ||
    wrappers.length !== 1 ||
    wrapper?.parameters
      .map((parameter) => parameter.name.getText(sourceFile))
      .join("\n") !==
      ["conversation", "availableMs", "stage", "recordUsage"].join("\n")
  ) {
    issues.push(
      "shared conversation wrapper must receive the canonical timeout and usage recorder",
    );
  }
  const calls = callsNamed(sourceFile, "awaitConversationWithinBudget");
  if (
    calls.length !== 7 ||
    calls.some(
      (call) =>
        call.arguments.length !== 4 ||
        call.arguments[3]?.getText(sourceFile) !== "recordUsage",
    )
  ) {
    issues.push(
      "every non-scout conversation must pass the run usage recorder once",
    );
  }
  return issues;
}

function runtimeDeadlineOwnershipContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    runtimePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const body = (name: string): string =>
    functionDeclarationsNamed(sourceFile, name)[0]?.body?.getText(sourceFile) ?? "";
  const bounded = body("awaitBounded");
  const retry = body("awaitOneTimeoutRetry");
  const retryTerminal = body("timeoutRetryTerminal");
  const within = body("awaitWithinDeadline");
  const manifest = body("awaitManifestOperation");
  const issues: string[] = [];
  if (
    !bounded.includes("first.completedAtMs >= deadlineAtMs") ||
    !bounded.includes("settled.completedAtMs >= settlementDeadlineAtMs") ||
    !bounded.includes("new ConversationTimeoutError(stage, timeoutMs, first)") ||
    !bounded.includes("new ConversationTimeoutError(stage, timeoutMs, await terminal)")
  ) {
    issues.push(
      "bounded conversations must own late terminal and settlement equality",
    );
  }
  if (
    !retry.includes("const startedAtMs = now();") ||
    !retry.includes("const availableMs = deadlineMs - startedAtMs;") ||
    !retry.includes("reserveConversationTimeouts(\n      availableMs,") ||
    !retry.includes("terminal.completedAtMs >= attemptDeadlineMs") ||
    !retry.includes("terminal.completedAtMs >= deadlineMs") ||
    !retry.includes("deadlineMs - terminal.completedAtMs >= 2") ||
    !retry.includes(
      "const retainedTerminal = timeoutRetryTerminal(error.terminal);",
    ) ||
    !retry.includes("terminal: timeoutRetryTerminal(terminal)!") ||
    !retryTerminal.includes("reason: normalizeFailure(terminal.reason)")
  ) {
    issues.push(
      "timeout retry must bind one remainder and reject attempt or total expiry",
    );
  }
  if (
    !within.includes("first.completedAtMs >= deadlineAtMs") ||
    !within.includes("new Error(message, { cause: first.reason })")
  ) {
    issues.push(
      "shared deadline must reject late success and retain late rejection cause",
    );
  }
  if (
    !manifest.includes("first.completedAtMs >= deadlineAt") ||
    !manifest.includes("remainingMs() <= 0") ||
    !manifest.includes(
      'first.status === "rejected" ? first.reason : undefined',
    )
  ) {
    issues.push(
      "manifest operations must fail closed after late terminal settlement",
    );
  }
  return issues;
}

function terminalGatherEvidenceContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statusAfter = variableNamed(sourceFile, "statusAfter");
  const statusGuard: ts.IfStatement[] = [];
  const evidenceAssignments: ts.BinaryExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(sourceFile) ===
        "statusBefore.stdout !== statusAfter.stdout"
    ) {
      statusGuard.push(node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      [
        "report.scoutEvidence.paths",
        "report.scoutEvidence.sourceTestPairs",
        "report.scoutEvidence.charCount",
        "report.scoutEvidence.sha256",
        "report.scoutEvidence.latestCommit",
      ].includes(node.left.getText(sourceFile))
    ) {
      evidenceAssignments.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const statusCall =
    statusAfter?.initializer !== undefined &&
    ts.isAwaitExpression(statusAfter.initializer)
      ? statusAfter.initializer.expression
      : undefined;
  const guard = statusGuard[0];
  if (
    statusAfter === undefined ||
    !isCallAtPath(statusCall, ["gatherRequired"]) ||
    statusCall.arguments.map((argument) => argument.getText(sourceFile)).join("\n") !==
      ['"git"', '["status", "--porcelain=v1"]'].join("\n") ||
    statusGuard.length !== 1 ||
    guard === undefined ||
    evidenceAssignments.length < 5 ||
    evidenceAssignments.some(
      (assignment) => assignment.getStart(sourceFile) <= guard.getEnd(),
    )
  ) {
    return [
      "terminal gather status must settle and validate before evidence publication",
    ];
  }
  return [];
}

function autonomousStageContractIssues(source: string): string[] {
  const inspection = inspectAutonomousStages(source);
  const issues: string[] = [];
  if (inspection.callCount !== EXPECTED_AUTONOMOUS_STAGE_CALLS) {
    issues.push(
      `expected ${String(EXPECTED_AUTONOMOUS_STAGE_CALLS)} autonomous stage calls; received ${String(inspection.callCount)}`,
    );
  }
  inspection.firstArguments.forEach((argument, index) => {
    if (argument !== "selectedStageBackend") {
      issues.push(
        `autonomous stage ${String(index + 1)} backend must be selectedStageBackend; received ${argument}`,
      );
    }
  });
  for (const kind of inspection.aliasKinds) {
    issues.push(`autonomous alias shape forbidden: ${kind}`);
  }
  return issues;
}

function deliveryHeadContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  let validatedDeclarationCount = 0;
  let pushedDeclarationCount = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "validatedHeadSha"
    ) {
      validatedDeclarationCount += 1;
      const declarationList = node.parent;
      if (
        !ts.isVariableDeclarationList(declarationList) ||
        (declarationList.flags & ts.NodeFlags.Const) === 0 ||
        node.initializer?.getText(sourceFile) !== "validatedHead.stdout.trim()" ||
        ancestorMonitorStageLabel(node) !== "commit-push"
      ) {
        issues.push(
          "validatedHeadSha must be the immutable captured commit inside commit-push",
        );
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "pushedHeadSha"
    ) {
      pushedDeclarationCount += 1;
      const declarationList = node.parent;
      const initializer = node.initializer;
      const stageCall =
        initializer !== undefined && ts.isAwaitExpression(initializer)
          ? initializer.expression
          : undefined;
      if (
        !ts.isVariableDeclarationList(declarationList) ||
        (declarationList.flags & ts.NodeFlags.Const) === 0 ||
        !isCallAtPath(stageCall, ["monitor", "stage"]) ||
        stageCall.arguments[0]?.getText(sourceFile) !== '"commit-push"'
      ) {
        issues.push(
          "pushedHeadSha must be a const initialized from the commit-push stage result",
        );
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (isIdentifierNamed(node.left, "validatedHeadSha") ||
        isIdentifierNamed(node.left, "pushedHeadSha"))
    ) {
      issues.push("validatedHeadSha must not be reassigned after commit-push");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (validatedDeclarationCount !== 1) {
    issues.push(
      `expected one validatedHeadSha declaration; received ${String(validatedDeclarationCount)}`,
    );
  }
  if (pushedDeclarationCount !== 1) {
    issues.push(
      `expected one pushedHeadSha declaration; received ${String(pushedDeclarationCount)}`,
    );
  }
  return issues;
}

function deliveryIdentityAndDeadlineContractIssues(source: string): string[] {
  const issues: string[] = [];
  for (const name of [
    "ORCA_IMPROVEMENT_ORIGIN_FETCH_URL",
    "ORCA_IMPROVEMENT_ORIGIN_PUSH_URL",
    "ORCA_IMPROVEMENT_REPOSITORY",
  ]) {
    if (!source.includes(`process.env.${name}`)) {
      issues.push(`workflow must require launcher ${name}`);
    }
  }
  for (const label of ["initial", "post-agent", "pre-push", "post-push"]) {
    if (!source.includes(`          "${label}",`)) {
      issues.push(`workflow must verify ${label} Git identity`);
    }
  }
  const push = source.indexOf(
    "`${validatedHeadSha}:refs/heads/${report.branch}`",
  );
  const postPush = source.indexOf('"post-push"', push);
  if (push < 0 || postPush <= push) {
    issues.push("post-push Git identity must be verified after push");
  }
  const finalHead = source.lastIndexOf(
    "await assertPullRequestHead(prUrl, pullRequestIdentity);",
  );
  const mergeRemainder = source.indexOf(
    'const mergeRemainder = budget("delivery");',
    finalHead,
  );
  if (finalHead < 0 || mergeRemainder <= finalHead) {
    issues.push("merge timeout must use a fresh remainder after final head query");
  }
  for (const reserve of [
    "MERGE_CONFIRMATION_LIMIT_MS",
    "ISSUE_CLOSURE_RESERVE_MS",
    "RUNTIME_FINALIZATION_RESERVE_MS",
  ]) {
    if (!source.includes(reserve)) {
      issues.push(`delivery must reserve ${reserve}`);
    }
  }
  return issues;
}

function immutablePushContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issue =
    "delivery must push and prove the captured validated SHA on the explicit remote branch";
  const captures = variablesNamed(sourceFile, "capturedOriginPushUrl");
  const capture = captures[0];
  const stages = propertyCallsNamed(sourceFile, "stage").filter(
    (call) =>
      isCallAtPath(call, ["monitor", "stage"]) &&
      call.arguments[0] !== undefined &&
      ts.isStringLiteralLike(call.arguments[0]) &&
      call.arguments[0].text === "commit-push",
  );
  const callback = stages[0]?.arguments[1];
  const block =
    callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    ts.isBlock(callback.body)
      ? callback.body
      : undefined;
  if (
    captures.length !== 1 ||
    capture?.initializer?.getText(sourceFile) !== "report.originPushUrl" ||
    !ts.isVariableDeclarationList(capture.parent) ||
    (capture.parent.flags & ts.NodeFlags.Const) === 0 ||
    stages.length !== 1 ||
    block === undefined
  ) {
    return [issue];
  }
  const validated = variablesNamed(block, "validatedHeadSha");
  const validatedDeclaration = validated[0];
  const pushed = variablesNamed(sourceFile, "pushedHeadSha");
  const pushedStage =
    pushed[0]?.initializer !== undefined &&
    ts.isAwaitExpression(pushed[0].initializer)
      ? pushed[0].initializer.expression
      : undefined;
  const requiredCalls = callsNamed(block, "runRequired");
  const commandArgs = (call: ts.CallExpression): readonly string[] | undefined => {
    const args = call.arguments[1];
    return args !== undefined && ts.isArrayLiteralExpression(args)
      ? args.elements.map((element) => element.getText(sourceFile))
      : undefined;
  };
  const push = requiredCalls.find(
    (call) => commandArgs(call)?.[0] === '"push"',
  );
  const remoteDeclarations = variablesNamed(block, "remoteBranch");
  const remoteDeclaration = remoteDeclarations[0];
  const remoteCall =
    remoteDeclaration?.initializer !== undefined &&
    ts.isAwaitExpression(remoteDeclaration.initializer) &&
    isCallAtPath(remoteDeclaration.initializer.expression, ["runRequired"])
      ? remoteDeclaration.initializer.expression
      : undefined;
  const remoteGuard = block.statements.find(
    (statement): statement is ts.IfStatement =>
      ts.isIfStatement(statement) &&
      compactSource(statement.expression.getText(sourceFile)) ===
        compactSource(
          "remoteBranch.stdout.trim() !== `${validatedHeadSha}\\trefs/heads/${report.branch}`",
        ),
  );
  const statementIndex = (node: ts.Node | undefined): number =>
    node === undefined
      ? -1
      : block.statements.findIndex(
          (statement) =>
            statement.getStart(sourceFile) <= node.getStart(sourceFile) &&
            statement.getEnd() >= node.getEnd(),
        );
  const pushIndex = statementIndex(push);
  const remoteIndex = statementIndex(remoteDeclaration);
  const guardIndex = statementIndex(remoteGuard);
  const returnIndex = block.statements.findIndex(
    (statement) =>
      ts.isReturnStatement(statement) &&
      statement.expression?.getText(sourceFile) === "validatedHeadSha",
  );
  if (
    validated.length !== 1 ||
    validatedDeclaration?.initializer?.getText(sourceFile) !==
      "validatedHead.stdout.trim()" ||
    !ts.isVariableDeclarationList(validatedDeclaration.parent) ||
    (validatedDeclaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    pushed.length !== 1 ||
    !isCallAtPath(pushedStage, ["monitor", "stage"]) ||
    pushedStage !== stages[0] ||
    push?.arguments[0]?.getText(sourceFile) !== '"git"' ||
    commandArgs(push!).join("\n") !==
      [
        '"push"',
        "capturedOriginPushUrl",
        "`${validatedHeadSha}:refs/heads/${report.branch}`",
      ].join("\n") ||
    push?.arguments[2]?.getText(sourceFile) !== 'budget("delivery")' ||
    remoteDeclarations.length !== 1 ||
    remoteCall?.arguments[0]?.getText(sourceFile) !== '"git"' ||
    commandArgs(remoteCall!).join("\n") !==
      [
        '"ls-remote"',
        '"--refs"',
        "capturedOriginPushUrl",
        "`refs/heads/${report.branch}`",
      ].join("\n") ||
    remoteCall?.arguments[2]?.getText(sourceFile) !== 'budget("delivery")' ||
    remoteGuard === undefined ||
    directThrowStatement(remoteGuard.thenStatement) === undefined ||
    pushIndex < 0 ||
    remoteIndex <= pushIndex ||
    guardIndex <= remoteIndex ||
    returnIndex <= guardIndex ||
    !compactSource(source).includes("headSha: pushedHeadSha,")
  ) {
    return [issue];
  }
  return [];
}

function workDeadlineContractIssues(source: string): string[] {
  const compact = compactSource(source);
  const issue =
    "active work must stop at the reserved cutoff while finalization retains the full deadline";
  const readyProof = compact.indexOf(
    "await assertPullRequestHead(prUrl, pullRequestIdentity);",
  );
  const record = compact.indexOf("deliveryRecord = DeliveryRecordSchema.parse(");
  const activeStop = compact.indexOf('report.stopReason = "active-ready";');
  if (
    !compact.includes(
      "const runtimeDeadlineMs = (): number => workerDeadlineAtMs - startedAtMs;",
    ) ||
    !compact.includes(
      "const workDeadlineMs = (): number => runtimeDeadlineMs() - RUNTIME_FINALIZATION_RESERVE_MS;",
    ) ||
    !compact.includes(
      "stageBudgetMs( startedAtMs, workDeadlineMs(), Date.now(), workDeadlineMs(), )",
    ) ||
    !compact.includes("Date.now() >= startedAtMs + workDeadlineMs()") ||
    !compact.includes(
      "remainingMs: () => stageBudgetMs( startedAtMs, runtimeDeadlineMs(), Date.now(), runtimeDeadlineMs(), ),",
    ) ||
    !compact.includes(
      "report.elapsedMs <= runtimeDeadlineMs()",
    ) ||
    readyProof < 0 ||
    record <= readyProof ||
    activeStop <= record ||
    compact.includes('monitor.stage("remote-checks"') ||
    compact.includes('monitor.stage("merge"')
  ) {
    return [issue];
  }
  return [];
}

function effectiveTimingContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const beginBudget = variableNamed(sourceFile, "beginBudget");
  const begin = beginBudget?.initializer;
  const beginCall =
    begin !== undefined && ts.isArrowFunction(begin) ? begin.body : undefined;
  if (
    !isCallAtPath(beginCall as ts.Expression | undefined, [
      "activeStageBudgets",
      "activate",
    ]) ||
    beginCall.arguments[0]?.getText(sourceFile) !== "name" ||
    beginCall.arguments[1]?.getText(sourceFile) !== "Date.now()"
  ) {
    issues.push("beginBudget must activate exactly one active-time budget");
  }

  const implementBudgetCalls = callsNamed(sourceFile, "beginBudget").filter(
    (call) => call.arguments[0]?.getText(sourceFile) === '"implement"',
  );
  const implementBudgetCall = implementBudgetCalls[0];
  const implementBudgetStatement = implementBudgetCall?.parent;
  const implementBlock = implementBudgetStatement?.parent;
  const implementStatementIndex =
    implementBudgetStatement !== undefined && ts.isBlock(implementBlock)
      ? implementBlock.statements.indexOf(
          implementBudgetStatement as ts.Statement,
        )
      : -1;
  const enterImplement =
    implementStatementIndex > 0 && ts.isBlock(implementBlock)
      ? implementBlock.statements[implementStatementIndex - 1]
      : undefined;
  const monitorImplement =
    implementStatementIndex >= 0 && ts.isBlock(implementBlock)
      ? implementBlock.statements[implementStatementIndex + 1]
      : undefined;
  const enterExpression =
    enterImplement !== undefined && ts.isExpressionStatement(enterImplement)
      ? enterImplement.expression
      : undefined;
  const monitorExpression =
    monitorImplement !== undefined && ts.isExpressionStatement(monitorImplement)
      ? monitorImplement.expression
      : undefined;
  const monitorCall =
    monitorExpression !== undefined && ts.isAwaitExpression(monitorExpression)
      ? monitorExpression.expression
      : undefined;
  if (
    implementBudgetCalls.length !== 1 ||
    implementBudgetStatement === undefined ||
    !ts.isExpressionStatement(implementBudgetStatement) ||
    implementBudgetStatement.expression !== implementBudgetCall ||
    !ts.isBlock(implementBlock) ||
    !isCallAtPath(enterExpression, ["enter"]) ||
    enterExpression.arguments[0]?.getText(sourceFile) !== '"implement"' ||
    !isCallAtPath(monitorCall, ["monitor", "stage"]) ||
    monitorCall.arguments[0]?.getText(sourceFile) !== '"implement"'
  ) {
    issues.push(
      "implement budget must be a direct call between enter and monitor stage",
    );
  }

  const budgetDeclaration = variableNamed(sourceFile, "budget");
  const budgetInitializer = budgetDeclaration?.initializer;
  if (
    budgetInitializer === undefined ||
    !ts.isArrowFunction(budgetInitializer) ||
    !ts.isBlock(budgetInitializer.body) ||
    budgetInitializer.body.statements.length !== 2
  ) {
    issues.push("budget must directly combine active and global remainders");
  } else {
    const returnStatement = budgetInitializer.body.statements[1];
    const expression = ts.isReturnStatement(returnStatement)
      ? returnStatement.expression
      : undefined;
    if (
      !isCallAtPath(expression, ["Math", "min"]) ||
      expression.arguments.length !== 2 ||
      !isCallAtPath(expression.arguments[0], [
        "activeStageBudgets",
        "remaining",
      ]) ||
      expression.arguments[0].arguments
        .map((argument) => argument.getText(sourceFile))
        .join("\n") !== ["name", "stageLimit(name)", "now"].join("\n") ||
      !isCallAtPath(expression.arguments[1], ["workRemaining"]) ||
      expression.arguments[1].arguments.length !== 0
    ) {
      issues.push("budget must directly combine active and global remainders");
    }
  }

  const targeted = source.slice(
    source.indexOf('enter("targeted-repair")'),
    source.indexOf("const reviewConfig =", source.indexOf('enter("targeted-repair")')),
  );
  if (
    targeted.indexOf('beginBudget("repairs")') < 0 ||
    targeted.indexOf('beginBudget("repairs")') >
      targeted.indexOf('monitor.stage("targeted-repair"')
  ) {
    issues.push("targeted repair must activate the repairs budget");
  }
  const reviewRepair = source.slice(
    source.indexOf('monitor.stage("review-repair"'),
    source.indexOf('enter("verify")'),
  );
  const repairsResume = reviewRepair.indexOf('beginBudget("repairs")');
  const repairTurn = reviewRepair.indexOf("const repairConversation");
  const reviewResume = reviewRepair.indexOf('beginBudget("review")');
  const repeatedReview = reviewRepair.indexOf(
    'performReview("repeated review")',
  );
  if (
    repairsResume < 0 ||
    repairTurn <= repairsResume ||
    reviewResume <= repairTurn ||
    repeatedReview <= reviewResume
  ) {
    issues.push("review repair must switch active repair and review budgets");
  }

  const compact = compactSource(source);
  const finalizer = compact.indexOf(
    "const finalizerErrors = await finalizeWorkflowEvidence({",
  );
  const reportArtifact = compact.indexOf('label: "report"', finalizer);
  const finished = compact.indexOf(
    "const finishedAtMs = Date.now();",
    reportArtifact,
  );
  const remainingAtReport = compact.indexOf(
    "const remainingAtReport = context.remainingMs();",
    finished,
  );
  const finishedAssignment = compact.indexOf(
    "report.finishedAtMs = finishedAtMs;",
    remainingAtReport,
  );
  const elapsed = compact.indexOf(
    "report.elapsedMs = finishedAtMs - startedAtMs;",
    finishedAssignment,
  );
  const sla = compact.indexOf("report.sla =", elapsed);
  const write = compact.indexOf(
    "await publishFinalizationText(",
    sla,
  );
  const reportEnd = compact.indexOf("enterFailureState:", write);
  const slaText = compact.slice(sla, write);
  if (
    finalizer < 0 ||
    reportArtifact <= finalizer ||
    finished <= reportArtifact ||
    remainingAtReport <= finished ||
    finishedAssignment <= remainingAtReport ||
    elapsed <= finishedAssignment ||
    sla <= elapsed ||
    write <= sla ||
    reportEnd <= write ||
    !slaText.includes("report.elapsedMs <= runtimeDeadlineMs()") ||
    !slaText.includes("remainingAtReport > 0") ||
    compact.slice(write, reportEnd).includes("report.sla =") ||
    compact.includes('report.sla = "passed";')
  ) {
    issues.push(
      "final SLA must be assigned during bounded finalization and reject deadline overrun",
    );
  }
  return issues;
}

function stageRemainderContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const changed = functionDeclarationsNamed(sourceFile, "changedPaths");
  const diff = functionDeclarationsNamed(sourceFile, "pathDiff");
  if (
    changed.length !== 1 ||
    changed[0]?.parameters.length !== 1 ||
    changed[0]?.parameters[0]?.initializer !== undefined
  ) {
    issues.push("changedPaths must require one explicit remainder callback");
  }
  if (
    diff.length !== 1 ||
    diff[0]?.parameters.length !== 2 ||
    diff[0]?.parameters[1]?.initializer !== undefined
  ) {
    issues.push("pathDiff must require one explicit remainder callback");
  }
  const changedTimeouts =
    changed[0] === undefined ? [] : callsNamed(changed[0], "remainingTimeout");
  if (
    changedTimeouts.length !== 2 ||
    changedTimeouts.some(
      (call) =>
        call.arguments[0]?.getText(sourceFile) !== "30_000" ||
        call.arguments[1]?.getText(sourceFile) !== "remaining()",
    )
  ) {
    issues.push("changedPaths must clamp both Git probes to its remainder");
  }
  const diffTimeouts =
    diff[0] === undefined ? [] : callsNamed(diff[0], "remainingTimeout");
  if (
    diffTimeouts.length !== 1 ||
    diffTimeouts[0]?.arguments[0]?.getText(sourceFile) !== "30_000" ||
    diffTimeouts[0]?.arguments[1]?.getText(sourceFile) !== "remaining()"
  ) {
    issues.push("pathDiff must clamp its Git probe to its remainder");
  }
  const calls = [
    ...callsNamed(sourceFile, "pathDiff"),
    ...callsNamed(sourceFile, "changedPaths"),
  ].sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile));
  const expected = [
    ["changedPaths", "reproduce"],
    ["pathDiff", "reproduce"],
    ["pathDiff", "implement"],
    ["changedPaths", "implement"],
    ["pathDiff", "repairs"],
    ["changedPaths", "repairs"],
    ["pathDiff", "repairs"],
    ["changedPaths", "repairs"],
    ["pathDiff", "verify"],
    ["changedPaths", "verify"],
    ["pathDiff", "delivery"],
    ["changedPaths", "delivery"],
  ] as const;
  if (calls.length !== expected.length) {
    issues.push(
      `stage remainder call count must be ${String(expected.length)}; received ${String(calls.length)}`,
    );
  }
  for (const [index, [name, stage]] of expected.entries()) {
    const call = calls[index];
    const remainder = name === "pathDiff" ? call?.arguments[1] : call?.arguments[0];
    if (
      call?.expression.getText(sourceFile) !== name ||
      remainder?.getText(sourceFile) !== `() => budget("${stage}")`
    ) {
      issues.push(
        `${name} call ${String(index + 1)} must use ${stage} remainder`,
      );
    }
  }
  return issues;
}

function directiveWiringContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const selectedStageConfig = variableNamed(sourceFile, "selectedStageConfig");
  const selectedInitializer = selectedStageConfig?.initializer;
  const selectedBody =
    selectedInitializer !== undefined && ts.isArrowFunction(selectedInitializer)
      ? selectedInitializer.body
      : undefined;
  const selectedCall =
    selectedBody !== undefined &&
    !ts.isBlock(selectedBody) &&
    isCallAtPath(selectedBody, ["withSelectedModel"])
      ? selectedBody
      : undefined;
  if (
    selectedInitializer === undefined ||
    !ts.isArrowFunction(selectedInitializer) ||
    selectedInitializer.parameters.length !== 1 ||
    selectedInitializer.parameters[0]?.name.getText(sourceFile) !== "config" ||
    selectedCall === undefined ||
    selectedCall.arguments
      .map((argument) => argument.getText(sourceFile))
      .join("\n") !== ["config", "activeSelected.model"].join("\n")
  ) {
    issues.push("selected stage config must preserve directives through model overlay");
  }
  const declarations = [
    ["scoutConfig", "scout", "true"],
    ["reproduceConfig", "reproduce", "false"],
    ["implementConfig", "implement", "false"],
    ["repairConfig", "repair", "false"],
    ["reviewConfig", "review", "true"],
  ] as const;
  for (const [name, stage, readOnly] of declarations) {
    const variables = variablesNamed(sourceFile, name);
    const call =
      variables[0]?.initializer === undefined
        ? undefined
        : callsNamed(variables[0].initializer, "stageConfig")[0];
    if (
      variables.length !== 1 ||
      call === undefined ||
      call.arguments.map((argument) => argument.getText(sourceFile)).join("\n") !==
        [`"${stage}"`, `config.stages.${stage}`, readOnly].join("\n")
    ) {
      issues.push(`${name} must bind its exact stage directive and access mode`);
    }
  }
  const expectedConfigs = [
    "repairConfig",
    "scoutConfig",
    "scoutConfig",
    "reproduceConfig",
    "implementConfig",
    "repairConfig",
    "reviewConfig",
    "repairConfig",
  ];
  const calls = propertyCallsNamed(sourceFile, "autonomous");
  if (calls.length !== expectedConfigs.length) {
    issues.push(
      `directive-wired autonomous call count must be ${String(expectedConfigs.length)}`,
    );
  }
  for (const [index, expected] of expectedConfigs.entries()) {
    const request = calls[index]?.arguments[1];
    const config =
      request !== undefined && ts.isObjectLiteralExpression(request)
        ? propertyAssignmentNamed(request, "config")?.initializer
        : undefined;
    if (
      config?.getText(sourceFile) !== `selectedStageConfig(${expected})`
    ) {
      issues.push(
        `autonomous stage ${String(index + 1)} must use ${expected}`,
      );
    }
  }
  const reproducePromptAssignments: ts.BinaryExpression[] = [];
  const visitReproducePromptEvidence = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      hasExpressionPath(node.left, [
        "report",
        "appliedSystemPrompts",
        "reproduce",
      ])
    ) {
      reproducePromptAssignments.push(node);
    }
    ts.forEachChild(node, visitReproducePromptEvidence);
  };
  visitReproducePromptEvidence(sourceFile);
  const reproducePromptAssignment = reproducePromptAssignments[0];
  if (
    reproducePromptAssignments.length !== 1 ||
    reproducePromptAssignment?.right.getText(sourceFile) !==
      'reproduceConfig.systemPrompt ?? ""' ||
    reproducePromptAssignment.parent === undefined ||
    !ts.isExpressionStatement(reproducePromptAssignment.parent) ||
    reproducePromptAssignment.parent.expression !== reproducePromptAssignment ||
    !ts.isBlock(reproducePromptAssignment.parent.parent)
  ) {
    issues.push(
      "reproduce prompt evidence must directly retain the exact applied directive",
    );
  }
  return issues;
}

function verificationGateContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const required = functionDeclarationsNamed(sourceFile, "runRequired");
  const requiredStatement = required[0]?.body?.statements[0];
  const requiredReturn =
    requiredStatement !== undefined && ts.isReturnStatement(requiredStatement)
      ? requiredStatement.expression
      : undefined;
  const requiredCall =
    requiredReturn !== undefined && ts.isAwaitExpression(requiredReturn)
      ? requiredReturn.expression
      : undefined;
  if (
    required.length !== 1 ||
    required[0]?.body?.statements.length !== 1 ||
    !isCallAtPath(requiredCall, ["runRequiredCommand"]) ||
    requiredCall.arguments
      .map((argument) => argument.getText(sourceFile))
      .join("\n") !==
      ["command()", "commandName", "args", "timeoutMs"].join("\n")
  ) {
    issues.push("required commands must delegate to the tested failure guard");
  }
  const targeted = functionDeclarationsNamed(sourceFile, "runTargetedGate");
  const calls = targeted[0] === undefined
    ? []
    : callsNamed(targeted[0], "runLogged");
  if (
    targeted.length !== 1 ||
    targeted[0]?.body?.statements.length !== 1 ||
    calls.length !== 2
  ) {
    issues.push("targeted gate must directly run exactly test and lint");
  }
  const testCall = calls[0];
  const testArgs = testCall?.arguments[1];
  if (
    testCall?.arguments.length !== 3 ||
    testCall.arguments[0]?.getText(sourceFile) !== '"bun"' ||
    !isCallAtPath(testArgs, ["matcherProofArgs"]) ||
    testArgs.arguments.length !== 2 ||
    testArgs.arguments[0]?.getText(sourceFile) !== "candidate.targetedTestArgs" ||
    !isIdentifierNamed(testArgs.arguments[1], "MATCHER_PROOF_PRELOAD_PATH") ||
    testCall.arguments[2]?.getText(sourceFile) !== "timeoutMs"
  ) {
    issues.push("targeted gate command 1 is not exact");
  }
  const lintCall = calls[1];
  if (
    lintCall?.arguments.map((argument) => argument.getText(sourceFile)).join("\n") !==
    ['"bun"', '["run", "lint"]', "timeoutMs"].join("\n")
  ) {
    issues.push("targeted gate command 2 is not exact");
  }
  const gateIssues = callsNamed(sourceFile, "gateIssuesFromLogs");
  if (
    gateIssues.length !== 1 ||
    gateIssues[0]?.arguments[0]?.getText(sourceFile) !== "logs" ||
    !source.includes("return ok(gateIssuesFromLogs(logs));")
  ) {
    issues.push("targeted repair must expose every failed test and lint log");
  }
  const fullGate = variableNamed(sourceFile, "FULL_GATE")?.initializer;
  const fullGateObject = fullGate !== undefined && ts.isAsExpression(fullGate)
    ? fullGate.expression
    : fullGate;
  if (
    fullGateObject === undefined ||
    !ts.isObjectLiteralExpression(fullGateObject) ||
    propertyAssignmentNamed(fullGateObject, "command")?.initializer.getText(sourceFile) !== '"bun"' ||
    propertyAssignmentNamed(fullGateObject, "args")?.initializer.getText(sourceFile) !== '["run", "verify"]'
  ) {
    issues.push("full gate must be exactly bun run verify");
  }
  const fullCalls = callsNamed(sourceFile, "runRequired").filter(
    (call) => call.arguments[0]?.getText(sourceFile) === "FULL_GATE.command",
  );
  const fullCall = fullCalls[0];
  const fullDeclarations = variablesNamed(sourceFile, "full");
  const fullDeclaration = fullDeclarations[0];
  const fullInitializer = fullDeclaration?.initializer;
  const fullStatement = fullDeclaration?.parent.parent;
  const fullBlock = fullStatement?.parent;
  const fullStatementIndex =
    fullStatement !== undefined && ts.isBlock(fullBlock)
      ? fullBlock.statements.indexOf(fullStatement as ts.Statement)
      : -1;
  const fullEvidenceStatement =
    fullStatementIndex >= 0 && ts.isBlock(fullBlock)
      ? fullBlock.statements[fullStatementIndex + 1]
      : undefined;
  const verifyStart = source.indexOf('await monitor.stage("verify"');
  const verifyEnd = source.indexOf('enter("commit-push")', verifyStart);
  if (
    fullCalls.length !== 1 ||
    fullCall?.arguments[1]?.getText(sourceFile) !== "FULL_GATE.args" ||
    !fullCall.arguments[2]?.getText(sourceFile).includes('budget("verify")') ||
    fullCall.getStart(sourceFile) <= verifyStart ||
    fullCall.getEnd() >= verifyEnd
  ) {
    issues.push("full gate must run exactly once inside bounded verify stage");
  }
  if (
    fullDeclarations.length !== 1 ||
    fullCall === undefined ||
    fullInitializer === undefined ||
    !ts.isAwaitExpression(fullInitializer) ||
    fullInitializer.expression !== fullCall ||
    fullStatement === undefined ||
    !ts.isVariableStatement(fullStatement) ||
    !ts.isBlock(fullBlock) ||
    fullEvidenceStatement?.getText(sourceFile) !==
      "report.validation.push(full);"
  ) {
    issues.push(
      "full gate must be directly awaited and immediately persisted before push",
    );
  }
  return issues;
}

function branchContextContractIssues(source: string): string[] {
  const issues: string[] = [];
  const initializer = source.slice(
    source.indexOf("const report: RunReport = {"),
    source.indexOf("\n  };", source.indexOf("const report: RunReport = {")),
  );
  if (
    !initializer.includes(
      'branch: process.env.ORCA_IMPROVEMENT_BRANCH?.trim() ?? ""',
    )
  ) {
    issues.push("report must capture launcher branch before risky work");
  }
  const runId = source.indexOf(
    'runId = requiredEnvironment("ORCA_IMPROVEMENT_RUN_ID")',
  );
  const branch = source.indexOf(
    "const launcherIdentity = requireLauncherDeliveryIdentity(runId, {",
    runId,
  );
  const backend = source.indexOf("const activeSelected = selectBackend");
  const config = source.indexOf(
    'const config = await awaitWithinDeadline(\n      "workflow config read"',
    runId,
  );
  if (
    backend < 0 ||
    backend >= runId ||
    runId < 0 ||
    branch <= runId ||
    branch >= config
  ) {
    issues.push(
      "backend must validate before launcher work and launcher branch before config work",
    );
  }
  if (
    !source.includes("assertCurrentBranch(branch.stdout, expectedBranch);") ||
    !source.includes('          "initial",') ||
    source.includes("report.branch = branch.stdout.trim();")
  ) {
    issues.push(
      "git branch proof and command evidence must match the launcher-bound branch",
    );
  }
  return issues;
}

function earlyBackendGuardContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const requested = variableNamed(sourceFile, "requestedBackend");
  const selected = variableNamed(sourceFile, "activeSelected");
  const startedAt = variablesNamed(sourceFile, "startedAtMs").find(
    (declaration) =>
      declaration.initializer?.getText(sourceFile) ===
      'parseStartedAt(\n    requiredEnvironment("ORCA_IMPROVEMENT_STARTED_AT_MS"),\n  )',
  );
  const monitor = variableNamed(sourceFile, "monitor");
  const firstFilesystem = callsNamed(sourceFile, "fs")[0];
  const guards: ts.IfStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) guards.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const requestedGuard = guards.find(
    (guard) =>
      guard.expression.getText(sourceFile) === 'requestedBackend !== "codex"',
  );
  const selectedGuard = guards.find(
    (guard) =>
      guard.expression.getText(sourceFile) === 'activeSelected.tag !== "codex"',
  );
  const selectCalls = callsNamed(sourceFile, "selectBackend");
  const issues: string[] = [];
  if (
    requested?.initializer?.getText(sourceFile) !==
      'process.env.ORCA_BACKEND?.trim() || "codex"' ||
    requestedGuard === undefined ||
    !requestedGuard.thenStatement
      .getText(sourceFile)
      .includes("proving workflow requires codex backend")
  ) {
    issues.push("raw backend request must reject non-Codex before selection");
  }
  if (
    selected?.initializer?.getText(sourceFile) !==
      'selectBackend({ default: "codex" })' ||
    selectCalls.length !== 1 ||
    selectedGuard === undefined ||
    !selectedGuard.thenStatement
      .getText(sourceFile)
      .includes("proving workflow requires codex backend")
  ) {
    issues.push("selected backend tag must reject non-Codex exactly once");
  }
  if (
    requested === undefined ||
    requestedGuard === undefined ||
    selected === undefined ||
    selectedGuard === undefined ||
    startedAt === undefined ||
    monitor === undefined ||
    firstFilesystem === undefined ||
    !(
      requested.getStart(sourceFile) < requestedGuard.getStart(sourceFile) &&
      requestedGuard.getEnd() < selected.getStart(sourceFile) &&
      selected.getEnd() < selectedGuard.getStart(sourceFile) &&
      selectedGuard.getEnd() < startedAt.getStart(sourceFile) &&
      startedAt.getEnd() < monitor.getStart(sourceFile) &&
      selectedGuard.getEnd() < firstFilesystem.getStart(sourceFile)
    )
  ) {
    issues.push(
      "backend guards must precede clocks, monitor construction, filesystem access, and repository work",
    );
  }
  return issues;
}

function remoteCheckEvidenceContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const reportType = source.slice(
    source.indexOf("interface RunReport {"),
    source.indexOf("\n}", source.indexOf("interface RunReport {")),
  );
  if (!reportType.includes("remoteChecks?: PassedRemoteChecksEvidence<CommandLog>;")) {
    issues.push(
      "RunReport missing remote-check evidence field: PassedRemoteChecksEvidence<CommandLog>",
    );
  }
  const declarations = variablesNamed(sourceFile, "passedRemoteChecks");
  const declaration = declarations[0];
  const initializer = declaration?.initializer;
  const stageCall =
    initializer !== undefined &&
    ts.isAwaitExpression(initializer) &&
    isCallAtPath(initializer.expression, ["monitor", "stage"])
      ? initializer.expression
      : undefined;
  const callback = stageCall?.arguments[1];
  const callbackBlock =
    callback !== undefined && ts.isArrowFunction(callback) && ts.isBlock(callback.body)
      ? callback.body
      : undefined;
  const remoteReads =
    callbackBlock === undefined ? [] : callsNamed(callbackBlock, "readRemoteChecks");
  const remoteReadTimeout = remoteReads[0]?.arguments[1];
  if (
    declarations.length !== 1 ||
    stageCall?.arguments[0]?.getText(sourceFile) !== '"remote-checks"' ||
    callback === undefined ||
    !ts.isArrowFunction(callback) ||
    callback.type?.getText(sourceFile) !==
      "Promise<PassedRemoteChecksEvidence<CommandLog>>" ||
    callbackBlock === undefined
  ) {
    issues.push("remote-check stage must return typed passed evidence");
  }
  if (
    remoteReads.length !== 1 ||
    remoteReads[0]?.arguments[0]?.getText(sourceFile) !== "prUrl" ||
    !isCallAtPath(remoteReadTimeout, ["remainingTimeout"]) ||
    remoteReadTimeout.arguments
      .map((argument) => argument.getText(sourceFile))
      .join("\n") !==
      [
        "CI_POLL_INTERVAL_MS",
        "ciPollRemaining()",
        "`CI / Verify on ${prUrl}`",
      ].join("\n")
  ) {
    issues.push("remote check polling must preserve terminal reserves");
  }
  const passedBranches: ts.IfStatement[] = [];
  const breaks: ts.BreakStatement[] = [];
  const visitPassedBranch = (node: ts.Node): void => {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(sourceFile) === 'state === "passed"'
    ) {
      passedBranches.push(node);
    }
    if (ts.isBreakStatement(node)) breaks.push(node);
    ts.forEachChild(node, visitPassedBranch);
  };
  if (callbackBlock !== undefined) visitPassedBranch(callbackBlock);
  const passedBranch = passedBranches[0];
  const passedBlock =
    passedBranch !== undefined && ts.isBlock(passedBranch.thenStatement)
      ? passedBranch.thenStatement
      : undefined;
  const evidenceDeclarations =
    passedBlock?.statements.flatMap((statement) => {
      if (!ts.isVariableStatement(statement)) return [];
      return statement.declarationList.declarations.filter(
        (item) => item.name.getText(sourceFile) === "evidence",
      );
    }) ?? [];
  const evidenceCall = evidenceDeclarations[0]?.initializer;
  const headIndex =
    passedBlock?.statements.findIndex((statement) =>
      callsNamed(statement, "assertPullRequestHead").some(
        (call) =>
          call.arguments.map((argument) => argument.getText(sourceFile)).join("\n") ===
          ["prUrl", "pullRequestIdentity"].join("\n"),
      ),
    ) ?? -1;
  const evidenceStatement = evidenceDeclarations[0]?.parent.parent;
  const evidenceIndex =
    evidenceStatement !== undefined &&
    ts.isVariableStatement(evidenceStatement) &&
    passedBlock !== undefined
      ? passedBlock.statements.indexOf(evidenceStatement)
      : -1;
  const logIndex =
    passedBlock?.statements.findIndex(
      (statement) =>
        ts.isExpressionStatement(statement) &&
        isCallAtPath(statement.expression, ["report", "validation", "push"]) &&
        statement.expression.arguments[0]?.getText(sourceFile) === "remote.log",
    ) ?? -1;
  const returnIndex =
    passedBlock?.statements.findIndex(
      (statement) =>
        ts.isReturnStatement(statement) &&
        statement.expression?.getText(sourceFile) === "evidence",
    ) ?? -1;
  if (
    passedBranches.length !== 1 ||
    passedBlock === undefined ||
    evidenceDeclarations.length !== 1 ||
    !isCallAtPath(evidenceCall, ["buildPassedRemoteChecksEvidence"]) ||
    evidenceCall.arguments
      .map((argument) => argument.getText(sourceFile))
      .join("\n") !==
      [
        "remote.checks",
        "remote.log",
        "pullRequestIdentity.headSha",
        "new Date().toISOString()",
      ].join("\n") ||
    headIndex < 0 ||
    evidenceIndex !== headIndex + 1 ||
    logIndex !== evidenceIndex + 1 ||
    returnIndex !== logIndex + 1
  ) {
    issues.push(
      "passed CI evidence must follow fixed-head proof and return with its command log",
    );
  }

  const reportAssignments: ts.BinaryExpression[] = [];
  const visitAssignments = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      hasExpressionPath(node.left, ["report", "remoteChecks"])
    ) {
      reportAssignments.push(node);
    }
    ts.forEachChild(node, visitAssignments);
  };
  visitAssignments(sourceFile);
  const assignment = reportAssignments[0];
  const freshAssignment = reportAssignments[1];
  const declarationStatement = declaration?.parent.parent;
  const declarationBlock = declarationStatement?.parent;
  const assignmentStatement = assignment?.parent;
  const assignmentBlock = assignmentStatement?.parent;
  const declarationIndex =
    declarationBlock !== undefined &&
    ts.isBlock(declarationBlock) &&
    declarationStatement !== undefined &&
    ts.isVariableStatement(declarationStatement)
      ? declarationBlock.statements.indexOf(declarationStatement)
      : -1;
  const assignmentIndex =
    assignmentBlock !== undefined &&
    ts.isBlock(assignmentBlock) &&
    assignmentStatement !== undefined &&
    ts.isExpressionStatement(assignmentStatement)
      ? assignmentBlock.statements.indexOf(assignmentStatement)
      : -1;
  if (
    breaks.length !== 0 ||
    reportAssignments.length !== 2 ||
    assignment?.right.getText(sourceFile) !== "passedRemoteChecks" ||
    assignmentStatement === undefined ||
    !ts.isExpressionStatement(assignmentStatement) ||
    declaration === undefined ||
    declarationBlock !== assignmentBlock ||
    declarationIndex < 0 ||
    assignmentIndex !== declarationIndex + 1 ||
    assignment.getStart(sourceFile) <= declaration.getEnd() ||
    assignment.getEnd() >= source.indexOf('enter("merge")')
  ) {
    issues.push(
      "passed CI evidence must be returned from polling and assigned once after the stage",
    );
  }
  if (
    freshAssignment?.right.getText(sourceFile) !== "freshRemoteChecks" ||
    freshAssignment.getStart(sourceFile) <= source.indexOf('enter("merge")')
  ) {
    issues.push("merge must persist freshly repolled CI evidence");
  }
  const remoteCheckReaders = functionDeclarationsNamed(
    sourceFile,
    "readRemoteChecks",
  );
  const remoteCheckReader = remoteCheckReaders[0];
  if (
    remoteCheckReaders.length !== 1 ||
    remoteCheckReader?.parameters
      .map((parameter) => parameter.getText(sourceFile))
      .join("\n") !== ["prUrl: string", "timeoutMs: number"].join("\n") ||
    remoteCheckReader.type?.getText(sourceFile) !==
      "Promise<{ readonly checks: RemoteCheck[]; readonly log: CommandLog }>" ||
    !source.includes("return { checks: parseRemoteChecksCommandResult(result, rendered), log };")
  ) {
    issues.push("remote check polling must retain its command log");
  }
  return issues;
}

function baselineUsageContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const start = source.indexOf("const baselineResult = await runBaselineGate({");
  const end = source.indexOf(
    "const readiness = BACKEND_READINESS[selected.tag]",
    start,
  );
  const block = source.slice(start, end);
  const callbackCount = block.split("recordUsage(outcome.result.usage);").length - 1;
  const issues: string[] = [];
  const recordUsage = variableNamed(sourceFile, "recordUsage")?.initializer;
  if (
    recordUsage === undefined ||
    !ts.isArrowFunction(recordUsage) ||
    !ts.isBlock(recordUsage.body) ||
    recordUsage.body.statements
      .map((statement) => statement.getText(sourceFile))
      .join("\n") !==
      [
        "const merged = mergeUsage(report.usage, usage);",
        "if (merged !== undefined) report.usage = merged;",
      ].join("\n")
  ) {
    issues.push("usage aggregator must persist every reported backend usage");
  }
  const usageCalls = callsNamed(sourceFile, "recordUsage");
  const outcomeUsageCalls = usageCalls.filter(
    (call) => call.arguments[0]?.getText(sourceFile) === "outcome.result.usage",
  );
  const scopedTerminalUsageCalls = usageCalls.filter(
    (call) =>
      call.arguments[0]?.getText(sourceFile) ===
      "scopedUsage.get(record.scopeIndex)",
  );
  const timeoutUsageCalls = usageCalls.filter(
    (call) => call.arguments[0]?.getText(sourceFile) === "attempt.terminal.usage",
  );
  const conversationWrapper = functionDeclarationsNamed(
    sourceFile,
    "awaitConversationWithinBudget",
  )[0];
  const conversationTimeoutUsageCalls =
    conversationWrapper === undefined
      ? []
      : callsNamed(conversationWrapper, "recordUsage");
  if (
    outcomeUsageCalls.length !== 7 ||
    outcomeUsageCalls.some(
      (call) =>
        call.arguments.length !== 1 ||
        !ts.isExpressionStatement(call.parent) ||
        call.parent.expression !== call ||
        !ts.isBlock(call.parent.parent),
    )
  ) {
    issues.push(
      "all non-scout backend turn sites must unconditionally record their usage",
    );
  }
  const timeoutCall = timeoutUsageCalls[0];
  const timeoutGuard =
    timeoutCall === undefined || !ts.isBlock(timeoutCall.parent.parent)
      ? undefined
      : timeoutCall.parent.parent.parent;
  if (
    usageCalls.length !== 10 ||
    scopedTerminalUsageCalls.length !== 1 ||
    timeoutUsageCalls.length !== 1 ||
    conversationTimeoutUsageCalls.length !== 1 ||
    timeoutCall === undefined ||
    !ts.isExpressionStatement(timeoutCall.parent) ||
    timeoutCall.parent.expression !== timeoutCall ||
    timeoutGuard === undefined ||
    !ts.isIfStatement(timeoutGuard) ||
    timeoutGuard.expression.getText(sourceFile) !==
      'attempt.timedOut && attempt.terminal?.status === "fulfilled"'
  ) {
    issues.push(
      "timed-out scout attempts must retain terminal usage exactly once",
    );
  }
  if (scopedTerminalUsageCalls.length !== 1) {
    issues.push("scout finalization must record pair-ordered terminal usage once");
  }
  if (callbackCount !== 1) {
    issues.push("baseline repair must record each backend outcome exactly once");
  }
  if (block.includes("recordUsage(baselineResult.usage);")) {
    issues.push("baseline aggregate usage must not be recorded twice");
  }
  return issues;
}

function persistenceHelperContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const writeJson = functionDeclarationsNamed(sourceFile, "writeJson")[0];
  if (
    writeJson?.body?.statements.length !== 1 ||
    writeJson.body.statements[0]?.getText(sourceFile) !==
      "await writeText(path, `${JSON.stringify(value, null, 2)}\\n`);"
  ) {
    issues.push("writeJson must unconditionally persist its payload");
  }
  const appendIssue = functionDeclarationsNamed(sourceFile, "appendIssue")[0];
  const finalStatement = appendIssue?.body?.statements.at(-1);
  const publishCalls =
    appendIssue === undefined
      ? []
      : callsNamed(appendIssue, "publishFinalizationText");
  if (
    publishCalls.length !== 1 ||
    finalStatement === undefined ||
    !ts.isReturnStatement(finalStatement) ||
    finalStatement.expression === undefined ||
    !ts.isAwaitExpression(finalStatement.expression) ||
    finalStatement.expression.expression !== publishCalls[0] ||
    publishCalls[0]?.arguments
      .map((argument) => argument.getText(sourceFile))
      .join("\n") !==
      [
        "ISSUE_PATH",
        "`${prefix}${JSON.stringify(issue)}\\n`",
        "runId",
        "context",
      ].join("\n")
  ) {
    issues.push("appendIssue must unconditionally persist its ledger row");
  }
  issues.push(...latestOpenClosureContractIssues(source));
  return issues;
}

function finalizationPublicationContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const publishers = functionDeclarationsNamed(sourceFile, "publishFinalizationText");
  const publisher = publishers[0];
  const returnStatement = publisher?.body?.statements[0];
  const secureCalls =
    publisher === undefined
      ? []
      : callsNamed(publisher, "publishFinalizationTextSecure");
  const secureCall = secureCalls[0];
  const secureImports = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "./codebase-improvement-runtime.ts" ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      return [];
    }
    return statement.importClause.namedBindings.elements.filter(
      (element) =>
        element.propertyName?.text === "publishFinalizationText" &&
        element.name.text === "publishFinalizationTextSecure",
    );
  });
  if (
    publishers.length !== 1 ||
    publisher?.parameters.map((parameter) => parameter.name.getText(sourceFile)).join("\n") !==
      ["path", "value", "_runId", "context"].join("\n") ||
    publisher.body?.statements.length !== 1 ||
    returnStatement === undefined ||
    !ts.isReturnStatement(returnStatement) ||
    returnStatement.expression === undefined ||
    !ts.isAwaitExpression(returnStatement.expression) ||
    returnStatement.expression.expression !== secureCall ||
    secureCalls.length !== 1 ||
    secureCall?.arguments.map((argument) => argument.getText(sourceFile)).join("\n") !==
      ["path", "value", "context"].join("\n") ||
    secureImports.length !== 1 ||
    propertyCallsNamed(sourceFile, "commitPublication").length !== 0 ||
    callsNamed(sourceFile, "renameSync").length !== 0 ||
    callsNamed(sourceFile, "rmSync").length !== 0
  ) {
    issues.push(
      "finalization publication must delegate only to the secure ignored-runtime helper",
    );
  }
  return issues;
}

function secureFinalizationPublicationContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    runtimePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const publishers = functionDeclarationsNamed(sourceFile, "publishFinalizationText");
  const publisher = publishers[0];
  const temporary =
    publisher === undefined
      ? undefined
      : variableNamed(publisher, "temporaryPath")?.initializer;
  const open = publisher === undefined ? undefined : callsNamed(publisher, "openSync")[0];
  if (
    publishers.length !== 1 ||
    temporary?.getText(sourceFile) !==
      '`${destination}.tmp-${randomBytes(24).toString("hex")}`' ||
    open?.arguments.map((argument) => argument.getText(sourceFile)).join("\n") !==
      [
        "temporaryPath",
        "constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY",
        "0o600",
      ].join("\n") ||
    callsNamed(publisher, "fchmodSync").length !== 1
  ) {
    issues.push(
      "finalization publication must create a cryptographically random exclusive 0600 same-directory file",
    );
  }

  const tryStatement = publisher?.body?.statements.find(ts.isTryStatement);
  const tryStatements = tryStatement?.tryBlock.statements ?? [];
  const parentHelpers = functionDeclarationsNamed(
    sourceFile,
    "prepareFinalizationPublicationParent",
  );
  const parentHelper = parentHelpers[0];
  const directoryValidators = functionDeclarationsNamed(
    sourceFile,
    "assertRealFinalizationDirectory",
  );
  const parentCalls =
    publisher === undefined
      ? []
      : callsNamed(publisher, "prepareFinalizationPublicationParent");
  const firstTryStatement = tryStatements[0];
  const componentLoops: ts.ForOfStatement[] = [];
  const collectComponentLoops = (node: ts.Node): void => {
    if (ts.isForOfStatement(node)) componentLoops.push(node);
    ts.forEachChild(node, collectComponentLoops);
  };
  if (parentHelper !== undefined) collectComponentLoops(parentHelper);
  const componentLoop = componentLoops[0];
  const helperText = parentHelper?.getText(sourceFile) ?? "";
  const loopText = componentLoop?.getText(sourceFile) ?? "";
  const validatorText = directoryValidators[0]?.getText(sourceFile) ?? "";
  const lstatIndex = loopText.indexOf("lstatSync(component, { bigint: true });");
  const mkdirIndex = loopText.indexOf("mkdirSync(component, { mode: 0o700 });");
  const validateIndex = loopText.indexOf(
    "assertRealFinalizationDirectory(component);",
  );
  if (
    parentHelpers.length !== 1 ||
    directoryValidators.length !== 1 ||
    parentCalls.length !== 1 ||
    !isCallAtPath(
      ts.isExpressionStatement(firstTryStatement)
        ? firstTryStatement.expression
        : undefined,
      ["prepareFinalizationPublicationParent"],
    ) ||
    parentCalls[0]?.arguments.map((argument) => argument.getText(sourceFile)).join("\n") !==
      "destination" ||
    !helperText.includes("const root = resolve(process.cwd());") ||
    !helperText.includes("const parent = resolve(dirname(destination));") ||
    !helperText.includes("const suffix = relative(root, parent);") ||
    !helperText.includes("isAbsolute(suffix)") ||
    !helperText.includes("assertRealFinalizationDirectory(root);") ||
    componentLoops.length !== 1 ||
    componentLoop?.expression.getText(sourceFile) !==
      "suffix.split(sep).filter(Boolean)" ||
    lstatIndex < 0 ||
    mkdirIndex < 0 ||
    validateIndex < 0 ||
    lstatIndex >= mkdirIndex ||
    mkdirIndex >= validateIndex ||
    !loopText.includes("(lstatSync(component, { bigint: true }).mode & 0o777n) !== 0o700n") ||
    !validatorText.includes("!status.isDirectory()") ||
    !validatorText.includes("status.isSymbolicLink()")
  ) {
    issues.push(
      "finalization publication must create and validate each real parent before temporary-file creation",
    );
  }

  const commit = publisher === undefined ? undefined : variableNamed(publisher, "commit");
  const commitCall =
    commit?.initializer !== undefined &&
    isCallAtPath(commit.initializer, ["context", "commitPublication"])
      ? commit.initializer
      : undefined;
  const commitIndex = commit?.parent.parent === undefined
    ? -1
    : tryStatements.indexOf(commit.parent.parent);
  const renameStatement = tryStatements[commitIndex + 1];
  const returnStatement = tryStatements[commitIndex + 2];
  if (
    commitCall === undefined ||
    commitCall.arguments.length !== 0 ||
    commitIndex !== tryStatements.length - 3 ||
    renameStatement?.getText(sourceFile) !==
      "renameSync(temporaryPath, destination);" ||
    !ts.isReturnStatement(returnStatement) ||
    returnStatement.expression?.getText(sourceFile) !== "commit" ||
    callsNamed(tryStatement?.tryBlock ?? sourceFile, "writeFileSync").length !== 1 ||
    callsNamed(tryStatement?.tryBlock ?? sourceFile, "fsyncSync").length !== 1 ||
    callsNamed(tryStatement?.tryBlock ?? sourceFile, "closeSync").length !== 1 ||
    callsNamed(tryStatement?.tryBlock ?? sourceFile, "fstatSync").length !== 2 ||
    callsNamed(tryStatement?.tryBlock ?? sourceFile, "lstatSync").length !== 2 ||
    callsNamed(tryStatement?.tryBlock ?? sourceFile, "assertFinalizationPublicationStatus").length !== 3 ||
    propertyCallsNamed(publisher, "commitPublication").length !== 1
  ) {
    issues.push(
      "finalization publication must finish write close and identity validation before one authentic commit immediately followed by rename",
    );
  }

  const cleanup = functionDeclarationsNamed(
    sourceFile,
    "removeExactFinalizationTemporaryFile",
  )[0];
  const cleanupText = cleanup?.getText(sourceFile) ?? "";
  const publisherText = publisher?.getText(sourceFile) ?? "";
  const identityValidator = functionDeclarationsNamed(
    sourceFile,
    "assertFinalizationPublicationStatus",
  )[0]?.getText(sourceFile) ?? "";
  if (
    !publisherText.includes(
      "removeExactFinalizationTemporaryFile(temporaryPath, identity);",
    ) ||
    !cleanupText.includes("status = lstatSync(path, { bigint: true });") ||
    !cleanupText.includes("assertFinalizationPublicationStatus(status, identity, path);") ||
    !cleanupText.includes("unlinkSync(path);") ||
    cleanupText.includes("rmSync") ||
    !identityValidator.includes("status.dev !== identity.device") ||
    !identityValidator.includes("status.ino !== identity.inode") ||
    !identityValidator.includes("!status.isFile()") ||
    !identityValidator.includes("status.isSymbolicLink()") ||
    !identityValidator.includes("(status.mode & 0o777n) !== 0o600n")
  ) {
    issues.push(
      "finalization publication cleanup must unlink only its exact validated regular-file identity",
    );
  }
  return issues;
}

function statusAndArtifactContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const statusCalls = callsNamed(sourceFile, "createWorkflowStatusWriter");
  const writer = statusCalls[0]?.arguments[0];
  if (
    statusCalls.length !== 1 ||
    writer === undefined ||
    !ts.isArrowFunction(writer) ||
    writer.body.getText(sourceFile) !== "void process.stderr.write(text)"
  ) {
    issues.push("workflow progress writer must be unconditional");
  }

  const finalizers = callsNamed(sourceFile, "finalizeWorkflowEvidence");
  const finalizerImports = sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "./codebase-improvement-runtime.ts" ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      return [];
    }
    return statement.importClause.namedBindings.elements.filter(
      (element) =>
        element.propertyName === undefined &&
        element.name.text === "finalizeWorkflowEvidence",
    );
  });
  const bindingContainsFinalizer = (name: ts.BindingName): boolean => {
    if (ts.isIdentifier(name)) return name.text === "finalizeWorkflowEvidence";
    return name.elements.some(
      (element) =>
        !ts.isOmittedExpression(element) &&
        bindingContainsFinalizer(element.name),
    );
  };
  const finalizerShadows: ts.Node[] = [];
  const visitFinalizerShadows = (node: ts.Node): void => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      bindingContainsFinalizer(node.name)
    ) {
      finalizerShadows.push(node);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name?.text === "finalizeWorkflowEvidence"
    ) {
      finalizerShadows.push(node);
    }
    ts.forEachChild(node, visitFinalizerShadows);
  };
  visitFinalizerShadows(sourceFile);
  const finalizerErrorDeclarations = variablesNamed(
    sourceFile,
    "finalizerErrors",
  );
  const finalizerErrorInitializer = finalizerErrorDeclarations[0]?.initializer;
  if (
    finalizerImports.length !== 1 ||
    finalizerShadows.length !== 0 ||
    finalizers.length !== 1 ||
    finalizerErrorDeclarations.length !== 1 ||
    finalizerErrorInitializer === undefined ||
    !ts.isAwaitExpression(finalizerErrorInitializer) ||
    finalizerErrorInitializer.expression !== finalizers[0]
  ) {
    issues.push(
      "workflow finalization must directly await the unshadowed runtime helper",
    );
  }
  const options = finalizers[0]?.arguments[0];
  const artifactsProperty =
    options !== undefined && ts.isObjectLiteralExpression(options)
      ? propertyAssignmentNamed(options, "artifacts")
      : undefined;
  const artifacts = artifactsProperty?.initializer;
  const reportProperty =
    options !== undefined && ts.isObjectLiteralExpression(options)
      ? propertyAssignmentNamed(options, "report")
      : undefined;
  const reportAction = reportProperty?.initializer;
  if (
    finalizers.length !== 1 ||
    artifacts === undefined ||
    !ts.isArrayLiteralExpression(artifacts) ||
    reportAction === undefined ||
    !ts.isObjectLiteralExpression(reportAction)
  ) {
    issues.push("workflow finalization must declare artifact writers");
    return issues;
  }
  const artifactLabels = artifacts.elements.map((element) => {
    if (!ts.isObjectLiteralExpression(element)) return undefined;
    const label = propertyAssignmentNamed(element, "label")?.initializer;
    return label !== undefined && ts.isStringLiteralLike(label)
      ? label.text
      : undefined;
  });
  const reportLabel = propertyAssignmentNamed(reportAction, "label")?.initializer;
  if (
    artifactLabels.join("\n") !==
      ["issue ledger", "delivery record", "monitor"].join("\n") ||
    reportLabel === undefined ||
    !ts.isStringLiteralLike(reportLabel) ||
    reportLabel.text !== "report"
  ) {
    issues.push("report must be terminal after the delivery record artifact");
  }

  const monitorArtifact = artifacts.elements.find((element) => {
    if (!ts.isObjectLiteralExpression(element)) return false;
    const label = propertyAssignmentNamed(element, "label")?.initializer;
    return label !== undefined && ts.isStringLiteralLike(label) && label.text === "monitor";
  });
  const monitorRun =
    monitorArtifact !== undefined && ts.isObjectLiteralExpression(monitorArtifact)
      ? propertyAssignmentNamed(monitorArtifact, "run")?.initializer
      : undefined;
  const monitorPublish =
    monitorRun !== undefined && ts.isArrowFunction(monitorRun) && ts.isBlock(monitorRun.body)
      ? callsNamed(monitorRun.body, "publishFinalizationText")
      : [];
  const monitorPublishStatement = monitorPublish[0]?.parent?.parent;
  if (
    monitorRun === undefined ||
    !ts.isArrowFunction(monitorRun) ||
    monitorRun.parameters[0]?.name.getText(sourceFile) !== "context" ||
    !ts.isBlock(monitorRun.body) ||
    monitorRun.body.statements.length !== 1 ||
    monitorPublish.length !== 1 ||
    monitorPublishStatement !== monitorRun.body.statements[0] ||
    !ts.isReturnStatement(monitorPublishStatement) ||
    monitorPublishStatement.expression === undefined ||
    !ts.isAwaitExpression(monitorPublishStatement.expression) ||
    monitorPublishStatement.expression.expression !== monitorPublish[0] ||
    monitorPublish[0]?.arguments
      .map((argument) => argument.getText(sourceFile))
      .join("\n") !==
      [
        "`${MONITOR_DIR}/${monitor.runId}.json`",
        "`${JSON.stringify(monitor.toJson(), null, 2)}\\n`",
        "runId",
        "context",
      ].join("\n") ||
    callsNamed(monitorRun.body, "writeLog").length !== 0
  ) {
    issues.push("monitor artifact writer must atomically publish fresh toJson");
  }

  const reportRun = propertyAssignmentNamed(reportAction, "run")?.initializer;
  const reportPublish =
    reportRun !== undefined && ts.isArrowFunction(reportRun) && ts.isBlock(reportRun.body)
      ? callsNamed(reportRun.body, "publishFinalizationText")
      : [];
  const reportStatements =
    reportRun !== undefined && ts.isArrowFunction(reportRun) && ts.isBlock(reportRun.body)
      ? reportRun.body.statements.map((statement) => compactSource(statement.getText(sourceFile)))
      : [];
  if (
    reportRun === undefined ||
    !ts.isArrowFunction(reportRun) ||
    reportRun.parameters[0]?.name.getText(sourceFile) !== "context" ||
    !ts.isBlock(reportRun.body) ||
    reportPublish.length !== 1 ||
    reportPublish[0]?.arguments
      .map((argument) => argument.getText(sourceFile))
      .join("\n") !==
      [
        "`${REPORT_DIR}/${runId}/report.json`",
        "`${JSON.stringify(report, null, 2)}\\n`",
        "runId",
        "context",
      ].join("\n") ||
    reportStatements.length !== 6 ||
    reportStatements[0] !== "const finishedAtMs = Date.now();" ||
    reportStatements[1] !== "const remainingAtReport = context.remainingMs();" ||
    reportStatements[2] !== "report.finishedAtMs = finishedAtMs;" ||
    reportStatements[3] !== "report.elapsedMs = finishedAtMs - startedAtMs;" ||
    !reportStatements[4]?.startsWith("report.sla =") ||
    !reportStatements[4]?.includes("report.elapsedMs <= runtimeDeadlineMs()") ||
    !reportStatements[4]?.includes("remainingAtReport > 0") ||
    !reportStatements[5]?.startsWith("return await publishFinalizationText(")
  ) {
    issues.push("report artifact writer must compute terminal SLA before atomic publication");
  }
  const issueArtifact = artifacts.elements.find((element) => {
    if (!ts.isObjectLiteralExpression(element)) return false;
    const property = propertyAssignmentNamed(element, "label");
    return (
      property !== undefined &&
      ts.isStringLiteralLike(property.initializer) &&
      property.initializer.text === "issue ledger"
    );
  });
  const issueRun =
    issueArtifact !== undefined && ts.isObjectLiteralExpression(issueArtifact)
      ? propertyAssignmentNamed(issueArtifact, "run")?.initializer
      : undefined;
  const issueStatement =
    issueRun !== undefined &&
    ts.isArrowFunction(issueRun) &&
    ts.isBlock(issueRun.body) &&
    issueRun.body.statements.length === 1
      ? issueRun.body.statements[0]
      : undefined;
  const issueBody =
    issueStatement !== undefined &&
    ts.isIfStatement(issueStatement) &&
    ts.isBlock(issueStatement.thenStatement)
      ? issueStatement.thenStatement
      : undefined;
  if (
    issueStatement === undefined ||
    !ts.isIfStatement(issueStatement) ||
    issueStatement.expression.getText(sourceFile) !==
      "pendingIssue !== undefined &&\n              pendingIssue !== persistedIssue" ||
    issueBody?.statements.map((statement) => statement.getText(sourceFile)).join("\n") !==
      [
        "const issue = pendingIssue;",
        "const commit = await appendIssue(issue, runId, context);",
        "persistedIssue = issue;",
        "return commit;",
      ].join("\n")
  ) {
    issues.push("issue ledger artifact writer must run unconditionally");
  }
  return [...issues, ...finalizationPublicationContractIssues(source)];
}

function runIssueContextContractIssues(source: string): string[] {
  const issues: string[] = [];
  const interfaceStart = source.indexOf("interface RunIssue {");
  const interfaceEnd = source.indexOf("\n}", interfaceStart);
  const interfaceBody = source.slice(interfaceStart, interfaceEnd);
  for (const field of [
    "  backend: string;",
    "  worktree: string;",
    "  branch: string;",
    "  monitorPath: string;",
    "  prUrl?: string;",
  ]) {
    if (!interfaceBody.includes(field)) {
      issues.push(`RunIssue missing context field: ${field.trim()}`);
    }
  }
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const builder = variableNamed(sourceFile, "buildRunIssue");
  const body = builder?.initializer?.getText(sourceFile) ?? "";
  for (const field of [
    "backend: report.backend",
    "worktree: report.worktree",
    "branch: report.branch",
    "monitorPath: `${MONITOR_DIR}/${monitor.runId}.json`",
    "report.prUrl === undefined ? {} : { prUrl: report.prUrl }",
  ]) {
    if (!body.includes(field)) {
      issues.push(`new run issue missing context binding: ${field}`);
    }
  }
  if (callsNamed(sourceFile, "buildRunIssue").length !== 2) {
    issues.push("every failure path must use buildRunIssue");
  }
  return issues;
}

function reviewCompletionContractIssues(source: string): string[] {
  const issues: string[] = [];
  const countLiteral = (literal: string): number =>
    source.split(literal).length - 1;

  const reportStart = source.indexOf("interface RunReport {");
  const reportEnd = source.indexOf("\n}", reportStart);
  const reportType = source.slice(reportStart, reportEnd);
  for (const field of [
    "  initialReviewFindings?: ReviewFinding[];",
    "  finalReviewFindings?: ReviewFinding[];",
    "  finalReviewBlockerCount?: number;",
  ]) {
    if (!reportType.includes(field)) {
      issues.push(`RunReport missing exact optional field: ${field.trim()}`);
    }
  }

  const reportInitializerStart = source.indexOf("const report: RunReport = {");
  const reportInitializerEnd = source.indexOf(
    "\n  };",
    reportInitializerStart,
  );
  const reportInitializer = source.slice(
    reportInitializerStart,
    reportInitializerEnd,
  );
  for (const field of [
    "initialReviewFindings",
    "finalReviewFindings",
    "finalReviewBlockerCount",
  ]) {
    if (reportInitializer.includes(field)) {
      issues.push(`${field} must stay absent until review completes`);
    }
  }

  const reviewStageStart = source.indexOf(
    'await monitor.stage("review", async () => {',
  );
  const reviewRepairEnter = source.indexOf(
    'enter("review-repair")',
    reviewStageStart,
  );
  const reviewStage = source.slice(reviewStageStart, reviewRepairEnter);
  const initialEvidence = [
    '      reviewFindings = await performReview("review");',
    "      report.initialReviewFindings = [...reviewFindings];",
  ].join("\n");
  if (!reviewStage.includes(initialEvidence)) {
    issues.push(
      "initial findings must be copied immediately after successful first review",
    );
  }
  if (
    countLiteral("report.initialReviewFindings = [...reviewFindings];") !== 1
  ) {
    issues.push("initial findings snapshot must be assigned exactly once");
  }

  const reviewRepairStart = source.indexOf(
    'await monitor.stage("review-repair", async () => {',
    reviewRepairEnter,
  );
  const repeatedReview = source.indexOf(
    'reviewFindings = await performReview("repeated review");',
    reviewRepairStart,
  );
  const reviewRepairEnd = source.indexOf("\n    });", repeatedReview);
  const reviewRepair = source.slice(reviewRepairStart, reviewRepairEnd);
  const noBlockerEvidence = [
    "      if (blockers.length === 0) {",
    "        report.finalReviewFindings = [...reviewFindings];",
    "        report.finalReviewBlockerCount = 0;",
    "        return;",
    "      }",
  ].join("\n");
  if (!reviewRepair.includes(noBlockerEvidence)) {
    issues.push("no-blocker branch must persist final evidence before return");
  }
  const repeatedEvidence = [
    '      reviewFindings = await performReview("repeated review");',
    "      const remaining = blockingFindings(reviewFindings);",
    "      report.finalReviewFindings = [...reviewFindings];",
    "      report.finalReviewBlockerCount = remaining.length;",
    "      if (remaining.length > 0) {",
  ].join("\n");
  if (!reviewRepair.includes(repeatedEvidence)) {
    issues.push(
      "repeated review must persist final evidence before blocker throw",
    );
  }
  if (countLiteral("report.finalReviewFindings = [...reviewFindings];") !== 2) {
    issues.push("final findings must be assigned in exactly two review branches");
  }
  if (countLiteral("report.finalReviewBlockerCount =") !== 2) {
    issues.push("final blocker count must be assigned in exactly two branches");
  }

  const verifyEnter = source.indexOf('enter("verify")', reviewRepairEnd);
  const postReview = source.slice(reviewRepairEnd, verifyEnter);
  const zeroBlockerGuard = [
    "    if (report.finalReviewBlockerCount !== 0) {",
    '      throw new Error("review completion did not record zero blockers");',
    "    }",
  ].join("\n");
  if (!postReview.includes(zeroBlockerGuard)) {
    issues.push("verification must require persisted zero final blockers");
  }

  const blockingStart = source.indexOf("function blockingFindings(");
  const blockingEnd = source.indexOf("\n}", blockingStart);
  const blockingBody = source.slice(blockingStart, blockingEnd);
  if (
    !blockingBody.includes(
      'finding.severity === "high" || finding.severity === "critical"',
    ) ||
    blockingBody.includes('finding.severity === "low"') ||
    blockingBody.includes('finding.severity === "medium"')
  ) {
    issues.push("only high and critical review findings may block delivery");
  }

  const mergeStart = source.indexOf('enter("merge")');
  const mergeConfirmed = source.indexOf(
    "report.mergeProof = await mergePullRequestBounded(",
    mergeStart,
  );
  const completedReason = source.indexOf(
    'report.stopReason = "completed";',
    mergeStart,
  );
  const outcomeStart = source.indexOf(
    "monitor.recordOutcome({",
    completedReason,
  );
  const outcomeEnd = source.indexOf("\n    });", outcomeStart);
  if (
    mergeConfirmed < 0 ||
    completedReason <= mergeConfirmed ||
    outcomeStart <= completedReason
  ) {
    issues.push(
      "completed reason must follow merge proof before launcher-terminal issue resolution",
    );
  }
  const successfulOutcome = source.slice(completedReason, outcomeEnd);
  if (
    !successfulOutcome.startsWith(
      'report.stopReason = "completed";\n    monitor.recordOutcome({',
    ) ||
    !successfulOutcome.includes('      reason: "completed",')
  ) {
    issues.push("report and successful monitor outcome must say completed");
  }
  if (countLiteral('report.stopReason = "completed";') !== 1) {
    issues.push("successful report reason must be assigned exactly once");
  }

  const catchStart = source.indexOf("  } catch (error) {");
  const finallyStart = source.indexOf("  } finally {", catchStart);
  const catchBody = source.slice(catchStart, finallyStart);
  if (!catchBody.includes("report.stopReason = normalizeFailure(error);")) {
    issues.push("body failure must retain its normalized stop reason");
  }
  const finalizationStart = source.indexOf(
    "const finalizerErrors = await finalizeWorkflowEvidence({",
    finallyStart,
  );
  const finalizationEnd = source.indexOf(
    "console.log(`monitor=",
    finalizationStart,
  );
  const finalization = source.slice(finalizationStart, finalizationEnd);
  if (!finalization.includes("report.stopReason = stopReason;")) {
    issues.push("finalization failure must retain its finalization stop reason");
  }

  return issues;
}

function correction16LedgerContractIssues(source: string): string[] {
  const start = source.indexOf("## Correction 16:");
  const end = source.indexOf("## Correction 17:", start);
  if (start < 0 || end <= start) {
    return ["Correction 16 and Correction 17 sections must be ordered"];
  }
  const correction16 = source.slice(start, end);
  const issues: string[] = [];
  if (
    !correction16.includes(
      "atomically commit same-ID resolved records for every latest-open ledger ID.",
    )
  ) {
    issues.push("Correction 16 must delegate count-free closure to launcher commit");
  }
  if (/\b\d+\s+(?:latest-)?open ledger entries\b/.test(correction16)) {
    issues.push("Correction 16 must not hard-code an open-ledger remainder");
  }
  return issues;
}

function ancestorMonitorStageLabel(node: ts.Node): string | undefined {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (
      isCallAtPath(parent, ["monitor", "stage"]) &&
      parent.arguments[0] !== undefined &&
      ts.isStringLiteralLike(parent.arguments[0])
    ) {
      return parent.arguments[0].text;
    }
  }
  return undefined;
}

function ignoredOrcaGuardContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const captureDeclarations = functionDeclarationsNamed(
    sourceFile,
    "captureIgnoredOrcaContentManifest",
  );
  const capture = captureDeclarations[0];
  const contentCaptures =
    capture === undefined
      ? []
      : callsNamed(capture, "captureFileContentManifest");
  const captureReturn = capture?.body?.statements.at(-1);
  const captureAwait =
    captureReturn !== undefined &&
    ts.isReturnStatement(captureReturn) &&
    captureReturn.expression !== undefined &&
    ts.isAwaitExpression(captureReturn.expression)
      ? captureReturn.expression.expression
      : undefined;
  if (
    captureDeclarations.length !== 1 ||
    contentCaptures.length !== 1 ||
    captureAwait !== contentCaptures[0] ||
    !isCallAtPath(captureAwait, ["captureFileContentManifest"]) ||
    captureAwait.arguments[0]?.getText(sourceFile) !== "paths" ||
    captureAwait.arguments[1] === undefined ||
    !ts.isObjectLiteralExpression(captureAwait.arguments[1])
  ) {
    issues.push(
      "ignored .orca capture helper must directly return its bounded content manifest",
    );
  }
  const guardDeclarations = functionDeclarationsNamed(
    sourceFile,
    "withStableIgnoredOrcaGuard",
  );
  if (guardDeclarations.length !== 1) {
    issues.push(
      `expected one stable ignored .orca guard; received ${String(guardDeclarations.length)}`,
    );
  }
  const guard = guardDeclarations[0];
  const finalStatement = guard?.body?.statements.at(-1);
  const returnedExpression =
    finalStatement !== undefined &&
    ts.isReturnStatement(finalStatement) &&
    finalStatement.expression !== undefined &&
    ts.isAwaitExpression(finalStatement.expression)
      ? finalStatement.expression.expression
      : undefined;
  const runtimeGuard = isCallAtPath(returnedExpression, [
    "withGitManifestGuard",
  ])
    ? returnedExpression
    : undefined;
  if (
    runtimeGuard === undefined ||
    runtimeGuard.arguments.length !== 2 ||
    !isIdentifierNamed(runtimeGuard.arguments[1], "operation")
  ) {
    issues.push(
      "ignored .orca guard must directly delegate to runtime manifest guard",
    );
  } else {
    const reader = runtimeGuard.arguments[0];
    if (
      reader === undefined ||
      !(ts.isArrowFunction(reader) || ts.isFunctionExpression(reader)) ||
      !ts.isBlock(reader.body)
    ) {
      issues.push("ignored .orca guard must own a manifest reader callback");
    } else {
      const captures = callsNamed(reader, "captureIgnoredOrcaContentManifest");
      const assertions = callsNamed(reader, "assertIgnoredOrcaContentManifest");
      const actualDeclaration = variableNamed(reader.body, "actual");
      const actualInitializer = actualDeclaration?.initializer;
      const actualCapture =
        actualInitializer !== undefined &&
        ts.isAwaitExpression(actualInitializer) &&
        isCallAtPath(actualInitializer.expression, [
          "captureIgnoredOrcaContentManifest",
        ])
          ? actualInitializer.expression
          : undefined;
      const actualStatement = actualDeclaration?.parent.parent;
      const comparison = reader.body.statements[1];
      const expectedAssignment =
        comparison !== undefined &&
        ts.isIfStatement(comparison) &&
        ts.isBlock(comparison.thenStatement)
          ? comparison.thenStatement.statements[0]
          : undefined;
      const elseBlock =
        comparison !== undefined &&
        ts.isIfStatement(comparison) &&
        comparison.elseStatement !== undefined &&
        ts.isBlock(comparison.elseStatement)
          ? comparison.elseStatement
          : undefined;
      const directAssertion = elseBlock?.statements[0];
      const returned = reader.body.statements[2];
      if (
        captures.length !== 1 ||
        actualCapture !== captures[0] ||
        actualStatement !== reader.body.statements[0] ||
        actualCapture?.arguments.length !== 1 ||
        !isIdentifierNamed(actualCapture?.arguments[0], "remaining")
      ) {
        issues.push(
          "ignored .orca guard reader must await one bounded content capture",
        );
      }
      if (
        reader.body.statements.length !== 3 ||
        comparison === undefined ||
        !ts.isIfStatement(comparison) ||
        comparison.expression.getText(sourceFile) !==
          "expected === undefined" ||
        expectedAssignment?.getText(sourceFile) !== "expected = actual;" ||
        elseBlock?.statements.length !== 1 ||
        directAssertion === undefined ||
        !ts.isExpressionStatement(directAssertion) ||
        directAssertion.expression !== assertions[0] ||
        assertions.length !== 1 ||
        assertions[0]?.arguments
          .map((argument) => argument.getText(sourceFile))
          .join("\n") !== ["expected", "actual", "label"].join("\n") ||
        returned === undefined ||
        !ts.isReturnStatement(returned) ||
        returned.expression?.getText(sourceFile) !== "actual"
      ) {
        issues.push(
          "ignored .orca guard reader must actively compare and return each capture",
        );
      }
    }
  }

  const assertionDeclarations = functionDeclarationsNamed(
    sourceFile,
    "assertIgnoredOrcaContentManifest",
  );
  const assertion = assertionDeclarations[0];
  const assertionStatement = assertion?.body?.statements[0];
  const assertionCall =
    assertion?.body?.statements.length === 1 &&
    assertionStatement !== undefined &&
    ts.isExpressionStatement(assertionStatement) &&
    isCallAtPath(assertionStatement.expression, ["assertGitManifestUnchanged"])
      ? assertionStatement.expression
      : undefined;
  if (
    assertionDeclarations.length !== 1 ||
    assertionCall === undefined ||
    assertionCall.arguments[0]?.getText(sourceFile) !== "expected" ||
    assertionCall.arguments[1]?.getText(sourceFile) !== "actual" ||
    assertionCall.arguments[2]?.getText(sourceFile) !==
      "`${label} ignored .orca content`"
  ) {
    issues.push(
      "ignored .orca comparator must directly delegate to Git manifest comparator",
    );
  }

  const expectedStages = new Map([
    ["baseline-repair", { monitor: "preflight", budget: "preflight" }],
    ["reproduce", { monitor: "reproduce", budget: "reproduce" }],
    ["implement", { monitor: "implement", budget: "implement" }],
    ["targeted-repair", { monitor: "targeted-repair", budget: "repairs" }],
    ["review-repair", { monitor: "review-repair", budget: "repairs" }],
  ]);
  const guardCalls = callsNamed(sourceFile, "withStableIgnoredOrcaGuard");
  const seenStages = new Set<string>();
  if (guardCalls.length !== expectedStages.size) {
    issues.push(
      `expected five workspace-write ignored .orca guards; received ${String(guardCalls.length)}`,
    );
  }
  for (const call of guardCalls) {
    const label =
      call.arguments[0] !== undefined &&
      ts.isStringLiteralLike(call.arguments[0])
        ? call.arguments[0].text
        : undefined;
    const expected = label === undefined ? undefined : expectedStages.get(label);
    const remaining = call.arguments[1];
    const operation = call.arguments[2];
    const budgetCalls =
      remaining !== undefined &&
      (ts.isArrowFunction(remaining) || ts.isFunctionExpression(remaining))
        ? callsNamed(remaining, "budget")
        : [];
    const autonomousCalls =
      operation !== undefined &&
      (ts.isArrowFunction(operation) || ts.isFunctionExpression(operation))
        ? propertyCallsNamed(operation, "autonomous")
        : [];
    if (
      label === undefined ||
      expected === undefined ||
      seenStages.has(label) ||
      call.arguments.length !== 3 ||
      ancestorMonitorStageLabel(call) !== expected?.monitor ||
      budgetCalls.length !== 1 ||
      budgetCalls[0]?.arguments[0]?.getText(sourceFile) !==
        JSON.stringify(expected?.budget) ||
      autonomousCalls.length !== 1
    ) {
      issues.push("workspace-write guards must own the exact five autonomous stages");
    }
    if (label !== undefined) seenStages.add(label);
  }
  if (
    seenStages.size !== expectedStages.size ||
    [...expectedStages.keys()].some((label) => !seenStages.has(label))
  ) {
    issues.push("workspace-write guards must own the exact five autonomous stages");
  }

  return [...new Set(issues)];
}

function verifiedCandidateManifestContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  const verifiedAssignments: ts.BinaryExpression[] = [];
  const visitAssignments = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isIdentifierNamed(node.left, "verifiedContentManifest")
    ) {
      verifiedAssignments.push(node);
    }
    ts.forEachChild(node, visitAssignments);
  };
  visitAssignments(sourceFile);
  const verifiedAssignment = verifiedAssignments[0];
  const verifiedCapture =
    verifiedAssignment?.right !== undefined &&
    ts.isAwaitExpression(verifiedAssignment.right) &&
    isCallAtPath(verifiedAssignment.right.expression, [
      "captureCandidateWorktreeManifest",
    ])
      ? verifiedAssignment.right.expression
      : undefined;
  if (
    verifiedAssignments.length !== 1 ||
    verifiedCapture === undefined ||
    verifiedCapture.arguments[0]?.getText(sourceFile) !== "paths" ||
    ancestorMonitorStageLabel(verifiedAssignment!) !== "verify"
  ) {
    issues.push(
      "verified candidate manifest must come directly from verified worktree bytes",
    );
  }

  const commitStages = propertyCallsNamed(sourceFile, "stage").filter(
    (call) =>
      isCallAtPath(call, ["monitor", "stage"]) &&
      call.arguments[0] !== undefined &&
      ts.isStringLiteralLike(call.arguments[0]) &&
      call.arguments[0].text === "commit-push",
  );
  const commitStage = commitStages[0];
  const callback = commitStage?.arguments[1];
  const block =
    callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    ts.isBlock(callback.body)
      ? callback.body
      : undefined;
  if (commitStages.length !== 1 || block === undefined) {
    issues.push("commit-push must own one direct manifest-bound callback");
    return issues;
  }

  const captureIndex = (
    name: string,
    callee: string,
    issue: string,
  ): number => {
    const declarations = variablesNamed(block, name);
    const declaration = declarations[0];
    const initializer = declaration?.initializer;
    const capture =
      initializer !== undefined &&
      ts.isAwaitExpression(initializer) &&
      isCallAtPath(initializer.expression, [callee])
        ? initializer.expression
        : undefined;
    const statement = declaration?.parent.parent;
    const index =
      statement !== undefined &&
      ts.isVariableStatement(statement) &&
      statement.parent === block
        ? block.statements.indexOf(statement)
        : -1;
    if (
      declarations.length !== 1 ||
      capture === undefined ||
      capture.arguments[0]?.getText(sourceFile) !== "paths" ||
      index < 0
    ) {
      issues.push(issue);
    }
    return index;
  };
  const preStageCapture = captureIndex(
    "preStageManifest",
    "captureCandidateWorktreeManifest",
    "pre-stage candidate manifest must come from current worktree",
  );
  const stagedCapture = captureIndex(
    "stagedManifest",
    "captureCandidateIndexManifest",
    "staged candidate manifest must come from Git index",
  );
  const committedCapture = captureIndex(
    "committedManifest",
    "captureCandidateCommitManifest",
    "committed candidate manifest must come from commit tree",
  );
  const prePushCapture = captureIndex(
    "prePushWorktreeManifest",
    "captureCandidateWorktreeManifest",
    "pre-push candidate manifest must come from current worktree",
  );

  const gitRequiredStatementIndex = (
    command: string,
  ): number =>
    block.statements.findIndex((statement) =>
      callsNamed(statement, "runRequired").some((call) => {
        const args = call.arguments[1];
        return (
          call.arguments[0]?.getText(sourceFile) === '"git"' &&
          args !== undefined &&
          ts.isArrayLiteralExpression(args) &&
          args.elements[0] !== undefined &&
          ts.isStringLiteralLike(args.elements[0]) &&
          args.elements[0].text === command
        );
      }),
    );
  const commit = gitRequiredStatementIndex("commit");
  const committedPathDeclarations = variablesNamed(block, "committedPaths");
  const committedPathDeclaration = committedPathDeclarations[0];
  const committedPathInitializer = committedPathDeclaration?.initializer;
  const committedPathQuery =
    committedPathInitializer !== undefined &&
    ts.isAwaitExpression(committedPathInitializer) &&
    isCallAtPath(committedPathInitializer.expression, ["runRequired"])
      ? committedPathInitializer.expression
      : undefined;
  const committedPathStatement = committedPathDeclaration?.parent.parent;
  const committedPathQueryIndex =
    committedPathStatement !== undefined &&
    ts.isVariableStatement(committedPathStatement) &&
    committedPathStatement.parent === block
      ? block.statements.indexOf(committedPathStatement)
      : -1;
  const committedPathArgs = committedPathQuery?.arguments[1];
  if (
    committedPathDeclarations.length !== 1 ||
    committedPathQuery === undefined ||
    committedPathQuery.arguments[0]?.getText(sourceFile) !== '"git"' ||
    committedPathArgs === undefined ||
    !ts.isArrayLiteralExpression(committedPathArgs) ||
    committedPathArgs.elements
      .map((argument) => argument.getText(sourceFile))
      .join("\n") !==
      [
        '"diff"',
        '"--name-only"',
        '"-z"',
        "preCommitHeadSha",
        "validatedHeadSha",
        '"--"',
      ].join("\n") ||
    committedPathQueryIndex < 0
  ) {
    issues.push("committed path query must read the full validated commit range");
  }
  const committedPathLogIndex = block.statements.findIndex(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      isCallAtPath(statement.expression, ["report", "validation", "push"]) &&
      statement.expression.arguments.length === 1 &&
      isIdentifierNamed(statement.expression.arguments[0], "committedPaths"),
  );
  const committedPathComparisonIndex = block.statements.findIndex(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      isCallAtPath(statement.expression, ["parseExactGitPathList"]) &&
      statement.expression.arguments
        .map((argument) => argument.getText(sourceFile))
        .join("\n") ===
        [
          "committedPaths.stdout",
          "paths",
          '"committed candidate range"',
        ].join("\n"),
  );
  if (
    commit < 0 ||
    committedPathLogIndex !== committedPathQueryIndex + 1 ||
    committedPathComparisonIndex !== committedPathLogIndex + 1 ||
    committedPathComparisonIndex >= committedCapture
  ) {
    issues.push(
      "committed path-set comparison must directly dominate commit manifest and push",
    );
  }

  const directComparisonIndex = (
    actual: string,
    label: string,
  ): number =>
    block.statements.findIndex((statement) => {
      if (!ts.isExpressionStatement(statement)) return false;
      const call = isCallAtPath(statement.expression, [
        "assertGitManifestUnchanged",
      ])
        ? statement.expression
        : undefined;
      return (
        call !== undefined &&
        call.arguments
          .map((argument) => argument.getText(sourceFile))
          .join("\n") ===
          [
            "verifiedContentManifest",
            actual,
            JSON.stringify(label),
          ].join("\n")
      );
    });
  const preStageComparison = directComparisonIndex(
    "preStageManifest",
    "pre-stage candidate content",
  );
  const stagedComparison = directComparisonIndex(
    "stagedManifest",
    "staged candidate content",
  );
  const committedComparison = directComparisonIndex(
    "committedManifest",
    "committed candidate content",
  );
  const prePushComparison = directComparisonIndex(
    "prePushWorktreeManifest",
    "pre-push candidate worktree content",
  );
  if (preStageComparison < 0) {
    issues.push("pre-stage candidate comparison must be a direct guard");
  }
  if (stagedComparison < 0) {
    issues.push("staged candidate comparison must be a direct guard");
  }
  if (committedComparison < 0) {
    issues.push("committed candidate comparison must be a direct guard");
  }
  if (prePushComparison < 0) {
    issues.push("pre-push candidate comparison must be a direct guard");
  }

  const pushStatements: number[] = [];
  for (const [index, statement] of block.statements.entries()) {
    for (const call of callsNamed(statement, "runRequired")) {
      if (
        call.arguments[0]?.getText(sourceFile) === '"git"' &&
        call.arguments[1] !== undefined &&
        ts.isArrayLiteralExpression(call.arguments[1]) &&
        call.arguments[1].elements
          .map((element) => element.getText(sourceFile))
          .join("\n") ===
          [
            '"push"',
            "capturedOriginPushUrl",
            "`${validatedHeadSha}:refs/heads/${report.branch}`",
          ].join("\n") &&
        ts.isAwaitExpression(call.parent)
      ) {
        pushStatements.push(index);
      }
    }
  }
  const push = pushStatements[0] ?? -1;
  const prePushContext = block.statements.findIndex((statement) =>
    callsNamed(statement, "assertBoundGitContext").some(
      (call) => call.arguments[0]?.getText(sourceFile) === '"pre-push"',
    ),
  );
  if (
    prePushComparison < 0 ||
    pushStatements.length !== 1 ||
    prePushContext <= prePushComparison ||
    push <= prePushContext
  ) {
    issues.push(
      "pre-push candidate comparison must dominate bound Git context and push",
    );
  }
  if (
    !(
      preStageCapture < preStageComparison &&
      preStageComparison < stagedCapture &&
      stagedCapture < stagedComparison &&
      stagedComparison < commit &&
      commit < committedPathQueryIndex &&
      committedPathQueryIndex < committedPathComparisonIndex &&
      committedPathComparisonIndex < committedCapture &&
      committedCapture < committedComparison &&
      committedComparison < prePushCapture &&
      prePushCapture < prePushComparison &&
      prePushComparison < prePushContext &&
      prePushContext < push
    )
  ) {
    issues.push(
      "candidate manifests must compare in worktree, index, commit, push order",
    );
  }
  if (callsNamed(block, "assertGitManifestUnchanged").length !== 4) {
    issues.push("commit-push must contain exactly four manifest comparisons");
  }
  if (
    functionDeclarationsNamed(sourceFile, "assertGitManifestUnchanged").length >
      0 ||
    variablesNamed(sourceFile, "assertGitManifestUnchanged").length > 0
  ) {
    issues.push("workflow must not shadow the runtime Git manifest comparator");
  }

  return [...new Set(issues)];
}

function compactSource(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function deliveryAncestryContractIssues(source: string): string[] {
  const start = source.indexOf('monitor.stage("commit-push"');
  const end = source.indexOf('monitor.stage("pull-request"', start);
  const block = compactSource(source.slice(start, end));
  const issues: string[] = [];
  const preCommitHead = block.indexOf(
    'const preCommitHead = await runRequired( "git", ["rev-parse", "HEAD"], budget("delivery"), );',
  );
  const commit = block.indexOf('["commit", "-m", chosen.title]');
  const validatedHead = block.indexOf(
    'const validatedHead = await runRequired( "git", ["rev-parse", "HEAD"], budget("delivery"), );',
  );
  if (
    preCommitHead < 0 ||
    commit <= preCommitHead ||
    validatedHead <= commit ||
    !block.includes("report.validation.push(preCommitHead);") ||
    !block.includes(
      "const preCommitHeadSha = preCommitHead.stdout.trim();",
    ) ||
    !block.includes(
      "if ( !/^[0-9a-f]{40}$/.test(preCommitHeadSha) || preCommitHeadSha !== report.baseSha )",
    )
  ) {
    issues.push(
      "delivery must bind the exact pre-commit HEAD to the verified base",
    );
  }

  const parentQuery = block.indexOf(
    'const committedAncestry = await runRequired( "git", ["rev-list", "--parents", "-n", "1", validatedHeadSha], budget("delivery"), );',
  );
  if (
    parentQuery <= validatedHead ||
    !block.includes("report.validation.push(committedAncestry);") ||
    !block.includes(
      "const ancestryParts = committedAncestry.stdout.trim().split(/\\s+/);",
    ) ||
    !block.includes(
      "ancestryParts.length !== 2 || ancestryParts[0] !== validatedHeadSha || ancestryParts[1] !== preCommitHeadSha",
    )
  ) {
    issues.push(
      "delivery must prove the validated commit has exactly the pre-commit HEAD as parent",
    );
  }

  const rangeQuery = block.indexOf(
    '[ "diff", "--name-only", "-z", preCommitHeadSha, validatedHeadSha, "--", ]',
  );
  const exactPaths = block.indexOf(
    'parseExactGitPathList( committedPaths.stdout, paths, "committed candidate range", );',
  );
  const push = block.indexOf(
    '[ "push", capturedOriginPushUrl, `${validatedHeadSha}:refs/heads/${report.branch}`, ]',
  );
  if (
    rangeQuery <= validatedHead ||
    exactPaths <= rangeQuery ||
    push <= exactPaths ||
    block.includes(
      '[ "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD", ]',
    )
  ) {
    issues.push(
      "delivery must compare the exact full pre-commit-to-validated range path set before push",
    );
  }
  return issues;
}

function postAgentGitContextContractIssues(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const compact = compactSource(source);
  const issues: string[] = [];
  const reportType = compact.slice(
    compact.indexOf("interface RunReport {"),
    compact.indexOf("} interface RunIssue"),
  );
  for (const field of [
    "repository: string;",
    "originFetchUrl: string;",
    "originPushUrl: string;",
  ]) {
    if (!reportType.includes(field)) {
      issues.push(`RunReport missing Git remote binding: ${field}`);
    }
  }
  for (const required of [
    "requireLauncherDeliveryIdentity(runId",
    "process.env.ORCA_IMPROVEMENT_REPOSITORY",
    "process.env.ORCA_IMPROVEMENT_ORIGIN_FETCH_URL",
    "process.env.ORCA_IMPROVEMENT_ORIGIN_PUSH_URL",
  ]) {
    if (!compact.includes(required)) {
      issues.push(`preflight must retain launcher identity: ${required}`);
    }
  }

  const helperDeclarations = functionDeclarationsNamed(
    sourceFile,
    "assertBoundGitContext",
  );
  const helper = helperDeclarations[0];
  const helperText = compactSource(helper?.body?.getText(sourceFile) ?? "");
  for (const required of [
    '["rev-parse", "--abbrev-ref", "HEAD"]',
    '["rev-parse", "origin/main"]',
    '["remote", "get-url", "origin"]',
    '["remote", "get-url", "--push", "origin"]',
    "assertCurrentBranch(branch.stdout, expectedBranch);",
    "originMain.stdout.trim() !== expectedBaseSha",
    "originFetchUrl.stdout.trim() !== expectedFetchUrl",
    "originPushUrl.stdout.trim() !== expectedPushUrl",
    "return [branch, originMain, originFetchUrl, originPushUrl];",
  ]) {
    if (!helperText.includes(required)) {
      issues.push(`bound Git-context helper missing active proof: ${required}`);
    }
  }
  if (helperDeclarations.length !== 1) {
    issues.push("workflow must define one bound Git-context helper");
  }

  const calls = callsNamed(sourceFile, "assertBoundGitContext");
  const expectedCalls = [
    ["initial", "preflight", "preflight"],
    ["post-agent", "verify", "verify"],
    ["pre-push", "commit-push", "delivery"],
    ["post-push", "commit-push", "delivery"],
  ] as const;
  if (calls.length !== expectedCalls.length) {
    issues.push("initial, post-agent, pre-push, and post-push Git context must each be checked once");
  }
  for (const [index, [label, stage, budgetStage]] of expectedCalls.entries()) {
    const call = calls[index];
    let validationPush: ts.CallExpression | undefined;
    if (call !== undefined) {
      for (let parent = call.parent; parent !== undefined; parent = parent.parent) {
        if (
          ts.isCallExpression(parent) &&
          isCallAtPath(parent, ["report", "validation", "push"])
        ) {
          validationPush = parent;
          break;
        }
      }
    }
    if (
      call?.arguments.map((argument) => argument.getText(sourceFile)).join("\n") !==
        [
          JSON.stringify(label),
          "report.branch",
          "report.baseSha",
          "report.originFetchUrl",
          "report.originPushUrl",
          `() => budget(${JSON.stringify(budgetStage)})`,
        ].join("\n") ||
      call === undefined ||
      ancestorMonitorStageLabel(call) !== stage ||
      validationPush === undefined
    ) {
      issues.push(`${label} Git context must directly guard ${stage}`);
    }
  }
  return issues;
}

function requiredUsageBeforeDeliveryContractIssues(source: string): string[] {
  const compact = compactSource(source);
  const assignment = compact.indexOf(
    "report.usage = requireRecordedUsage(report.usage);",
  );
  const verifyEnd = compact.indexOf('enter("commit-push")');
  const push = compact.indexOf(
    '[ "push", capturedOriginPushUrl, `${validatedHeadSha}:refs/heads/${report.branch}`, ]',
  );
  if (
    !compact.includes("requireRecordedUsage,") ||
    assignment < 0 ||
    assignment > verifyEnd ||
    push <= assignment
  ) {
    return ["recorded backend usage must be required before delivery"];
  }
  return [];
}

function latestOpenClosureContractIssues(source: string): string[] {
  return source.includes("resolveAllOpenIssuesForProvingRun") ||
    source.includes("resolveLatestOpenIssuesForProvingRun")
    ? ["workflow must defer all issue resolution to launcher terminal commit"]
    : [];
}

function preflightDigestEvidenceContractIssues(source: string): string[] {
  const compact = compactSource(source);
  const issues: string[] = [];
  const reportType = compact.slice(
    compact.indexOf("interface RunReport {"),
    compact.indexOf("} interface RunIssue"),
  );
  for (const field of [
    "artifactDigest: string;",
    "preflightRunId: string;",
    "preflightArtifactDigest: string;",
    "preflightPath: string;",
  ]) {
    if (!reportType.includes(field)) {
      issues.push(`RunReport missing preflight attestation field: ${field}`);
    }
  }
  const initializer = compact.slice(
    compact.indexOf("const report: RunReport = {"),
    compact.indexOf("}; let candidate", compact.indexOf("const report: RunReport = {")),
  );
  for (const binding of [
    'artifactDigest: process.env.ORCA_IMPROVEMENT_ARTIFACT_DIGEST?.trim() ?? "",',
    'preflightRunId: "",',
    'preflightArtifactDigest: "",',
    'preflightPath: process.env.ORCA_IMPROVEMENT_PREFLIGHT_PATH?.trim() ?? "",',
  ]) {
    if (!initializer.includes(binding)) {
      issues.push(`report must capture launcher attestation before risky work: ${binding}`);
    }
  }
  const runId = compact.indexOf(
    'runId = requiredEnvironment("ORCA_IMPROVEMENT_RUN_ID")',
  );
  const agentWork = compact.indexOf("const selectedStageBackend = codex", runId);
  const artifact = compact.indexOf(
    'report.artifactDigest = requiredEnvironment( "ORCA_IMPROVEMENT_ARTIFACT_DIGEST", );',
    runId,
  );
  const preflightPath = compact.indexOf(
    'report.preflightPath = requiredEnvironment( "ORCA_IMPROVEMENT_PREFLIGHT_PATH", );',
    runId,
  );
  const parsed = compact.indexOf(
    "const preflight = PreflightAttestationSchema.parse(",
    runId,
  );
  const retainedRunId = compact.indexOf(
    "report.preflightRunId = preflight.runId;",
    runId,
  );
  const retained = compact.indexOf(
    "report.preflightArtifactDigest = preflight.artifactDigest;",
    runId,
  );
  const equality = compact.indexOf(
    "preflight.artifactDigest !== report.artifactDigest",
    runId,
  );
  if (
    !compact.includes(
      "artifactDigest: z.string().regex(/^[0-9a-f]{64}$/)",
    ) ||
    !compact.includes("runId: z.string().min(1)") ||
    artifact <= runId ||
    preflightPath <= artifact ||
    parsed <= preflightPath ||
    retainedRunId <= parsed ||
    retained <= retainedRunId ||
    equality <= retained ||
    agentWork <= equality ||
    compact.split("preflight.runId").length - 1 !== 1
  ) {
    issues.push(
      "preflight attestation digest must be parsed, retained, and equal before agent work",
    );
  }
  return issues;
}

test("workflow carries required lifecycle and safety controls", async () => {
  expect(await Bun.file(path).exists()).toBe(true);
  const source = await Bun.file(path).text();
  expect(source.match(/await flow\(flowArgs\(\)\)/g)?.length).toBe(1);
  for (const required of [
    'from "@twelvehart/orcats"',
    "resolveBaselinePolicy",
    "runBaselineGate",
    "WorkflowMonitor",
    "selected.shutdown?.()",
    "stageConfig(",
    "appliedSystemPrompts",
    'monitor.stage("preflight"',
    'monitor.stage("scout"',
    'monitor.stage("select-plan"',
    'monitor.stage("reproduce"',
    'monitor.stage("red-gate"',
    'monitor.stage("implement"',
    'monitor.stage("targeted-repair"',
    'monitor.stage("review"',
    'monitor.stage("review-repair"',
    'monitor.stage("verify"',
    'monitor.stage("commit-push"',
    'monitor.stage("pull-request"',
    "DeliveryRecordSchema.parse(",
    "await assertPullRequestHead(prUrl, pullRequestIdentity);",
    'report.stopReason = "active-ready";',
  ]) {
    expect(source).toContain(required);
  }
  for (const forbidden of [
    'from "neverthrow"',
    "process.argv",
    "implementTaskLoop",
    "runReviewAndFixLoop",
    "executeLoop",
    "reset --hard",
    "clean -fd",
    "force-push",
    'enter("remote-checks")',
    'enter("merge")',
  ]) {
    expect(source).not.toContain(forbidden);
  }
});

test("workflow explicitly emits progress when stderr is non-TTY", async () => {
  const source = await Bun.file(path).text();

  expect(source).toContain("createWorkflowStatusWriter,");
  expect(source).toContain("(text) => void process.stderr.write(text)");
  expect(source).toContain('label: "delivery record",');
  expect(source).toContain('label: "report",');

  const mutation = source.replace(
    "(text) => void process.stderr.write(text)",
    "(text) => process.stderr.isTTY && process.stderr.write(text)",
  );
  expect(mutation).not.toBe(source);
  expect(statusAndArtifactContractIssues(mutation)).toContain(
    "workflow progress writer must be unconditional",
  );
});

test("active delivery stops at one immutable ready pull request", async () => {
  const source = await Bun.file(path).text();
  const commit = source.indexOf('["commit", "-m", chosen.title]');
  const capture = source.indexOf(
    '["rev-parse", "HEAD"]',
    commit + 1,
  );
  const push = source.indexOf(
    "`${validatedHeadSha}:refs/heads/${report.branch}`",
    commit,
  );
  const pullRequest = source.indexOf('monitor.stage("pull-request"', push);
  const readyProof = source.indexOf(
    "await assertPullRequestHead(prUrl, pullRequestIdentity);",
    pullRequest,
  );
  const record = source.indexOf("DeliveryRecordSchema.parse(", readyProof);

  expect(commit).toBeGreaterThan(-1);
  expect(capture).toBeGreaterThan(commit);
  expect(capture).toBeLessThan(push);
  expect(push).toBeLessThan(pullRequest);
  expect(source.slice(commit, push)).toContain(
    "report.validation.push(validatedHead);",
  );
  expect(source.slice(commit, push)).toContain(
    "const validatedHeadSha = validatedHead.stdout.trim();",
  );
  expect(source).toContain(
    "if (!/^[0-9a-f]{40}$/.test(validatedHeadSha)) {",
  );
  expect(source.slice(commit, pullRequest)).toContain(
    "return validatedHeadSha;",
  );
  expect(readyProof).toBeGreaterThan(pullRequest);
  expect(readyProof).toBeLessThan(record);
  expect(source.slice(readyProof, record)).not.toContain("runRequired(");
  expect(source.slice(record)).not.toContain('enter("remote-checks")');
  expect(source.slice(record)).not.toContain('enter("merge")');
  expect(source).toContain(
    "report.matchedHeadSha = pullRequestIdentity.headSha;",
  );
  expect(
    source.match(/assertPullRequestHead\(prUrl, pullRequestIdentity\)/g)?.length,
  ).toBe(1);
});

test("active delivery rejects post-push identity drift before ready proof", async () => {
  const source = await Bun.file(path).text();
  const missingPostPush = source.replace(
    /      report\.validation\.push\(\n        \.\.\.\(await assertBoundGitContext\(\n          "post-push",[\s\S]*?      \);\n/,
    "",
  );
  expect(missingPostPush).not.toBe(source);
  expect(deliveryIdentityAndDeadlineContractIssues(missingPostPush)).toContain(
    "workflow must verify post-push Git identity",
  );

  const missingReadyProof = source.replace(
    "    await assertPullRequestHead(prUrl, pullRequestIdentity);\n",
    "",
  );
  expect(missingReadyProof).not.toBe(source);
  expect(
    missingReadyProof.indexOf("deliveryRecord = DeliveryRecordSchema.parse("),
  ).toBeGreaterThan(
    missingReadyProof.indexOf('monitor.stage("pull-request"'),
  );
  expect(missingReadyProof).not.toContain(
    "await assertPullRequestHead(prUrl, pullRequestIdentity);",
  );
});

test("delivery pushes and proves one immutable explicit remote ref", async () => {
  const source = await Bun.file(path).text();
  expect(immutablePushContractIssues(source)).toEqual([]);

  const originHead = source.replace(
    [
      '            "push",',
      "            capturedOriginPushUrl,",
      "            `${validatedHeadSha}:refs/heads/${report.branch}`,",
    ].join("\n"),
    '            "push", "origin", "HEAD",',
  );
  expect(originHead).not.toBe(source);
  expect(immutablePushContractIssues(originHead)).toContain(
    "delivery must push and prove the captured validated SHA on the explicit remote branch",
  );

  const staleRemoteProof = source.replace(
    "`${validatedHeadSha}\\trefs/heads/${report.branch}`",
    "`${report.baseSha}\\trefs/heads/${report.branch}`",
  );
  expect(staleRemoteProof).not.toBe(source);
  expect(immutablePushContractIssues(staleRemoteProof)).toContain(
    "delivery must push and prove the captured validated SHA on the explicit remote branch",
  );
});

test("active work leaves the exact finalization reserve", async () => {
  const source = await Bun.file(path).text();
  expect(source).toContain("const RUNTIME_FINALIZATION_RESERVE_MS = 60_000;");
  expect(source).toContain(
    "runtimeDeadlineMs() - RUNTIME_FINALIZATION_RESERVE_MS;",
  );
  expect(source).toContain("Date.now() >= startedAtMs + workDeadlineMs()");
  expect(source).toContain("report.elapsedMs <= runtimeDeadlineMs()");
});

test("delivery record remains bound to the validated head", async () => {
  const source = await Bun.file(path).text();
  const record = source.indexOf("deliveryRecord = DeliveryRecordSchema.parse(");
  const identity = source.indexOf("lockedHeadSha: pullRequestIdentity.headSha", record);
  expect(identity).toBeGreaterThan(record);
  expect(source.slice(record)).not.toContain("validatedHeadSha =");
});

test("delivery record publication gates active-ready success", async () => {
  const source = await Bun.file(path).text();
  const events: string[] = [];
  const publish = loadPublishActiveReadyDeliveryRecord(
    source,
    async () => {
      events.push("delivery record");
      throw new Error("delivery record write failed");
    },
  );
  expect(publish).toBeFunction();
  if (publish === undefined) return;

  await expect(
    publish(
      ".orca/improvement-loop/runs/run/delivery.json",
      "{}\n",
      "run",
      finalizationContext(() => ({ remainingMs: 1_000 })),
      () => events.push("active-ready monitor success"),
    ),
  ).rejects.toThrow("delivery record write failed");
  expect(events).toEqual(["delivery record"]);

  const published = await loadPublishActiveReadyDeliveryRecord(
    source,
    async () => {
      events.push("delivery record");
      return { remainingMs: 1_000 };
    },
  );
  expect(published).toBeFunction();
  if (published === undefined) return;
  await published(
    ".orca/improvement-loop/runs/run/delivery.json",
    "{}\n",
    "run",
    finalizationContext(() => ({ remainingMs: 1_000 })),
    () => events.push("active-ready monitor success"),
  );
  expect(events).toEqual([
    "delivery record",
    "delivery record",
    "active-ready monitor success",
  ]);
});

test("active boundary contract checker rejects ready-PR path bypasses", async () => {
  const source = await Bun.file(path).text();
  expect(activeReadyBoundaryContractIssues(source)).toEqual([]);
  const mutations = [
    {
      source: source.replace(
        "`${validatedHeadSha}\\trefs/heads/${report.branch}`",
        "`${report.baseSha}\\trefs/heads/${report.branch}`",
      ),
      issue:
        "delivery must push and prove the captured validated SHA on the explicit remote branch",
    },
    {
      source: source.replace(
        "    await assertPullRequestHead(prUrl, pullRequestIdentity);\n",
        "",
      ),
      issue: "ready PR proof must follow exact remote branch proof",
    },
    {
      source: source.replace(
        '          label: "delivery record",',
        '          label: "monitor",',
      ),
      issue: "delivery record must publish before monitor and terminal report",
    },
    {
      source: source.replace(
        'report.stopReason = "active-ready";',
        [
          'report.stopReason = "active-ready";',
          'await resolveAllOpenIssuesForProvingRun();',
          'await runRequired("gh", ["pr", "checks"], budget("delivery"));',
          'enter("merge");',
        ].join("\n"),
      ),
      issue:
        "active-ready publication must not start checks, merge, or issue closure",
    },
  ];
  for (const mutation of mutations) {
    expect(mutation.source).not.toBe(source);
    expect(activeReadyBoundaryContractIssues(mutation.source)).toContain(
      mutation.issue,
    );
  }
});

test("active filesystem deadlines bind all active I/O groups", async () => {
  const source = await Bun.file(path).text();
  expect(activeFilesystemDeadlineContractIssues(source)).toEqual([]);
});

const activeFilesystemWrapperLabels = [
  "preflight attestation read",
  "workflow config read",
  "reproduced test read",
  "RED diff write",
  "rejected candidate artifact write",
  "rejected restoration artifact write",
  "accepted plan write",
  "PR body write",
  "test snapshot existence check",
  "test snapshot read",
  "test snapshot write",
] as const;

for (const wrapperLabel of activeFilesystemWrapperLabels) {
  for (const mutationKind of ["remove", "infinite"] as const) {
    test(`active filesystem deadline detects ${mutationKind} ${wrapperLabel}`, async () => {
      const source = await Bun.file(path).text();
      const mutation = mutateDeadlineWrapper(
        source,
        wrapperLabel,
        mutationKind,
      );
      expect(mutation === source).toBe(false);
      expect(activeFilesystemDeadlineContractIssues(mutation)).not.toEqual([]);
    });
  }
}

test("active filesystem deadline detects a dropped outer await", async () => {
  const source = await Bun.file(path).text();
  const mutation = mutateDeadlineWrapper(
    source,
    "preflight attestation read",
    "drop-await",
  );
  expect(mutation === source).toBe(false);
  expect(activeFilesystemDeadlineContractIssues(mutation)).not.toEqual([]);
});

test("effective timing keeps active stage and global deadline enforcement", async () => {
  const source = await Bun.file(path).text();
  expect(effectiveTimingContractIssues(source)).toEqual([]);

  const budgetMutation = source.replace(
    /  const budget = \(name: StageLimit\): number => \{[\s\S]*?\n  \};\n  const buildRunIssue/,
    [
      "  const budget = (name: StageLimit): number => stageLimit(name);",
      "  const buildRunIssue",
    ].join("\n"),
  );
  expect(budgetMutation).not.toBe(source);
  expect(effectiveTimingContractIssues(budgetMutation)).toContain(
    "budget must directly combine active and global remainders",
  );

  const slaMutation = source.replace(
    [
      "          report.sla =",
      "            !bodyFailed &&",
      '            report.stage !== "finalize" &&',
      "            deliveryRecordPublished &&",
      '            report.activeStatus === "ready" &&',
      "            report.elapsedMs <= runtimeDeadlineMs() &&",
      "            remainingAtReport > 0",
      '              ? "passed"',
      '              : "failed";',
    ].join("\n"),
    '          report.sla = "passed";',
  );
  expect(slaMutation).not.toBe(source);
  expect(effectiveTimingContractIssues(slaMutation)).toContain(
    "final SLA must be assigned during bounded finalization and reject deadline overrun",
  );

  const overlapMutation = source.replace(
    '      beginBudget("repairs");\n      const outcome = await withStableIgnoredOrcaGuard("review-repair"',
    '      const outcome = await withStableIgnoredOrcaGuard("review-repair"',
  );
  expect(overlapMutation).not.toBe(source);
  expect(effectiveTimingContractIssues(overlapMutation)).toContain(
    "review repair must switch active repair and review budgets",
  );
});

test("every post-turn git probe consumes its active and global remainder", async () => {
  const source = await Bun.file(path).text();
  expect(stageRemainderContractIssues(source)).toEqual([]);

  const omitted = source.replace(
    'await pathDiff(chosen.testPath, () => budget("implement"))',
    "await pathDiff(chosen.testPath)",
  );
  expect(omitted).not.toBe(source);
  expect(stageRemainderContractIssues(omitted)).toContain(
    "pathDiff call 3 must use implement remainder",
  );

  const wrongStage = source.replace(
    'await changedPaths(() => budget("verify"))',
    'await changedPaths(() => budget("delivery"))',
  );
  expect(wrongStage).not.toBe(source);
  expect(stageRemainderContractIssues(wrongStage)).toContain(
    "changedPaths call 10 must use verify remainder",
  );

  const defaulted = source.replace(
    "async function changedPaths(\n  remaining: () => number,",
    "async function changedPaths(\n  remaining: () => number = () => 30_000,",
  );
  expect(defaulted).not.toBe(source);
  expect(stageRemainderContractIssues(defaulted)).toContain(
    "changedPaths must require one explicit remainder callback",
  );
});

test("every autonomous node uses its exact configured directive", async () => {
  const source = await Bun.file(path).text();
  expect(directiveWiringContractIssues(source)).toEqual([]);

  const wrongConfig = source.replace(
    "config: selectedStageConfig(implementConfig),",
    "config: selectedStageConfig(repairConfig),",
  );
  expect(wrongConfig).not.toBe(source);
  expect(directiveWiringContractIssues(wrongConfig)).toContain(
    "autonomous stage 5 must use implementConfig",
  );

  const wrongMode = source.replace(
    'stageConfig("review", config.stages.review, true)',
    'stageConfig("review", config.stages.review, false)',
  );
  expect(wrongMode).not.toBe(source);
  expect(directiveWiringContractIssues(wrongMode)).toContain(
    "reviewConfig must bind its exact stage directive and access mode",
  );
});

test("targeted test, lint, and full verify gates are load-bearing", async () => {
  const source = await Bun.file(path).text();
  expect(verificationGateContractIssues(source)).toEqual([]);

  const noLint = source.replace(
    '    runLogged("bun", ["run", "lint"], timeoutMs),\n',
    "",
  );
  expect(noLint).not.toBe(source);
  expect(verificationGateContractIssues(noLint)).toContain(
    "targeted gate must directly run exactly test and lint",
  );

  const wrongVerify = source.replace(
    'args: ["run", "verify"],',
    'args: ["test"],',
  );
  expect(wrongVerify).not.toBe(source);
  expect(verificationGateContractIssues(wrongVerify)).toContain(
    "full gate must be exactly bun run verify",
  );
});

test("branch and ready-PR evidence bind before active success", async () => {
  const source = await Bun.file(path).text();
  expect(branchContextContractIssues(source)).toEqual([]);
  const readyProof = source.indexOf(
    "await assertPullRequestHead(prUrl, pullRequestIdentity);",
  );
  const record = source.indexOf("DeliveryRecordSchema.parse(", readyProof);
  expect(readyProof).toBeGreaterThan(-1);
  expect(record).toBeGreaterThan(readyProof);
  expect(source.slice(record)).not.toContain('monitor.stage("remote-checks"');
  expect(source.slice(record)).not.toContain('monitor.stage("merge"');

  const emptyBranch = source.replace(
    'branch: process.env.ORCA_IMPROVEMENT_BRANCH?.trim() ?? ""',
    'branch: ""',
  );
  expect(emptyBranch).not.toBe(source);
  expect(branchContextContractIssues(emptyBranch)).toContain(
    "report must capture launcher branch before risky work",
  );
});

test("active-ready boundary removes legacy merge and check execution", async () => {
  const source = await Bun.file(path).text();
  for (const obsolete of [
    "function readRemoteChecks(",
    "function assertMergeProtectionBounded(",
    "function mergePullRequestBounded(",
    '"pr",\n      "merge",',
  ]) {
    expect(source).not.toContain(obsolete);
  }
});

test("backend guards run before workflow initialization side effects", async () => {
  const source = await Bun.file(path).text();
  expect(earlyBackendGuardContractIssues(source)).toEqual([]);

  const rawGuardBypass = source.replace(
    '  if (requestedBackend !== "codex") {',
    "  if (false) {",
  );
  expect(rawGuardBypass).not.toBe(source);
  expect(earlyBackendGuardContractIssues(rawGuardBypass).length).toBeGreaterThan(
    0,
  );

  const selectedGuardBypass = source.replace(
    '  if (activeSelected.tag !== "codex") {',
    "  if (false) {",
  );
  expect(selectedGuardBypass).not.toBe(source);
  expect(
    earlyBackendGuardContractIssues(selectedGuardBypass).length,
  ).toBeGreaterThan(0);

  const earlyClock = source
    .replace(
      '  const startedAtMs = parseStartedAt(\n    requiredEnvironment("ORCA_IMPROVEMENT_STARTED_AT_MS"),\n  );\n',
      "",
    )
    .replace(
      "  const requestedBackend =",
      '  const startedAtMs = parseStartedAt(\n    requiredEnvironment("ORCA_IMPROVEMENT_STARTED_AT_MS"),\n  );\n  const requestedBackend =',
    );
  expect(earlyClock).not.toBe(source);
  expect(earlyBackendGuardContractIssues(earlyClock).length).toBeGreaterThan(0);

  const earlyFilesystem = source.replace(
    "  const requestedBackend =",
    "  void fs();\n  const requestedBackend =",
  );
  expect(earlyFilesystem).not.toBe(source);
  expect(
    earlyBackendGuardContractIssues(earlyFilesystem).length,
  ).toBeGreaterThan(0);
});

test("runtime backend overrides use non-spending readiness probes", async () => {
  const source = await Bun.file(path).text();
  for (const required of [
    'codex: { command: "codex", args: ["login", "status"] }',
    'opencode: { command: "opencode", args: ["auth", "list"] }',
    'claude: { command: "claude", args: ["--version"] }',
    'pi: { command: "pi", args: ["--version"] }',
    "BACKEND_READINESS[selected.tag]",
  ]) {
    expect(source).toContain(required);
  }
  expect(source).not.toContain("preflight requires codex backend");
});

test("autonomous stages pin Codex and ignore user configuration", async () => {
  const source = await Bun.file(path).text();
  expect(source).toContain("codex,");
  expect(source).toContain(
    'if (activeSelected.tag !== "codex") {',
  );
  expect(source).toContain(
    "const selectedStageBackend = codex({ ignoreUserConfig: true });",
  );
  expect(source).not.toContain("const selectedStageBackend = activeSelected.backend");
  const inspection = inspectAutonomousStages(source);
  expect(inspection.callCount).toBe(EXPECTED_AUTONOMOUS_STAGE_CALLS);
  expect(inspection.firstArguments).toEqual(
    Array.from(
      { length: EXPECTED_AUTONOMOUS_STAGE_CALLS },
      () => "selectedStageBackend",
    ),
  );
  expect(inspection.aliasKinds).toEqual([]);
  expect(autonomousStageContractIssues(source)).toEqual([]);
});

test("AST contract catches a formatted receiver alias bypass missed by literals", async () => {
  const source = await Bun.file(path).text();
  const bypass = source.replace(
    "const conversation = llm().autonomous(selectedStageBackend, {",
    [
      "const stageTool = llm();",
      "            const conversation = stageTool",
      "        .autonomous(",
      "          activeSelected.backend,",
      "          {",
    ].join("\n"),
  );
  expect(bypass).not.toBe(source);
  const autonomousCalls = bypass.match(/llm\(\)\.autonomous\(/g) ?? [];
  const selectedStageCalls =
    bypass.match(/llm\(\)\.autonomous\(selectedStageBackend,/g) ?? [];
  const literalGuardAccepted =
    autonomousCalls.length > 0 &&
    selectedStageCalls.length === autonomousCalls.length &&
    !bypass.includes("llm().autonomous(activeSelected.backend") &&
    !bypass.includes("llm().autonomous(selected.backend");
  expect(literalGuardAccepted).toBe(true);
  const inspection = inspectAutonomousStages(bypass);
  expect(inspection.callCount).toBe(EXPECTED_AUTONOMOUS_STAGE_CALLS);
  expect(inspection.firstArguments).toContain("activeSelected.backend");
  expect(
    autonomousStageContractIssues(bypass).some((issue) =>
      issue.includes("received activeSelected.backend"),
    ),
  ).toBe(true);
});

test("AST contract rejects one direct autonomous-stage backend replacement", async () => {
  const source = await Bun.file(path).text();
  const bypass = source.replace(
    "llm().autonomous(selectedStageBackend, {",
    "llm().autonomous(activeSelected.backend, {",
  );
  expect(bypass).not.toBe(source);
  expect(inspectAutonomousStages(bypass).callCount).toBe(
    EXPECTED_AUTONOMOUS_STAGE_CALLS,
  );
  expect(autonomousStageContractIssues(bypass)).toContain(
    "autonomous stage 1 backend must be selectedStageBackend; received activeSelected.backend",
  );
});

test("AST contract forbids destructured autonomous aliases", async () => {
  const source = await Bun.file(path).text();
  const bypass = source.replace(
    "const conversation = llm().autonomous(selectedStageBackend, {",
    [
      "const { autonomous: runAutonomous } = llm();",
      "            const conversation = runAutonomous(selectedStageBackend, {",
    ].join("\n"),
  );
  expect(bypass).not.toBe(source);
  expect(autonomousStageContractIssues(bypass)).toContain(
    "autonomous alias shape forbidden: destructured",
  );
});

test("profile and serial operations honor remaining budgets", async () => {
  const source = await Bun.file(path).text();
  expect(source).toContain(
    'if (values.length === 0 && unsupported.length === 0) return "simple";',
  );
  expect(source).toContain(
    'commandTool: budgetedCommandTool(() => budget("preflight"))',
  );
  expect(source).toContain("createPullRequestBounded(");
  expect(source).not.toContain("gh().createPullRequest");
});

test("simple stage limits carry every exact value and the 560-second total", async () => {
  const source = await Bun.file(path).text();
  const inspection = inspectSimpleStageLimits(source);
  for (const [name, expected] of Object.entries(
    EXPECTED_SIMPLE_STAGE_LIMITS,
  )) {
    expect(inspection.values[name]).toBe(expected);
  }
  expect(Object.keys(inspection.values).sort()).toEqual(
    Object.keys(EXPECTED_SIMPLE_STAGE_LIMITS).sort(),
  );
  expect(inspection.total).toBe(EXPECTED_SIMPLE_STAGE_TOTAL);
  expect(simpleStageLimitContractIssues(source)).toEqual([]);
});

test("profile scaling and fallback-control time remain exact", async () => {
  const source = await Bun.file(path).text();
  expect(
    numericObjectLiteralContractIssues(
      source,
      "PROFILE_SCALE",
      EXPECTED_PROFILE_SCALE,
    ),
  ).toEqual([]);
  expect(scoutNumericConstantContractIssues(source)).toEqual([]);
  expect(fallbackControlBudgetContractIssues(source)).toEqual([]);

  const scaleMutation = source.replace("medium: 2,", "medium: 3,");
  expect(scaleMutation).not.toBe(source);
  expect(
    numericObjectLiteralContractIssues(
      scaleMutation,
      "PROFILE_SCALE",
      EXPECTED_PROFILE_SCALE,
    ),
  ).toContain("PROFILE_SCALE.medium must be 2; received 3");

  const controlMutation = source.replace(
    "const FALLBACK_CONTROL_LIMIT_MS = 10_000;",
    "const FALLBACK_CONTROL_LIMIT_MS = 20_000;",
  );
  expect(controlMutation).not.toBe(source);
  expect(scoutNumericConstantContractIssues(controlMutation)).toContain(
    "FALLBACK_CONTROL_LIMIT_MS must be 10000; received 20000",
  );

  const callsiteMutation = source.replace(
    "FALLBACK_CONTROL_LIMIT_MS,\n                budget(\"reproduce\"),",
    "20_000,\n                budget(\"reproduce\"),",
  );
  expect(callsiteMutation).not.toBe(source);
  expect(fallbackControlBudgetContractIssues(callsiteMutation)).toContain(
    "fallback control must use its exact cap inside the shared reproduce budget",
  );
});

test("scout split limits and evidence caps are direct exact constants", async () => {
  const source = await Bun.file(path).text();
  expect(scoutNumericConstantContractIssues(source)).toEqual([]);
});

test("scout gather is bounded, logged, hashed, and worktree-immutable", async () => {
  const source = await Bun.file(path).text();
  for (const required of [
    "const gatherDeadlineMs = Date.now() + SCOUT_GATHER_LIMIT_MS;",
    "const statusBefore = await gatherRequired",
    "const statusAfter = await gatherRequired",
    "selection.sourceTestPairs,",
    "createHash(\"sha256\").update(evidence.text).digest(\"hex\")",
  ]) {
    expect(source).toContain(required);
  }

  const missingSharedDeadline = source.replace(
    "Date.now() + SCOUT_GATHER_LIMIT_MS",
    "Date.now() + 15_000",
  );
  expect(missingSharedDeadline).not.toBe(source);
  expect(missingSharedDeadline).not.toContain(
    "Date.now() + SCOUT_GATHER_LIMIT_MS",
  );
});

test("scout gather preserves pair metadata through rendering and reporting", async () => {
  const source = await Bun.file(path).text();
  const unpairedRender = source.replace(
    "        latestCommitEvidencePrefix(latestCommit.stdout),\n        selection.sourceTestPairs,",
    "        latestCommitEvidencePrefix(latestCommit.stdout),",
  );
  expect(unpairedRender).not.toBe(source);
  expect(scoutGatherContractIssues(unpairedRender)).toContain(
    "renderScoutEvidence must receive cap, prefix, and source-test pairs",
  );

  const unreported = source.replace(
    /      report\.scoutEvidence\.sourceTestPairs = evidence\.sourceTestPairs\.map\([\s\S]*?      \);\n/,
    "",
  );
  expect(unreported).not.toBe(source);
  expect(scoutGatherContractIssues(unreported)).toContain(
    "run report must persist rendered source-test pairs",
  );
});

test("scout synthesis is one watched tool-free ranked callsite", async () => {
  const source = await Bun.file(path).text();
  const runtimeSource = await Bun.file(runtimePath).text();
  expect(source).toContain("runScopedScoutFanout<ScopedScoutResult>({");
  expect(source).toContain("finalizeScopedScoutRecords({");
  expect(source).toContain("schema: ScopedScoutResultSchema,");
  expect(source).toContain("awaitToolFreeOutcome(activeConversation");
  expect(source).not.toContain("awaitOneTimeoutRetry(");
  expect(runtimeSource).toContain("export async function runScopedScoutFanout");
});

test("scout validation starts before shared fanout finalization", async () => {
  const source = await Bun.file(path).text();
  const deadline =
    "const validationDeadlineMs = Date.now() + SCOUT_VALIDATION_LIMIT_MS;";
  expect(source).toContain(deadline);
  expect(source.indexOf(deadline)).toBeGreaterThan(
    source.indexOf("const fanout = await runScopedScoutFanout<ScopedScoutResult>({"),
  );
  expect(source.indexOf(deadline)).toBeLessThan(
    source.indexOf("const scopedResult = await finalizeScopedScoutRecords({"),
  );
  expect(source).toContain("awaitWithinDeadline(\n          `candidate ${proposed.id} tracked paths`");
  expect(source).toContain("validationRemaining(),");
  const removedDeadline = source.replace(deadline, "");
  expect(removedDeadline).not.toBe(source);
  expect(removedDeadline).not.toContain(deadline);
});

test("scout hashes and rechecks every ordered pair packet before fanout", async () => {
  const source = await Bun.file(path).text();
  const packetDeclaration = "const scopedPackets: ScoutEvidencePacket[] = [];";
  const packetDigest = "if (!/^[0-9a-f]{64}$/.test(packet.sha256)) {";
  expect(source).toContain(packetDeclaration);
  expect(source).toContain(packetDigest);
  expect(source.indexOf(packetDigest)).toBeLessThan(
    source.indexOf("const fanout = await runScopedScoutFanout<ScopedScoutResult>({"),
  );
});

test("scout records terminal usage only through pair-ordered finalization", async () => {
  const source = await Bun.file(path).text();
  const fanout = source.indexOf("const fanout = await runScopedScoutFanout<ScopedScoutResult>({");
  const finalization = source.indexOf("const scopedResult = await finalizeScopedScoutRecords({");
  const validation = source.indexOf(
    "const validationDeadlineMs = Date.now() + SCOUT_VALIDATION_LIMIT_MS;",
  );
  expect(fanout).toBeGreaterThan(-1);
  expect(finalization).toBeGreaterThan(fanout);
  expect(validation).toBeGreaterThan(fanout);
  expect(validation).toBeLessThan(finalization);
  expect(source.slice(0, fanout)).toContain(
    "const scopedUsage = new Map<number, Usage | undefined>();",
  );
  expect(source.slice(fanout, finalization)).toContain(
    "scopedUsage.set(scopeIndex, outcome.result.usage);",
  );
  expect(source.slice(fanout, finalization)).not.toContain(
    "recordUsage(outcome.result.usage);",
  );
  expect(source.slice(validation, finalization + 2_500)).toContain(
    "recordTerminalUsage: (record) => {\n          recordUsage(scopedUsage.get(record.scopeIndex));\n        },",
  );
});

test("scout alone uses low Codex reasoning with whole-result rank-one control", async () => {
  const source = await Bun.file(path).text();
  expect(source).toContain('reasoningEffort: "low" as const');
  expect(source).toContain("scopedScoutPrompt(profile, profileLimits[profile], packet.text, pair)");
  expect(source).toContain("quorum: 3,");
  expect(source).toContain("accept: (value) => value.status === \"candidate\",");
});

test("scout reasoning contract rejects low-to-medium mutation", async () => {
  const source = await Bun.file(path).text();
  const mutation = source.replace(
    'reasoningEffort: "low"',
    'reasoningEffort: "medium"',
  );
  expect(mutation).not.toBe(source);
  expect(scoutReasoningConfigContractIssues(mutation)).toContain(
    "scoutConfig reasoningEffort must be low",
  );
});

test("scout fanout uses one shared allocation and settlement reserve", async () => {
  const source = await Bun.file(path).text();
  for (const required of [
    "modelAllocationMs: SCOUT_MODEL_LIMIT_MS,",
    "settlementReserveMs: CONVERSATION_SETTLEMENT_RESERVE_MS,",
    "quorum: 3,",
    "recordReportSummary:",
    "recordLedgerSummary:",
  ]) {
    expect(source).toContain(required);
  }
});

test("reproduce completes only on the applied expected file change", async () => {
  const source = await Bun.file(path).text();
  expect(reproduceEventContractIssues(source)).toEqual([]);

  const bypass = source.replace(
    "!hasConfirmedExpectedFileChange(\n                reproduceResult.expectedFileChangeState,\n                paths,\n                chosen.testPath,\n              )",
    "paths.length === 0",
  );
  expect(bypass).not.toBe(source);
  expect(reproduceEventContractIssues(bypass)).not.toEqual([]);

  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const proof = callsNamed(
    sourceFile,
    "hasConfirmedExpectedFileChange",
  )[0];
  const guard = proof?.parent.parent;
  if (guard === undefined || !ts.isIfStatement(guard)) {
    throw new Error("terminal/event proof guard missing from valid source");
  }
  const bodyless =
    source.slice(0, guard.thenStatement.getStart(sourceFile)) +
    "{}" +
    source.slice(guard.thenStatement.end);
  expect(bodyless).not.toBe(source);
  expect(reproduceEventContractIssues(bodyless)).not.toEqual([]);

  const inaccurate = source.replace(
    "did not provide confirmed change evidence",
    "did not apply a net change",
  );
  expect(inaccurate).not.toBe(source);
  expect(reproduceEventContractIssues(inaccurate)).not.toEqual([]);
});

test("ranked reproduction owns fallback, evidence, restore, and lazy control", async () => {
  const source = await Bun.file(path).text();
  expect(source).toContain("runRankedCandidateFallback(");
  expect(source).toContain("assertCandidateFitsActiveProfile(chosen, profile);");
  expect(source).toContain("report.scoutEvidence.splitReason = error.reason;");
  expect(source).toContain("const snapshot = await captureExactTestSnapshot(");
  expect(source).toContain("await restoreExactTestSnapshot(");
});

test("ranked restoration rejects a catch-local post-edit snapshot", async () => {
  const source = await Bun.file(path).text();
  const mutation = source.replace(
    "            const reason = normalizeFailure(error);",
    [
      "            const reason = normalizeFailure(error);",
      "            const snapshot = await captureExactTestSnapshot(",
      "              chosen.testPath,",
      '              () => budget("reproduce"),',
      "            );",
    ].join("\n"),
  );
  expect(mutation).not.toBe(source);
  expect(rankedReproductionContractIssues(mutation)).toContain(
    "ranked rejection must capture one uniquely bound pre-edit snapshot",
  );
});

test("ranked reproduction contract rejects ownership bypasses", () => {
  const valid = [
    "interface RejectedCandidateEvidence {",
    "  candidate: Candidate;",
    '  control: ScoutResult["selectedControl"];',
    "  reason: string;",
    "  redDiff: string;",
    "  validation: CommandLog[];",
    "  snapshotSha256: string;",
    "}",
    "interface RunReport {",
    "  rejectedCandidates: RejectedCandidateEvidence[];",
    "}",
    "async function run() {",
    '  const latestCommit = await gatherRequired("git", ["show", "--format=Latest commit: %H%nSubject: %s", "--name-only", "--first-parent", "HEAD"]);',
    "  const evidence = renderScoutEvidence(packet, SCOUT_EVIDENCE_MAX_CHARS, latestCommitEvidencePrefix(latestCommit.stdout));",
    "  if (structured.data.candidateId !== candidateId) throw new Error();",
    "  return runRankedCandidateFallback(",
    "    scoutResult.rankedCandidateIds,",
    "    async (candidateId) => {",
    "      const control =",
    "        candidateId === scoutResult.selectedControl.candidateId",
    "          ? scoutResult.selectedControl",
    "          : await resolveFallbackControl(candidateId);",
    "      const attempted = hydrateCandidate(scoutResult, control);",
    '      budget("reproduce");',
    "      const snapshot = await captureExactTestSnapshot(attempted.testPath);",
    "      try {",
    "        await mutateTest();",
    "        return { status: \"accepted\", value: attempted };",
    "      } catch (error) {",
    "        if (!isInvalidReproductionProof(error)) throw error;",
    "        report.rejectedCandidates.push({",
    "          candidate: attempted,",
    "          control: control,",
    "          reason: String(error),",
    "          redDiff: capturedTestDiff,",
    "          validation: [...report.validation.slice(validationStart)],",
    "          snapshotSha256: snapshotSha256,",
    "        });",
    "        return {",
    "          status: \"rejected\",",
    "          reason: String(error),",
    "          restore: async () => {",
    "            const restoration = await restoreExactTestSnapshot(attempted.testPath, snapshot);",
    "            void restoration;",
    "          },",
    "        };",
    "      }",
    "    },",
    "  );",
    "}",
  ].join("\n");
  expect(rankedReproductionContractIssues(valid)).toEqual([]);

  for (const mutation of [
    valid.replace("scoutResult.rankedCandidateIds", "[scoutResult.rankedCandidateIds[0]]"),
    valid.replace(": await resolveFallbackControl(candidateId)", ": scoutResult.selectedControl"),
    valid.replace("await restoreExactTestSnapshot(attempted.testPath, snapshot);", "return;"),
    valid.replace(
      "await restoreExactTestSnapshot(attempted.testPath, snapshot);",
      "await restoreExactTestSnapshot(attempted.testPath, await captureExactTestSnapshot(attempted.testPath));",
    ),
    valid.replace(
      "      const snapshot = await captureExactTestSnapshot(attempted.testPath);\n      try {\n        await mutateTest();",
      "      try {\n        await mutateTest();\n        const snapshot = await captureExactTestSnapshot(attempted.testPath);",
    ),
    valid.replace("if (!isInvalidReproductionProof(error)) throw error;", "if (false) throw error;"),
    valid.replace('const latestCommit = await gatherRequired("git", ["show", "--format=Latest commit: %H%nSubject: %s", "--name-only", "--first-parent", "HEAD"]);', 'const latestCommit = await gatherRequired("git", ["status"]);'),
  ]) {
    expect(mutation).not.toBe(valid);
    expect(rankedReproductionContractIssues(mutation)).not.toEqual([]);
  }
});

test("accepted candidate state binds only after genuine ranked red proof", async () => {
  const source = await Bun.file(path).text();
  const redGate = source.indexOf('monitor.stage("red-gate"');
  const candidateAssignment = source.indexOf(
    "candidate = reproduction.value.candidate;",
  );
  const diffAssignment = source.indexOf(
    "capturedTestDiff = reproduction.value.redDiff;",
  );
  const reportAssignment = source.indexOf("report.candidate = candidate;");
  const redPathAssignment = source.indexOf(
    "report.redDiffPath = RED_DIFF_PATH;",
  );
  const planWrite = source.indexOf("await writeJson(PLAN_PATH");

  expect(redGate).toBeGreaterThan(-1);
  expect(candidateAssignment).toBeGreaterThan(redGate);
  expect(diffAssignment).toBeGreaterThan(redGate);
  expect(reportAssignment).toBeGreaterThan(candidateAssignment);
  expect(redPathAssignment).toBeGreaterThan(reportAssignment);
  expect(planWrite).toBeGreaterThan(redPathAssignment);
  expect(source.match(/candidate = reproduction\.value\.candidate;/g)).toHaveLength(1);
  expect(source.match(/report\.candidate = candidate;/g)).toHaveLength(1);
  expect(source.match(/await writeJson\(PLAN_PATH/g)).toHaveLength(1);
});

test("ranked rejection delegates exact snapshot and restore on shared budget", async () => {
  const source = await Bun.file(path).text();
  for (const required of [
    "  captureExactFileSnapshot,",
    "  restoreExactFileSnapshot,",
    "return await captureExactFileSnapshot(",
    "return await restoreExactFileSnapshot(",
    "exactSnapshotOperations(remaining)",
    '"test snapshot existence check"',
    '"test snapshot read"',
    '"test snapshot write"',
    '["status", "--porcelain=v1", "--untracked-files=all"]',
    '["diff", "--no-ext-diff", "--binary", "HEAD", "--"]',
    "const snapshot = await captureExactTestSnapshot(",
    "const restoration = await restoreExactTestSnapshot(",
    '() => budget("reproduce")',
    '"rejected candidate artifact write"',
    '"rejected restoration artifact write"',
  ]) {
    expect(source).toContain(required);
  }
  for (const removed of [
    "red diff persistence",
    "rejected candidate persistence",
    "rejected restoration persistence",
  ]) {
    expect(source).not.toContain(
      `assertRemainingBudget(budget("reproduce"), "${removed}")`,
    );
  }

  expect(rejectedArtifactBudgetContractIssues(source)).toEqual([]);

  const reassociated = source.replace(
    '"rejected restoration artifact write"',
    '"rejected candidate artifact write"',
  );
  expect(reassociated).not.toBe(source);
  expect(rejectedArtifactBudgetContractIssues(reassociated)).not.toEqual([]);
});

test("reproduce prompt requires the exact same-path positive control", async () => {
  const source = await Bun.file(path).text();
  expect(reproducePromptContractIssues(source)).toEqual([]);
});

test("reproduce prompt rejects required controls preserved only in dead code", async () => {
  const source = await Bun.file(path).text();
  const declaration = "function reproducePrompt(candidate: Candidate): string {\n";
  for (const snippet of REQUIRED_REPRODUCE_PROMPT_SNIPPETS) {
    const weakened = source.replace(`    ${snippet},\n`, "");
    const mutation = weakened.replace(
      declaration,
      `${declaration}  const unusedDirective = ${snippet};\n`,
    );
    expect(weakened).not.toBe(source);
    expect(mutation).not.toBe(weakened);
    expect(reproducePromptContractIssues(mutation)).toContain(
      `reproducePrompt missing control contract: ${snippet}`,
    );
  }
});

test("red gate runs and logs control before red, then validates before persisting", async () => {
  const source = await Bun.file(path).text();
  expect(redGateContractIssues(source)).toEqual([]);
});

test("baseline positive control dominates reproduce-agent execution", async () => {
  const source = await Bun.file(path).text();
  expect(baselinePositiveControlContractIssues(source)).toEqual([]);
  expect(semanticControlPreservationContractIssues(source)).toEqual([]);

  const hiddenAssertion = source.replace(
    "            assertPositiveControlEvidence(",
    "            if (false) assertPositiveControlEvidence(",
  );
  expect(hiddenAssertion).not.toBe(source);
  expect(baselinePositiveControlContractIssues(hiddenAssertion)).toContain(
    "logged exact-name baseline positive control must directly dominate reproduce agent execution",
  );

  const droppedBaseline = source.replace(
    "              controlSource,\n              baselineTestSource,",
    "              controlSource,",
  );
  expect(droppedBaseline).not.toBe(source);
  expect(semanticControlPreservationContractIssues(droppedBaseline)).toContain(
    "post-reproduce semantic evidence must compare the full baseline source",
  );

  const lossyBaselineDecode = source.replace(
    "decodeUtf8Source(snapshot.bytes, chosen.testPath)",
    "new TextDecoder().decode(snapshot.bytes)",
  );
  expect(lossyBaselineDecode).not.toBe(source);
  expect(
    semanticControlPreservationContractIssues(lossyBaselineDecode),
  ).toContain(
    "reproduce must retain the complete baseline test source losslessly",
  );

  const lossyCandidateDecode = source.replace(
    "async () => await readFile(chosen.testPath),",
    'async () => await readFile(chosen.testPath, "utf8"),',
  );
  expect(lossyCandidateDecode).not.toBe(source);
  expect(
    semanticControlPreservationContractIssues(lossyCandidateDecode),
  ).toContain("reproduce must decode candidate test bytes losslessly");

  const droppedMarker = source.replace(
    "      candidateRedMarker: candidateRedMarker(candidate.id),\n",
    "",
  );
  expect(droppedMarker).not.toBe(source);
  expect(semanticControlPreservationContractIssues(droppedMarker)).toContain(
    "semantic helper must bind the exact candidate RED marker",
  );

  const droppedTargetName = source.replace(
    [
      "            const candidateRedTestName =",
      "              semanticControlEvidence.candidateRedTestName;",
      "",
    ].join("\n"),
    "",
  );
  expect(droppedTargetName).not.toBe(source);
  expect(
    semanticControlPreservationContractIssues(droppedTargetName),
  ).toContain(
    "post-reproduce semantic evidence must immediately capture candidate RED test name",
  );

  const droppedMissingNameGuard = source.replace(
    [
      "            if (candidateRedTestName === undefined) {",
      "              throw new InvalidReproductionProofError(",
      '                "target-wrong-pattern",',
      '                `semantic reproduction proof did not identify the added RED test for ${chosen.id}`,',
      "              );",
      "            }",
    ].join("\n"),
    "",
  );
  expect(droppedMissingNameGuard).not.toBe(source);
  expect(
    semanticControlPreservationContractIssues(droppedMissingNameGuard),
  ).toContain(
    "post-reproduce semantic evidence must fail closed when candidate RED test name is missing",
  );
});

test("semantic causality rejects generic expression descendant fallback", async () => {
  const source = await Bun.file(runtimePath).text();
  expect(semanticCausalityRuntimeContractIssues(source)).toEqual([]);

  const mutation = source.replace(
    "  return UNTAINTED_PRODUCTION_STATE;\n}\n\nfunction directProductionCallOrigin",
    [
      "  let found: SemanticProductionState = UNTAINTED_PRODUCTION_STATE;",
      "  ts.forEachChild(node, (child) => {",
      "    const childState = expressionProductionState(",
      "      child, states, bindings, checker,",
      "    );",
      '    if (childState.kind === "exact") found = childState;',
      "  });",
      "  return found;",
      "}",
      "",
      "function directProductionCallOrigin",
    ].join("\n"),
  );
  expect(mutation).not.toBe(source);
  expect(semanticCausalityRuntimeContractIssues(mutation)).toContain(
    "production causality may not use generic descendant scanning",
  );
});

test("semantic proof commands install the frozen matcher preload", async () => {
  const source = await Bun.file(path).text();
  expect(matcherProofPreloadContractIssues(source)).toEqual([]);

  const mutations = [
    source.replace("  matcherProofArgs,\n", ""),
    source.replace(
      '    await writeMatcherProofPreload(() => budget("reproduce"));',
      '    if (false) await writeMatcherProofPreload(() => budget("reproduce"));',
    ),
    source.replace(
      '    enter("reproduce");\n    beginBudget("reproduce");',
      [
        '    await runTargetedGate(scoutResult.candidates[0]!, budget("scout"));',
        '    enter("reproduce");',
        '    beginBudget("reproduce");',
      ].join("\n"),
    ),
    source.replace(
      '    enter("reproduce");\n    beginBudget("reproduce");',
      [
        '    await runTargetedGate(',
        '      scoutResult.candidates[0]!,',
        '      budget("reproduce"),',
        '    );',
        '    enter("reproduce");',
        '    beginBudget("reproduce");',
      ].join("\n"),
    ),
    source.replace(
      '    enter("reproduce");\n    beginBudget("reproduce");',
      [
        "    const earlyTargetedGate = runTargetedGate;",
        '    await earlyTargetedGate(scoutResult.candidates[0]!, budget("scout"));',
        '    enter("reproduce");',
        '    beginBudget("reproduce");',
      ].join("\n"),
    ),
    (() => {
      const earlyCall = source.replace(
        '    enter("reproduce");\n    beginBudget("reproduce");',
        [
          "    await earlyTargetedGate(scoutResult.candidates[0]!);",
          '    enter("reproduce");',
          '    beginBudget("reproduce");',
        ].join("\n"),
      );
      return earlyCall.replace(
        "function parseJson(value: string, source: string): unknown {",
        [
          "async function earlyTargetedGate(",
          "  candidate: Candidate,",
          "): Promise<CommandLog[]> {",
          "  return await runTargetedGate(candidate, 1);",
          "}",
          "",
          "function parseJson(value: string, source: string): unknown {",
        ].join("\n"),
      );
    })(),
    source.replace(
      "  if (!written.equals(Buffer.from(MATCHER_PROOF_PRELOAD_SOURCE, \"utf8\"))) {",
      "  if (false && !written.equals(Buffer.from(MATCHER_PROOF_PRELOAD_SOURCE, \"utf8\"))) {",
    ),
    source.replace(
      [
        "matcherProofArgs(",
        "        candidate.targetedTestArgs,",
        "        MATCHER_PROOF_PRELOAD_PATH,",
        "      )",
      ].join("\n"),
      "candidate.targetedTestArgs",
    ),
    source.replace(
      '    "matcher proof preload write",\n    remainingMs,',
      '    "matcher proof preload write",\n    () => 60_000,',
    ),
  ];
  for (const mutation of mutations) {
    expect(mutation).not.toBe(source);
    expect(matcherProofPreloadContractIssues(mutation)).not.toEqual([]);
  }

  const withSafeHoistedWrapper = source.replace(
      "await flow(flowArgs())(async () => {",
      [
        "async function safeTargetedGate(",
        "  candidate: Candidate,",
        "  timeoutMs: number,",
        "): Promise<CommandLog[]> {",
        "  return await runTargetedGate(candidate, timeoutMs);",
        "}",
        "",
        "await flow(flowArgs())(async () => {",
      ].join("\n"),
    );
  expect(withSafeHoistedWrapper).not.toBe(source);
  const safeHoistedWrapper = withSafeHoistedWrapper.replace(
      'const logs = await runTargetedGate(chosen, budget("repairs"));',
      'const logs = await safeTargetedGate(chosen, budget("repairs"));',
    );
  expect(safeHoistedWrapper).not.toBe(withSafeHoistedWrapper);
  expect(matcherProofPreloadContractIssues(safeHoistedWrapper)).toEqual([]);
});

test("matcher preload wrapper validation follows binding identity", async () => {
  const source = await Bun.file(path).text();
  const mutation = source.replace(
    "await flow(flowArgs())(async () => {",
    [
      "function unrelatedWrapperScope(runTargetedGate: () => void): void {",
      "  const escaped = runTargetedGate;",
      "  runTargetedGate();",
      "  void { runTargetedGate: 1 };",
      "  void escaped;",
      "}",
      "unrelatedWrapperScope(() => undefined);",
      "",
      "await flow(flowArgs())(async () => {",
    ].join("\n"),
  );
  expect(mutation).not.toBe(source);
  expect(matcherProofPreloadContractIssues(mutation)).toEqual([]);
});

test("matcher preload writer rejects a local shadow of its canonical symbol", async () => {
  const source = await Bun.file(path).text();
  const shadowedWriter = source.replace(
    "await flow(flowArgs())(async () => {",
    [
      "await flow(flowArgs())(async () => {",
      "  const writeMatcherProofPreload = async (_remainingMs: () => number): Promise<void> => undefined;",
    ].join("\n"),
  );
  expect(shadowedWriter).not.toBe(source);
  expect(matcherProofPreloadContractIssues(shadowedWriter)).not.toEqual([]);
});

test("matcher proof args reject a local shadow of the runtime import", async () => {
  const source = await Bun.file(path).text();
  const shadowedArgs = source.replace(
    "await flow(flowArgs())(async () => {",
    [
      "await flow(flowArgs())(async () => {",
      "  const matcherProofArgs = (args: readonly string[]): readonly string[] => args;",
    ].join("\n"),
  );
  expect(shadowedArgs).not.toBe(source);
  expect(matcherProofPreloadContractIssues(shadowedArgs)).not.toEqual([]);
});

test("matcher preload wrapper order follows invocations not declarations", async () => {
  const source = await Bun.file(path).text();
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const wrapper = functionDeclarationsNamed(sourceFile, "runTargetedGate")[0];
  expect(wrapper).toBeDefined();
  const wrapperStart = wrapper!.getFullStart();
  const wrapperText = source.slice(wrapperStart, wrapper!.end);
  const withoutWrapper =
    source.slice(0, wrapperStart) + source.slice(wrapper!.end);
  const mutation = withoutWrapper.replace(
    "await flow(flowArgs())(async () => {",
    `${wrapperText}\n\nawait flow(flowArgs())(async () => {`,
  );
  expect(mutation).not.toBe(source);
  expect(matcherProofPreloadContractIssues(mutation)).toEqual([]);
});

test("red-gate order contract rejects deletion, reordering, and bypass", () => {
  const guardedTarget = [
    "  const red = await runTargetAfterPositiveControl(",
    "    control,",
    "    controlTestName(chosen),",
    "    () =>",
    "      runLogged(",
    '        "bun",',
    "        matcherProofArgs(",
    "          namedTestArgs(chosen.testPath, candidateRedTestName),",
    "          MATCHER_PROOF_PRELOAD_PATH,",
    "        ),",
    '        budget("reproduce"),',
    "      ),",
    "  );",
  ].join("\n");
  const valid = [
    'monitor.stage("red-gate", async () => {',
    "  const control = await runLogged(",
    '    "bun",',
    "    matcherProofArgs(",
    "      controlTestArgs(chosen),",
    "      MATCHER_PROOF_PRELOAD_PATH,",
    "    ),",
    '    budget("reproduce"),',
    "  );",
    "  report.validation.push(control);",
    guardedTarget,
    "  report.validation.push(red);",
    "  assertRedGateEvidence(",
    "    control,",
    "    controlTestName(chosen),",
    "    red,",
    "    candidateRedTestName,",
    "    candidateRedMarker(chosen.id),",
    "  );",
    "  await awaitWithinDeadline(",
    '    "RED diff write",',
    '    () => budget("reproduce"),',
    "    async () => await writeText(RED_DIFF_PATH, capturedTestDiff),",
    "  );",
    "});",
  ].join("\n");
  expect(redGateContractIssues(valid)).toEqual([]);

  const deleted = valid.replace("  report.validation.push(control);\n", "");
  const reordered = valid.replace(
    `  report.validation.push(control);\n${guardedTarget}`,
    `${guardedTarget}\n  report.validation.push(control);`,
  );
  const bypassed = valid.replace(
    [
      "  assertRedGateEvidence(",
      "    control,",
      "    controlTestName(chosen),",
      "    red,",
      "    candidateRedTestName,",
      "    candidateRedMarker(chosen.id),",
      "  );",
    ].join("\n"),
    [
      "  if (false) {",
      "    assertRedGateEvidence(",
      "      control,",
      "      controlTestName(chosen),",
      "      red,",
      "      candidateRedTestName,",
      "      candidateRedMarker(chosen.id),",
      "    );",
      "  }",
    ].join("\n"),
  );
  const uncheckedPersistence = mutateDeadlineWrapper(
    valid,
    "RED diff write",
    "remove",
  );

  for (const mutation of [
    deleted,
    reordered,
    bypassed,
    uncheckedPersistence,
  ]) {
    expect(mutation).not.toBe(valid);
    expect(redGateContractIssues(mutation)).not.toEqual([]);
  }

  const internalWhitespaceBinary = valid.replace(
    guardedTarget,
    guardedTarget.replace('        "bun",', '        "b un",'),
  );
  expect(internalWhitespaceBinary).not.toBe(valid);
  expect(redGateContractIssues(internalWhitespaceBinary)).not.toEqual([]);

  for (const mutation of [
    valid.replace(
      "namedTestArgs(chosen.testPath, candidateRedTestName)",
      "chosen.targetedTestArgs",
    ),
    valid.replace(
      "namedTestArgs(chosen.testPath, candidateRedTestName)",
      "controlTestArgs(chosen)",
    ),
    valid.replace(
      "    candidateRedTestName,\n    candidateRedMarker(chosen.id),",
      "    controlTestName(chosen),\n    candidateRedMarker(chosen.id),",
    ),
  ]) {
    expect(mutation).not.toBe(valid);
    expect(redGateContractIssues(mutation)).not.toEqual([]);
  }
});

test("workflow retains the tested runtime bounded-cancellation guard", async () => {
  const source = await Bun.file(path).text();
  expect(boundedRuntimeGuardContractIssues(source)).toEqual([]);

  const missingImport = source.replace("  awaitBounded,\n", "");
  expect(missingImport).not.toBe(source);
  expect(boundedRuntimeGuardContractIssues(missingImport)).toContain(
    "workflow must import awaitBounded once from runtime; received 0",
  );
});

test("absolute deadline ownership remains load-bearing", async () => {
  const runtimeSource = await Bun.file(runtimePath).text();
  expect(runtimeDeadlineOwnershipContractIssues(runtimeSource)).toEqual([]);

  for (const mutation of [
    runtimeSource.replace(
      "first.completedAtMs >= deadlineAtMs",
      "first.completedAtMs > deadlineAtMs",
    ),
    runtimeSource.replace(
      "settled.completedAtMs >= settlementDeadlineAtMs",
      "settled.completedAtMs > settlementDeadlineAtMs",
    ),
    runtimeSource.replace(
      "if (first.completedAtMs >= deadlineAtMs) {\n      throw first.status",
      "if (first.completedAtMs > deadlineAtMs) {\n      throw first.status",
    ),
    runtimeSource.replace(
      "terminal.completedAtMs >= attemptDeadlineMs",
      "terminal.completedAtMs > attemptDeadlineMs",
    ),
    runtimeSource.replace(
      "terminal.completedAtMs >= deadlineMs",
      "terminal.completedAtMs > deadlineMs",
    ),
    runtimeSource.replace(
      "reserveConversationTimeouts(\n      availableMs,",
      "reserveConversationTimeouts(\n      deadlineMs - now(),",
    ),
    runtimeSource.replace(
      "const retainedTerminal = timeoutRetryTerminal(error.terminal);",
      "const retainedTerminal = undefined;",
    ),
    runtimeSource.replace(
      "reason: normalizeFailure(terminal.reason)",
      "reason: String(terminal.reason)",
    ),
    runtimeSource.replace(
      "first.completedAtMs >= deadlineAt || remainingMs() <= 0",
      "first.completedAtMs > deadlineAt || remainingMs() <= 0",
    ),
    runtimeSource.replace(
      "first.completedAtMs >= deadlineAt || remainingMs() <= 0",
      "first.completedAtMs >= deadlineAt || false",
    ),
  ]) {
    expect(mutation).not.toBe(runtimeSource);
    expect(runtimeDeadlineOwnershipContractIssues(mutation).length).toBeGreaterThan(
      0,
    );
  }
});

test("terminal gather evidence waits for bounded status validation", async () => {
  const source = await Bun.file(path).text();
  expect(terminalGatherEvidenceContractIssues(source)).toEqual([]);

  const mutation = source.replace(
    'const statusAfter = await gatherRequired("git", ["status", "--porcelain=v1"]);',
    "const statusAfter = statusBefore;",
  );
  expect(mutation).not.toBe(source);
  expect(terminalGatherEvidenceContractIssues(mutation).length).toBeGreaterThan(
    0,
  );
});

test("every backend conversation reserves terminal settlement inside its stage budget", async () => {
  const source = await Bun.file(path).text();
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const boundedCalls = callsNamed(sourceFile, "awaitBounded");
  const budgetedCalls = callsNamed(
    sourceFile,
    "awaitConversationWithinBudget",
  );

  expect(source).toContain(
    "const CONVERSATION_SETTLEMENT_RESERVE_MS = 5_000;",
  );
  expect(source).toContain("reserveConversationTimeouts");
  expect(boundedCalls).toHaveLength(2);
  expect(
    boundedCalls.map((call) => call.arguments[3]?.getText(sourceFile)),
  ).toEqual([
    "timeouts.settlementTimeoutMs",
    "settlementRemaining()",
  ]);
  expect(budgetedCalls).toHaveLength(7);
});

test("non-scout conversations wire the shared timeout usage recorder", async () => {
  const source = await Bun.file(path).text();
  expect(timeoutUsageContractIssues(source)).toEqual([]);
});

test("non-scout timeout records fulfilled terminal usage once and rethrows", async () => {
  const source = await Bun.file(path).text();
  const usage = { input: 7, output: 5, reasoning: 3 };
  const timeout = new ConversationTimeoutError("implement", 50, {
    status: "fulfilled",
    value: { type: "success", result: { usage } },
    completedAtMs: 51,
  });
  const wrapper = loadAwaitConversationWithinBudget(source, async () => {
    throw timeout;
  });
  const recorded: Array<TimeoutUsage | undefined> = [];
  const rejection = await captureRejection(
    wrapper(
      {
        awaitResult: async () => ({ type: "cancelled" }),
        cancel: async () => undefined,
      },
      60,
      "implement",
      (value) => recorded.push(value),
    ),
  );
  expect(rejection).toBe(timeout);
  expect(recorded).toEqual([usage]);
});

test("non-scout timeout ignores rejected and malformed terminal usage", async () => {
  const source = await Bun.file(path).text();
  const cases = [
    new ConversationTimeoutError("review", 50, {
      status: "rejected",
      reason: { type: "success", result: { usage: { input: 1, output: 1 } } },
      completedAtMs: 51,
    }),
    new ConversationTimeoutError("review", 50, {
      status: "fulfilled",
      value: {
        type: "success",
        result: { usage: { input: -1, output: 1 } },
      },
      completedAtMs: 51,
    }),
    new ConversationTimeoutError("review", 50, {
      status: "fulfilled",
      value: { type: "failed", result: { usage: { input: 1, output: 1 } } },
      completedAtMs: 51,
    }),
  ] as const;
  for (const timeout of cases) {
    const wrapper = loadAwaitConversationWithinBudget(source, async () => {
      throw timeout;
    });
    const recorded: Array<TimeoutUsage | undefined> = [];
    const rejection = await captureRejection(
      wrapper(
        {
          awaitResult: async () => ({ type: "cancelled" }),
          cancel: async () => undefined,
        },
        60,
        "review",
        (value) => recorded.push(value),
      ),
    );
    expect(rejection).toBe(timeout);
    expect(recorded).toEqual([]);
  }
});

test("implementation and repair retain complete gate evidence", async () => {
  const source = await Bun.file(path).text();
  const runtimeSource = await Bun.file(runtimePath).text();
  expect(source).toContain("  gateIssuesFromLogs,\n");
  expect(source).toContain("return ok(gateIssuesFromLogs(logs));");
  expect(runtimeSource).toContain("message: commandFailureMessage(log)");
  expect(
    source.match(/gateVerificationDirective\(candidate\)/g),
  ).toHaveLength(2);
  expect(source).toContain(
    '["bun", ...candidate.targetedTestArgs].join(" ")',
  );
  expect(source).toContain(
    "The parent already ran these gates; do not rerun them before editing.",
  );
  expect(source).toContain("fix in-scope failures until both pass");
});

test("AST stage-limit contract rejects one numeric mutation", async () => {
  const source = await Bun.file(path).text();
  const mutation = source.replace(
    /\bscout:\s*[\d_]+,/,
    "scout: 99_000,",
  );
  expect(mutation).not.toBe(source);
  expect(simpleStageLimitContractIssues(mutation)).toContain(
    "SIMPLE_STAGE_LIMITS.scout must be 155000; received 99000",
  );
});

test("scout timing and tool contracts reject required negative mutations", async () => {
  const source = await Bun.file(path).text();
  const runtimeSource = await Bun.file(runtimePath).text();
  const modelLimitMutation = source.replace(
    "const SCOUT_MODEL_LIMIT_MS = 120_000;",
    "const SCOUT_MODEL_LIMIT_MS = 121_000;",
  );
  expect(modelLimitMutation).not.toBe(source);
  expect(scoutNumericConstantContractIssues(modelLimitMutation)).toContain(
    "SCOUT_MODEL_LIMIT_MS must be 120000; received 121000",
  );

  const gatherLimitMutation = source.replace(
    "const SCOUT_GATHER_LIMIT_MS = 15_000;",
    "const SCOUT_GATHER_LIMIT_MS = 16_000;",
  );
  expect(gatherLimitMutation).not.toBe(source);
  expect(scoutNumericConstantContractIssues(gatherLimitMutation)).toContain(
    "SCOUT_GATHER_LIMIT_MS must be 15000; received 16000",
  );

  const validationLimitMutation = source.replace(
    "const SCOUT_VALIDATION_LIMIT_MS = 20_000;",
    "const SCOUT_VALIDATION_LIMIT_MS = 21_000;",
  );
  expect(validationLimitMutation).not.toBe(source);
  expect(scoutNumericConstantContractIssues(validationLimitMutation)).toContain(
    "SCOUT_VALIDATION_LIMIT_MS must be 20000; received 21000",
  );

  const maxFilesMutation = source.replace(
    "const SCOUT_EVIDENCE_MAX_FILES = 8;",
    "const SCOUT_EVIDENCE_MAX_FILES = 9;",
  );
  expect(maxFilesMutation).not.toBe(source);
  expect(scoutNumericConstantContractIssues(maxFilesMutation)).toContain(
    "SCOUT_EVIDENCE_MAX_FILES must be 8; received 9",
  );

  const toolFreeGuardStart = runtimeSource.indexOf(
    "export async function awaitToolFreeOutcome",
  );
  expect(toolFreeGuardStart).toBeGreaterThan(-1);
  for (const eventType of ["assistant_tool_call", "tool_result"] as const) {
    const guardSource = runtimeSource.slice(toolFreeGuardStart);
    const mutatedGuard = guardSource.replace(
      `event.type === "${eventType}"`,
      `event.type === "removed_${eventType}"`,
    );
    expect(mutatedGuard).not.toBe(guardSource);
    const eventMutation =
      runtimeSource.slice(0, toolFreeGuardStart) + mutatedGuard;
    expect(scoutToolGuardContractIssues(eventMutation)).toContain(
      `runtime tool guard missing ${eventType} check`,
    );
  }

  const cancellationMutation = runtimeSource.replace(
    '        cancelBestEffort(conversation, "scout attempted tool use");',
    "        void conversation;",
  );
  expect(cancellationMutation).not.toBe(runtimeSource);
  expect(scoutToolGuardContractIssues(cancellationMutation)).toContain(
    "runtime tool guard must cancel best-effort once; received 0 callsites",
  );
});

test("scout prompt rejects an unexpected returned-array expression", async () => {
  const source = await Bun.file(path).text();
  const promptStart = source.indexOf("function scopedScoutPrompt(");
  const promptEnd = source.indexOf("function reproducePrompt", promptStart);
  const prompt = source.slice(promptStart, promptEnd);
  expect(prompt).toContain('"Evidence packet:",');
  expect(prompt).toContain("evidence,");
  expect(prompt).toContain('].join("\\n");');
});

test("usage, ledger, and JSON persistence cannot become no-ops", async () => {
  const source = await Bun.file(path).text();
  expect(source).toContain("const recordUsage = (usage: Usage | undefined): void => {");
  expect(source).toContain("report.usage = requireRecordedUsage(report.usage);");
  expect(persistenceHelperContractIssues(source)).toEqual([]);
  expect(source).toContain('label: "delivery record",');

  const aggregateUsage = source.replace(
    "      report.validation.push(...baselineResult.validation);",
    [
      "      report.validation.push(...baselineResult.validation);",
      "      recordUsage(baselineResult.usage);",
    ].join("\n"),
  );
  expect(aggregateUsage).not.toBe(source);
  expect(baselineUsageContractIssues(aggregateUsage)).toContain(
    "baseline aggregate usage must not be recorded twice",
  );

  const deadIssueCall = source.replace(
    "              const commit = await appendIssue(issue, runId, context);",
    "              const commit = false ? await appendIssue(issue, runId, context) : undefined;",
  );
  expect(deadIssueCall).not.toBe(source);
  expect(statusAndArtifactContractIssues(deadIssueCall)).toContain(
    "issue ledger artifact writer must run unconditionally",
  );

  const deadIssueWrite = source.replace(
    [
      "  return await publishFinalizationText(",
      "    ISSUE_PATH,",
      "    `${prefix}${JSON.stringify(issue)}\\n`,",
      "    runId,",
      "    context,",
      "  );",
    ].join("\n"),
    [
      "  if (false) return await publishFinalizationText(",
      "    ISSUE_PATH,",
      "    `${prefix}${JSON.stringify(issue)}\\n`,",
      "    runId,",
      "    context,",
      "  );",
    ].join("\n"),
  );
  expect(deadIssueWrite).not.toBe(source);
  expect(persistenceHelperContractIssues(deadIssueWrite)).toContain(
    "appendIssue must unconditionally persist its ledger row",
  );

  const deadJsonWrite = source.replace(
    "  await writeText(path, `${JSON.stringify(value, null, 2)}\\n`);",
    "  if (false) await writeText(path, `${JSON.stringify(value, null, 2)}\\n`);",
  );
  expect(deadJsonWrite).not.toBe(source);
  expect(persistenceHelperContractIssues(deadJsonWrite)).toContain(
    "writeJson must unconditionally persist its payload",
  );
});

test("workflow finalization persists failure-shaped evidence", async () => {
  const source = await Bun.file(path).text();
  const outerTry = source.indexOf(
    'try {\n    runId = requiredEnvironment("ORCA_IMPROVEMENT_RUN_ID")',
  );
  const backendInit = source.indexOf("const activeSelected = selectBackend");
  expect(outerTry).toBeGreaterThan(-1);
  expect(backendInit).toBeGreaterThan(-1);
  expect(backendInit).toBeLessThan(outerTry);

  const finalizationStart = source.indexOf(
    "const finalizerErrors = await finalizeWorkflowEvidence({",
  );
  expect(finalizationStart).toBeGreaterThan(-1);
  const finalizationEnd = source.indexOf(
    "console.log(`monitor=",
    finalizationStart,
  );
  expect(finalizationEnd).toBeGreaterThan(finalizationStart);
  const finalization = source.slice(finalizationStart, finalizationEnd);

  for (const required of [
    "bodyFailed,",
    'label: "shutdown"',
    'label: "issue ledger"',
    'label: "monitor"',
    'label: "report"',
    "enterFailureState:",
    'report.stage = "finalize"',
    'report.sla = "failed"',
    "report.stopReason =",
    "monitor.recordFailure({",
    "pendingIssue = buildRunIssue(",
    "`${runId}-finalize`",
    '"finalize"',
    '"environment"',
  ]) {
    expect(finalization).toContain(required);
  }
  expect(finalization.indexOf('label: "shutdown"')).toBeLessThan(
    finalization.indexOf("artifacts: ["),
  );
  expect(statusAndArtifactContractIssues(source)).toEqual([]);
  expect(runIssueContextContractIssues(source)).toEqual([]);

  const monitorMutation = source.replace(
    [
      "          run: async (context) => {",
      "            return await publishFinalizationText(",
      "              `${MONITOR_DIR}/${monitor.runId}.json`,",
      "              `${JSON.stringify(monitor.toJson(), null, 2)}\\n`,",
      "              runId,",
      "              context,",
      "            );",
      "          },",
    ].join("\n"),
    [
      "          run: async (context) => {",
      "            if (false) return await publishFinalizationText(",
      "              `${MONITOR_DIR}/${monitor.runId}.json`,",
      "              `${JSON.stringify(monitor.toJson(), null, 2)}\\n`,",
      "              runId,",
      "              context,",
      "            );",
      "          },",
    ].join("\n"),
  );
  expect(monitorMutation).not.toBe(source);
  expect(statusAndArtifactContractIssues(monitorMutation)).toContain(
    "monitor artifact writer must atomically publish fresh toJson",
  );

  for (const binding of [
    "    backend: report.backend,\n",
    "    worktree: report.worktree,\n",
    "    branch: report.branch,\n",
    "    monitorPath: `${MONITOR_DIR}/${monitor.runId}.json`,\n",
    "    ...(report.prUrl === undefined ? {} : { prUrl: report.prUrl }),\n",
  ]) {
    const mutation = source.replace(binding, "");
    expect(mutation).not.toBe(source);
    expect(runIssueContextContractIssues(mutation).length).toBeGreaterThan(0);
  }
  expect(source).toContain("finalizeWorkflowEvidence,");
  expect(source).toContain("let bodyFailed = false;");
  expect(source).toContain("bodyFailed = true;");
  expect(source).toContain(
    "if (!bodyFailed && finalizerErrors.length > 0)",
  );
  expect(source).not.toContain("originalError");
  expect(source).not.toContain("async function attemptFinalizer");
});

test("finalization publication creates missing owner-only parents", async () => {
  const publish = await loadFinalizationTextPublisher(await Bun.file(path).text());
  const root = await mkdtemp(
    join(process.cwd(), ".orcats-finalization-parent-"),
  );
  const destination = join(root, "missing", "nested", "report.json");
  let commits = 0;
  try {
    await publish(
      destination,
      "published\n",
      "run",
      finalizationContext(() => {
        commits += 1;
        return { remainingMs: 1_000 };
      }),
    );
    expect(await readFile(destination, "utf8")).toBe("published\n");
    await expectRealOwnerOnlyDirectory(join(root, "missing"));
    await expectRealOwnerOnlyDirectory(join(root, "missing", "nested"));
    expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    expect(commits).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalization publication rejects a direct symbolic-link parent", async () => {
  const publish = await loadFinalizationTextPublisher(await Bun.file(path).text());
  const root = await mkdtemp(
    join(process.cwd(), ".orcats-finalization-direct-link-"),
  );
  const external = join(root, "external");
  const destination = join(root, "direct", "report.json");
  let commits = 0;
  try {
    await createOwnerOnlyDirectory(external);
    await symlink(external, join(root, "direct"));
    await expect(
      publish(
        destination,
        "published\n",
        "run",
        finalizationContext(() => {
          commits += 1;
          return { remainingMs: 1_000 };
        }),
      ),
    ).rejects.toThrow("is not a real owner-only directory");
    expect(commits).toBe(0);
    await expect(access(join(external, "report.json"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalization publication rejects an intermediate symbolic-link parent", async () => {
  const publish = await loadFinalizationTextPublisher(await Bun.file(path).text());
  const root = await mkdtemp(
    join(process.cwd(), ".orcats-finalization-intermediate-link-"),
  );
  const managed = join(root, "managed");
  const external = join(root, "external");
  const destination = join(managed, "intermediate", "nested", "report.json");
  let commits = 0;
  try {
    await createOwnerOnlyDirectory(managed);
    await createOwnerOnlyDirectory(external);
    await createOwnerOnlyDirectory(join(external, "nested"));
    await symlink(external, join(managed, "intermediate"));
    await expect(
      publish(
        destination,
        "published\n",
        "run",
        finalizationContext(() => {
          commits += 1;
          return { remainingMs: 1_000 };
        }),
      ),
    ).rejects.toThrow("is not a real owner-only directory");
    expect(commits).toBe(0);
    await expect(access(join(external, "nested", "report.json"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalization publication never follows the old predictable temporary symlink", async () => {
  const source = await Bun.file(path).text();
  const publish = await loadFinalizationTextPublisher(source);
  const root = await mkdtemp(
    join(process.cwd(), ".orcats-finalization-symlink-"),
  );
  const destination = join(root, "report.json");
  const external = join(root, "external.txt");
  const oldTemporary = `${destination}.tmp-run-1`;
  const controller = new AbortController();
  let commitCalls = 0;
  try {
    await writeFile(external, "external-original\n");
    await symlink(external, oldTemporary);

    await publish(destination, "published\n", "run", {
      signal: controller.signal,
      attempt: 1,
      remainingMs: () => 1_000,
      isCurrent: () => true,
      commitPublication: () => {
        commitCalls += 1;
        return { remainingMs: 1_000 };
      },
    });

    expect(await readFile(external, "utf8")).toBe("external-original\n");
    expect((await lstat(oldTemporary)).isSymbolicLink()).toBe(true);
    expect(await readFile(destination, "utf8")).toBe("published\n");
    const destinationStatus = await lstat(destination);
    expect(destinationStatus.isFile()).toBe(true);
    expect(destinationStatus.isSymbolicLink()).toBe(false);
    expect(destinationStatus.mode & 0o777).toBe(0o600);
    expect(commitCalls).toBe(1);
    expect((await readdir(root)).sort()).toEqual(
      ["external.txt", "report.json", "report.json.tmp-run-1"].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalization publication rejects stale and terminal-order mutants", async () => {
  const source = await Bun.file(path).text();
  const runtimeSource = await Bun.file(runtimePath).text();
  expect(finalizationPublicationContractIssues(source)).toEqual([]);
  expect(secureFinalizationPublicationContractIssues(runtimeSource)).toEqual([]);
  expect(statusAndArtifactContractIssues(source)).toEqual([]);

  const parentPreparationIssue =
    "finalization publication must create and validate each real parent before temporary-file creation";
  const parentPreparationMutations = [
    runtimeSource.replace(
      "    prepareFinalizationPublicationParent(destination);\n",
      "",
    ),
    runtimeSource.replace("mode: 0o700", "mode: 0o755"),
    runtimeSource.replace(" || status.isSymbolicLink()", ""),
    runtimeSource.replace(
      "for (const segment of suffix.split(sep).filter(Boolean)) {",
      "for (const segment of [suffix]) {",
    ),
  ];
  for (const mutation of parentPreparationMutations) {
    expect(mutation).not.toBe(runtimeSource);
    expect(secureFinalizationPublicationContractIssues(mutation)).toContain(
      parentPreparationIssue,
    );
  }

  const directTargetWrite = source.replace(
    [
      "  return await publishFinalizationText(",
      "    ISSUE_PATH,",
      "    `${prefix}${JSON.stringify(issue)}\\n`,",
      "    runId,",
      "    context,",
      "  );",
    ].join("\n"),
    "  await writeText(ISSUE_PATH, `${prefix}${JSON.stringify(issue)}\\n`);",
  );
  expect(directTargetWrite).not.toBe(source);
  expect(persistenceHelperContractIssues(directTargetWrite)).toContain(
    "appendIssue must unconditionally persist its ledger row",
  );

  const directWrapper = source.replace(
    "  return await publishFinalizationTextSecure(path, value, context);",
    [
      "  await writeText(path, value);",
      "  return context.commitPublication();",
    ].join("\n"),
  );
  expect(directWrapper).not.toBe(source);
  expect(finalizationPublicationContractIssues(directWrapper)).toContain(
    "finalization publication must delegate only to the secure ignored-runtime helper",
  );

  const insecureCreationMutations = [
    runtimeSource.replace(
      '`${destination}.tmp-${randomBytes(24).toString("hex")}`',
      "`${destination}.tmp`",
    ),
    runtimeSource.replace(
      "constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY",
      "constants.O_CREAT | constants.O_WRONLY",
    ),
    runtimeSource.replace(
      "      0o600,",
      "      0o644,",
    ),
    runtimeSource.replace(
      "    fchmodSync(descriptor, 0o600);",
      "    void descriptor;",
    ),
  ];
  for (const mutation of insecureCreationMutations) {
    expect(mutation).not.toBe(runtimeSource);
    expect(secureFinalizationPublicationContractIssues(mutation)).toContain(
      "finalization publication must create a cryptographically random exclusive 0600 same-directory file",
    );
  }

  const incompleteWriteMutations = [
    runtimeSource.replace("    writeFileSync(descriptor, value, { encoding: \"utf8\" });", "    void value;"),
    runtimeSource.replace("    fsyncSync(descriptor);", "    void descriptor;"),
    runtimeSource.replace("    closeSync(closingDescriptor);", "    void closingDescriptor;"),
    runtimeSource.replace("const opened = fstatSync", "const opened = unsafeFstatSync"),
    runtimeSource.replace("const closed = lstatSync", "const closed = unsafeLstatSync"),
    runtimeSource.replace(
      "    assertFinalizationPublicationStatus(\n      lstatSync(temporaryPath, { bigint: true }),",
      "    unsafeFinalizationPublicationStatus(\n      lstatSync(temporaryPath, { bigint: true }),",
    ),
  ];
  for (const mutation of incompleteWriteMutations) {
    expect(mutation).not.toBe(runtimeSource);
    expect(secureFinalizationPublicationContractIssues(mutation)).toContain(
      "finalization publication must finish write close and identity validation before one authentic commit immediately followed by rename",
    );
  }

  const workBetweenCommitAndRename = runtimeSource.replace(
    [
      "    const commit = context.commitPublication();",
      "    renameSync(temporaryPath, destination);",
    ].join("\n"),
    [
      "    const commit = context.commitPublication();",
      "    void context.remainingMs();",
      "    renameSync(temporaryPath, destination);",
    ].join("\n"),
  );
  const renameBeforeCommit = runtimeSource.replace(
    [
      "    const commit = context.commitPublication();",
      "    renameSync(temporaryPath, destination);",
    ].join("\n"),
    [
      "    renameSync(temporaryPath, destination);",
      "    const commit = context.commitPublication();",
    ].join("\n"),
  );
  const forgedCommit = runtimeSource.replace(
    [
      "    renameSync(temporaryPath, destination);",
      "    return commit;",
    ].join("\n"),
    [
      "    renameSync(temporaryPath, destination);",
      "    return { remainingMs: commit.remainingMs };",
    ].join("\n"),
  );
  const secondCommit = runtimeSource.replace(
    "    const commit = context.commitPublication();",
    [
      "    const commit = context.commitPublication();",
      "    context.commitPublication();",
    ].join("\n"),
  );
  for (const mutation of [
    workBetweenCommitAndRename,
    renameBeforeCommit,
    forgedCommit,
    secondCommit,
  ]) {
    expect(mutation).not.toBe(runtimeSource);
    expect(secureFinalizationPublicationContractIssues(mutation)).toContain(
      "finalization publication must finish write close and identity validation before one authentic commit immediately followed by rename",
    );
  }

  const cleanupMutations = [
    runtimeSource.replace(
      "            removeExactFinalizationTemporaryFile(temporaryPath, identity);",
      "            void temporaryPath;",
    ),
    runtimeSource.replace("  unlinkSync(path);", "  rmSync(path, { force: true });"),
    runtimeSource.replace(
      "    status.dev !== identity.device ||",
      "    false ||",
    ),
  ];
  for (const mutation of cleanupMutations) {
    expect(mutation).not.toBe(runtimeSource);
    expect(secureFinalizationPublicationContractIssues(mutation)).toContain(
      "finalization publication cleanup must unlink only its exact validated regular-file identity",
    );
  }

  const staleFlowImplementation = source.replace(
    "  return await publishFinalizationTextSecure(path, value, context);",
    [
      "  const temporaryPath = `${path}.tmp-${_runId}-${String(context.attempt)}`;",
      "  await writeText(temporaryPath, value);",
      "  const commit = context.commitPublication();",
      "  renameSync(temporaryPath, path);",
      "  return commit;",
    ].join("\n"),
  );
  expect(staleFlowImplementation).not.toBe(source);
  expect(finalizationPublicationContractIssues(staleFlowImplementation)).toContain(
    "finalization publication must delegate only to the secure ignored-runtime helper",
  );

  for (const mutation of [
    runtimeSource.replace("    writeFileSync(descriptor, value, { encoding: \"utf8\" });", "    const commit = context.commitPublication();"),
    runtimeSource.replace(
      "    const commit = context.commitPublication();",
      "    const commit = { remainingMs: context.remainingMs() };",
    ),
  ]) {
    expect(mutation).not.toBe(runtimeSource);
    expect(secureFinalizationPublicationContractIssues(mutation)).toContain(
      "finalization publication must finish write close and identity validation before one authentic commit immediately followed by rename",
    );
  }

  const reportStart = source.indexOf("      report: {");
  const reportEnd = source.indexOf("      enterFailureState:", reportStart);
  const artifactsEnd = source.lastIndexOf("      ],\n", reportStart);
  const reportProperty = source.slice(reportStart, reportEnd);
  const movedReport =
    source.slice(0, artifactsEnd) +
    reportProperty
      .replace("      report: {", "        {")
      .replace(/\n      },\n$/, "\n        },\n      ],\n") +
    source.slice(reportEnd);
  expect(movedReport).not.toBe(source);
  expect(statusAndArtifactContractIssues(movedReport).length).toBeGreaterThan(0);

  const monitorWriteLog = source.replace(
    [
      "          run: async (context) => {",
      "            return await publishFinalizationText(",
      "              `${MONITOR_DIR}/${monitor.runId}.json`,",
      "              `${JSON.stringify(monitor.toJson(), null, 2)}\\n`,",
      "              runId,",
      "              context,",
      "            );",
      "          },",
    ].join("\n"),
    [
      "          run: async (context) => {",
      "            await monitor.writeLog(MONITOR_DIR);",
      "          },",
    ].join("\n"),
  );
  expect(monitorWriteLog).not.toBe(source);
  expect(statusAndArtifactContractIssues(monitorWriteLog)).toContain(
    "monitor artifact writer must atomically publish fresh toJson",
  );

  const slaBlock = [
    "          report.sla =",
    "            !bodyFailed &&",
    '            report.stage !== "finalize" &&',
    "            deliveryRecordPublished &&",
    '            report.activeStatus === "ready" &&',
    "            report.elapsedMs <= runtimeDeadlineMs() &&",
    "            remainingAtReport > 0",
    '              ? "passed"',
    '              : "failed";',
  ].join("\n");
  const reportPublish = [
    "          return await publishFinalizationText(",
    "            `${REPORT_DIR}/${runId}/report.json`,",
    "            `${JSON.stringify(report, null, 2)}\\n`,",
    "            runId,",
    "            context,",
    "          );",
  ].join("\n");
  const lateSla = source.replace(
    `${slaBlock}\n${reportPublish}`,
    `${reportPublish}\n${slaBlock}`,
  );
  expect(lateSla).not.toBe(source);
  expect(statusAndArtifactContractIssues(lateSla)).toContain(
    "report artifact writer must compute terminal SLA before atomic publication",
  );
  expect(effectiveTimingContractIssues(lateSla)).toContain(
    "final SLA must be assigned during bounded finalization and reject deadline overrun",
  );
});

test("workflow persists review completion and active-ready stop evidence", async () => {
  const source = await Bun.file(path).text();
  for (const required of [
    "  initialReviewFindings?: ReviewFinding[];",
    "  finalReviewFindings?: ReviewFinding[];",
    "  finalReviewBlockerCount?: number;",
    "report.finalReviewBlockerCount !== 0",
    'report.stopReason = "active-ready";',
    'reason: "active-ready",',
    'report.activeStatus = "ready";',
  ]) {
    expect(source).toContain(required);
  }
  expect(source).not.toContain('report.stopReason = "completed";');
});

test("fresh locked-audit mutants remain load-bearing", async () => {
  const source = await Bun.file(path).text();

  const directiveErased = source.replace(
    "      withSelectedModel(config, activeSelected.model);",
    "      ({ ...withSelectedModel(config, activeSelected.model), systemPrompt: undefined });",
  );
  expect(directiveErased).not.toBe(source);
  expect(directiveWiringContractIssues(directiveErased).length).toBeGreaterThan(0);

  const requiredFailureIgnored = source.replace(
    "  return await runRequiredCommand(command(), commandName, args, timeoutMs);",
    [
      "  return await runRequiredCommand(command(), commandName, args, timeoutMs)",
      "    .catch(() => ({",
      "      command: commandName,",
      "      exitCode: 0,",
      '      stdout: "passed",',
      '      stderr: "",',
      "      durationMs: 0,",
      "    }));",
    ].join("\n"),
  );
  expect(requiredFailureIgnored).not.toBe(source);
  expect(
    verificationGateContractIssues(requiredFailureIgnored).length,
  ).toBeGreaterThan(0);

  const branchMismatchIgnored = source.replace(
    "  assertCurrentBranch(branch.stdout, expectedBranch);",
    "  branch.stdout.trim();",
  );
  expect(branchMismatchIgnored).not.toBe(source);
  expect(branchContextContractIssues(branchMismatchIgnored).length).toBeGreaterThan(0);

  const branchLogOmitted = source.replace(
    "  return [branch, originMain, originFetchUrl, originPushUrl];",
    "  return [originMain, originFetchUrl, originPushUrl];",
  );
  expect(branchLogOmitted).not.toBe(source);
  expect(
    postAgentGitContextContractIssues(branchLogOmitted).length,
  ).toBeGreaterThan(0);

  for (const mutation of [
    source.replace(
      'remainingTimeout(30_000, remaining(), "git diff changed paths")',
      'remainingTimeout(30_000, 30_000, "git diff changed paths")',
    ),
    source.replace(
      'remainingTimeout(30_000, remaining(), `git diff ${path}`)',
      'remainingTimeout(30_000, 30_000, `git diff ${path}`)',
    ),
  ]) {
    expect(mutation).not.toBe(source);
    expect(stageRemainderContractIssues(mutation).length).toBeGreaterThan(0);
  }

  const deadAggregator = source.replace(
    "    if (merged !== undefined) report.usage = merged;",
    "    if (false && merged !== undefined) report.usage = merged;",
  );
  expect(deadAggregator).not.toBe(source);
  expect(baselineUsageContractIssues(deadAggregator).length).toBeGreaterThan(0);

  const scoutUsageOmitted = source.replace(
    [
      "          recordUsage(scopedUsage.get(record.scopeIndex));",
      "        },",
      "        recordReportSummary: (summary) =>",
    ].join("\n"),
    [
      "        },",
      "        recordReportSummary: (summary) =>",
    ].join("\n"),
  );
  expect(scoutUsageOmitted).not.toBe(source);
  expect(baselineUsageContractIssues(scoutUsageOmitted).length).toBeGreaterThan(0);

  const implementationUsageOmitted = source.replace(
    [
      "      recordUsage(outcome.result.usage);",
      "      assertImmutableTestDiff(",
      "        capturedTestDiff,",
      '        await pathDiff(chosen.testPath, () => budget("implement")),',
    ].join("\n"),
    [
      "      assertImmutableTestDiff(",
      "        capturedTestDiff,",
      '        await pathDiff(chosen.testPath, () => budget("implement")),',
    ].join("\n"),
  );
  expect(implementationUsageOmitted).not.toBe(source);
  expect(
    baselineUsageContractIssues(implementationUsageOmitted).length,
  ).toBeGreaterThan(0);

  const failedTargetedLogsHidden = source.replace(
    "return ok(gateIssuesFromLogs(logs));",
    "return ok([]);",
  );
  expect(failedTargetedLogsHidden).not.toBe(source);
  expect(
    verificationGateContractIssues(failedTargetedLogsHidden).length,
  ).toBeGreaterThan(0);
});

test("parent plan helper signatures match the executable workflow", async () => {
  const plan = await Bun.file(
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
  ).text();
  for (const obsolete of [
    "async function changedPaths(): Promise<string[]>;",
    "async function pathDiff(path: string): Promise<string>;",
    "async function assertTrackedPaths(paths: readonly string[]): Promise<void>;",
  ]) {
    expect(plan).not.toContain(obsolete);
  }
  for (const current of [
    "async function changedPaths(remaining: () => number): Promise<string[]>;",
    "async function pathDiff(path: string, remaining: () => number): Promise<string>;",
    "async function assertTrackedPaths(paths: readonly string[], timeoutMs: number): Promise<void>;",
  ]) {
    expect(plan).toContain(current);
  }
});

test("scout correction delegates count-free closure to launcher", async () => {
  const correction = await Bun.file(
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
  ).text();
  expect(correction16LedgerContractIssues(correction)).toEqual([]);
  expect(correction).not.toMatch(/other \d+ open ledger entries/);
  expect(correction).toContain("launcher-owned canonical ledger closure");
  expect(correction).toContain("every latest-open ledger ID");
  expect(correction).toContain("Correction 17");
  expect(correction).toContain("203 passes and 906 assertions");
});

test("implementation cannot omit its active budget", async () => {
  const source = await Bun.file(path).text();
  expect(effectiveTimingContractIssues(source)).toEqual([]);

  const mutation = source.replace('    beginBudget("implement");\n', "");
  expect(mutation).not.toBe(source);
  expect(effectiveTimingContractIssues(mutation).length).toBeGreaterThan(0);
});

test("active-ready delivery cannot enter remote checks", async () => {
  const source = await Bun.file(path).text();
  expect(source).not.toContain('enter("remote-checks")');
  expect(source).not.toContain('monitor.stage("remote-checks"');
  expect(source).not.toContain('enter("merge")');
  expect(source).not.toContain('monitor.stage("merge"');

  const mutation = source.replace(
    'report.stopReason = "active-ready";',
    'report.stopReason = "remote-checks";',
  );
  expect(mutation).not.toBe(source);
  expect(mutation).toContain('report.stopReason = "remote-checks";');
});

test("backend usage recording cannot hide behind a guard", async () => {
  const source = await Bun.file(path).text();
  expect(source).toContain("recordUsage(outcome.result.usage);");

  const mutation = source.replace(
    [
      "      recordUsage(outcome.result.usage);",
      "      assertImmutableTestDiff(",
      "        capturedTestDiff,",
      '        await pathDiff(chosen.testPath, () => budget("implement")),',
    ].join("\n"),
    [
      "      if (false) recordUsage(outcome.result.usage);",
      "      assertImmutableTestDiff(",
      "        capturedTestDiff,",
      '        await pathDiff(chosen.testPath, () => budget("implement")),',
    ].join("\n"),
  );
  expect(mutation).not.toBe(source);
  expect(mutation).toContain("if (false) recordUsage(outcome.result.usage);");

});

test("workflow finalization cannot be shadowed by a local no-op", async () => {
  const source = await Bun.file(path).text();
  expect(statusAndArtifactContractIssues(source)).toEqual([]);

  const mutation = source.replace(
    "\n  const requestedBackend",
    [
      "  const finalizeWorkflowEvidence = async () => [];",
      "  const requestedBackend",
    ].join("\n"),
  );
  expect(mutation).not.toBe(source);
  expect(statusAndArtifactContractIssues(mutation).length).toBeGreaterThan(0);
});

test("reproduce prompt evidence cannot be erased", async () => {
  const source = await Bun.file(path).text();
  expect(directiveWiringContractIssues(source)).toEqual([]);

  const mutation = source.replace(
    [
      "    report.appliedSystemPrompts.reproduce =",
      '      reproduceConfig.systemPrompt ?? "";',
    ].join("\n"),
    '    report.appliedSystemPrompts.reproduce = "";',
  );
  expect(mutation).not.toBe(source);
  expect(directiveWiringContractIssues(mutation).length).toBeGreaterThan(0);
});

test("full verify failure cannot become a synthetic passing log", async () => {
  const source = await Bun.file(path).text();
  expect(verificationGateContractIssues(source)).toEqual([]);

  const mutation = source.replace(
    "      );\n      report.validation.push(full);",
    [
      "      ).catch(() => ({",
      '        command: "bun run verify",',
      "        exitCode: 0,",
      '        stdout: "passed",',
      '        stderr: "",',
      "        durationMs: 0,",
      "      }));",
      "      report.validation.push(full);",
    ].join("\n"),
  );
  expect(mutation).not.toBe(source);
  expect(verificationGateContractIssues(mutation).length).toBeGreaterThan(0);
});

test("ranked restoration rejection cannot be swallowed", async () => {
  const source = await Bun.file(path).text();
  expect(source).toContain("const restoration = await restoreExactTestSnapshot(");

  const mutation = source.replace(
    [
      "                const restoration = await restoreExactTestSnapshot(",
      "                  attempted.testPath,",
      "                  snapshot,",
      '                  () => budget("reproduce"),',
      "                );",
    ].join("\n"),
    [
      "                const restoration = await restoreExactTestSnapshot(",
      "                  attempted.testPath,",
      "                  snapshot,",
      '                  () => budget("reproduce"),',
      "                ).catch(() => undefined as never);",
    ].join("\n"),
  );
  expect(mutation).not.toBe(source);
  expect(mutation).toContain(".catch(() => undefined as never)");
});

test("Correction 17 cannot mask a numeric Correction 16 remainder", async () => {
  const correction = await Bun.file(
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
  ).text();
  const staleCorrection16 = correction.replace(
    "atomically commit same-ID resolved records for every latest-open ledger ID.",
    "atomically commit same-ID resolved records for the remaining 16 latest-open ledger entries.",
  );
  const mutation = staleCorrection16.replace(
    "launcher terminal commit supersedes workflow-owned correction appends.",
    "launcher terminal commit closes every latest-open ledger ID.",
  );
  expect(staleCorrection16).not.toBe(correction);
  expect(mutation).not.toBe(correction);

  const acceptedByCurrentContract =
    correction16LedgerContractIssues(mutation).length === 0 &&
    !/\b\d+\s+(?:latest-)?open ledger entries\b/.test(mutation) &&
    mutation.includes("every latest-open ledger ID") &&
    mutation.includes("Correction 17") &&
    mutation.includes("203 passes and 906 assertions");
  expect(acceptedByCurrentContract).toBe(false);
});

test("workspace-write stages guard ignored .orca content manifests", async () => {
  const source = await Bun.file(path).text();
  expect(ignoredOrcaGuardContractIssues(source)).toEqual([]);

  const noOpGuard = source.replace(
    "return await withGitManifestGuard(",
    "return await (async (_read: unknown, run: () => Promise<T>) => await run())(",
  );
  expect(noOpGuard).not.toBe(source);
  expect(ignoredOrcaGuardContractIssues(noOpGuard)).toContain(
    "ignored .orca guard must directly delegate to runtime manifest guard",
  );

  const dormantCaptureHelper = source.replace(
    "  return await captureFileContentManifest(paths, {",
    "  if (false) return await captureFileContentManifest(paths, {",
  );
  expect(dormantCaptureHelper).not.toBe(source);
  expect(ignoredOrcaGuardContractIssues(dormantCaptureHelper)).toContain(
    "ignored .orca capture helper must directly return its bounded content manifest",
  );

  const dormantReaderCapture = source.replace(
    "      const actual = await captureIgnoredOrcaContentManifest(remaining);",
    [
      "      if (false) await captureIgnoredOrcaContentManifest(remaining);",
      "      const actual: GitManifestEntry[] = [];",
    ].join("\n"),
  );
  expect(dormantReaderCapture).not.toBe(source);
  expect(ignoredOrcaGuardContractIssues(dormantReaderCapture)).toContain(
    "ignored .orca guard reader must await one bounded content capture",
  );

  const dormantReaderAssertion = source.replace(
    "        assertIgnoredOrcaContentManifest(expected, actual, label);",
    "        if (false) assertIgnoredOrcaContentManifest(expected, actual, label);",
  );
  expect(dormantReaderAssertion).not.toBe(source);
  expect(ignoredOrcaGuardContractIssues(dormantReaderAssertion)).toContain(
    "ignored .orca guard reader must actively compare and return each capture",
  );
});

test("verified candidate bytes bind worktree, index, and commit before push", async () => {
  const source = await Bun.file(path).text();
  expect(verifiedCandidateManifestContractIssues(source)).toEqual([]);

  const stagedFromWorktree = source.replace(
    "const stagedManifest = await captureCandidateIndexManifest(",
    "const stagedManifest = await captureCandidateWorktreeManifest(",
  );
  expect(stagedFromWorktree).not.toBe(source);
  expect(verifiedCandidateManifestContractIssues(stagedFromWorktree)).toContain(
    "staged candidate manifest must come from Git index",
  );

  const committedFromWorktree = source.replace(
    "const committedManifest = await captureCandidateCommitManifest(",
    "const committedManifest = await captureCandidateWorktreeManifest(",
  );
  expect(committedFromWorktree).not.toBe(source);
  expect(
    verifiedCandidateManifestContractIssues(committedFromWorktree),
  ).toContain("committed candidate manifest must come from commit tree");

  const swallowedMismatch = source.replace(
    '      assertGitManifestUnchanged(verifiedContentManifest, committedManifest, "committed candidate content");',
    [
      "      try {",
      '        assertGitManifestUnchanged(verifiedContentManifest, committedManifest, "committed candidate content");',
      "      } catch {",
      "        // Swallowing a mismatch must never allow push.",
      "      }",
    ].join("\n"),
  );
  expect(swallowedMismatch).not.toBe(source);
  expect(verifiedCandidateManifestContractIssues(swallowedMismatch)).toContain(
    "committed candidate comparison must be a direct guard",
  );

  const bypassedCommittedPaths = source.replace(
    "      parseExactGitPathList(\n        committedPaths.stdout,",
    "      if (false) parseExactGitPathList(\n        committedPaths.stdout,",
  );
  expect(bypassedCommittedPaths).not.toBe(source);
  expect(
    verifiedCandidateManifestContractIssues(bypassedCommittedPaths),
  ).toContain(
    "committed path-set comparison must directly dominate commit manifest and push",
  );

  const emptyPrePushCapture = source.replace(
    "      const prePushWorktreeManifest = await captureCandidateWorktreeManifest(",
    "      const prePushWorktreeManifest: GitManifestEntry[] = []; if (false) await captureCandidateWorktreeManifest(",
  );
  expect(emptyPrePushCapture).not.toBe(source);
  expect(verifiedCandidateManifestContractIssues(emptyPrePushCapture)).toContain(
    "pre-push candidate manifest must come from current worktree",
  );
});

test("delivery binds one exact commit and its full path range before push", async () => {
  const source = await Bun.file(path).text();
  expect(deliveryAncestryContractIssues(source)).toEqual([]);

  const multipleParents = source.replace(
    "ancestryParts.length !== 2",
    "ancestryParts.length < 2",
  );
  expect(multipleParents).not.toBe(source);
  expect(deliveryAncestryContractIssues(multipleParents)).toContain(
    "delivery must prove the validated commit has exactly the pre-commit HEAD as parent",
  );

  const tipOnlyPaths = source.replace(
    [
      '          "diff",',
      '          "--name-only",',
      '          "-z",',
      "          preCommitHeadSha,",
      "          validatedHeadSha,",
      '          "--",',
    ].join("\n"),
    [
      '          "diff-tree",',
      '          "--no-commit-id",',
      '          "--name-only",',
      '          "-r",',
      '          "-z",',
      '          "HEAD",',
    ].join("\n"),
  );
  expect(tipOnlyPaths).not.toBe(source);
  expect(deliveryAncestryContractIssues(tipOnlyPaths)).toContain(
    "delivery must compare the exact full pre-commit-to-validated range path set before push",
  );
});

test("post-agent and pre-push Git context remains launcher-bound", async () => {
  const source = await Bun.file(path).text();
  expect(postAgentGitContextContractIssues(source)).toEqual([]);

  const bypass = source.replace(
    '          "pre-push",\n          report.branch,',
    '          "post-agent",\n          report.branch,',
  );
  expect(bypass).not.toBe(source);
  expect(postAgentGitContextContractIssues(bypass).length).toBeGreaterThan(0);
});

test("delivery refuses an otherwise successful run with missing usage", async () => {
  const source = await Bun.file(path).text();
  expect(requiredUsageBeforeDeliveryContractIssues(source)).toEqual([]);

  const bypass = source.replace(
    "report.usage = requireRecordedUsage(report.usage);",
    "report.usage = report.usage;",
  );
  expect(bypass).not.toBe(source);
  expect(requiredUsageBeforeDeliveryContractIssues(bypass)).toContain(
    "recorded backend usage must be required before delivery",
  );
});

test("active-ready workflow defers issue resolution to launcher continuation", async () => {
  const source = await Bun.file(path).text();
  expect(latestOpenClosureContractIssues(source)).toEqual([]);
  const premature = source.replace(
    `report.stopReason = "active-ready";`,
    `await resolveAllOpenIssuesForProvingRun();\n    report.stopReason = "active-ready";`,
  );
  expect(premature).not.toBe(source);
  expect(latestOpenClosureContractIssues(premature)).toContain(
    "workflow must defer all issue resolution to launcher terminal commit",
  );
});

test("workflow report binds live artifacts to the successful preflight digest", async () => {
  const source = await Bun.file(path).text();
  expect(preflightDigestEvidenceContractIssues(source)).toEqual([]);

  const bypass = source.replace(
    "preflight.artifactDigest !== report.artifactDigest",
    "false",
  );
  expect(bypass).not.toBe(source);
  expect(preflightDigestEvidenceContractIssues(bypass).length).toBeGreaterThan(0);

  const droppedRunId = source.replace(
    "    report.preflightRunId = preflight.runId;\n",
    "",
  );
  expect(droppedRunId).not.toBe(source);
  expect(preflightDigestEvidenceContractIssues(droppedRunId).length).toBeGreaterThan(0);

  const rejectedDistinctRunId = source.replace(
    "    report.preflightRunId = preflight.runId;",
    [
      "    report.preflightRunId = preflight.runId;",
      "    if (preflight.runId !== runId) throw new Error(\"preflight run mismatch\");",
    ].join("\n"),
  );
  expect(rejectedDistinctRunId).not.toBe(source);
  expect(
    preflightDigestEvidenceContractIssues(rejectedDistinctRunId).length,
  ).toBeGreaterThan(0);
});

test("active ready proof locks one non-draft PR head before record publication", async () => {
  const source = await Bun.file(path).text();
  const identity: PullRequestIdentity = {
    repository: "example/project",
    branch: "orca/active-ready",
    headSha: "a".repeat(40),
  };
  const prUrl = "https://github.com/example/project/pull/42";
  const commands: ReadyProofCommand[] = [];
  const readyHead = {
    url: prUrl,
    baseRefName: "main",
    headRefName: identity.branch,
    headRefOid: identity.headSha,
    isDraft: false,
  };
  const assertHead = loadAssertPullRequestHeadBounded(source, async (command) => {
    commands.push(command);
    return { stdout: JSON.stringify(readyHead) };
  });

  await assertHead(prUrl, identity, 1_234);
  expect(commands).toEqual([
    {
      command: "gh",
      args: [
        "pr",
        "view",
        prUrl,
        "--json",
        "url,baseRefName,headRefName,headRefOid,isDraft",
      ],
      timeoutMs: 1_234,
    },
  ]);

  for (const head of [
    { ...readyHead, isDraft: true },
    { ...readyHead, headRefOid: "b".repeat(40) },
  ]) {
    const reject = loadAssertPullRequestHeadBounded(source, async () => ({
      stdout: JSON.stringify(head),
    }));
    await expect(reject(prUrl, identity, 1_234)).rejects.toThrow();
  }

  const recordPublication = source.indexOf(
    "deliveryRecord = DeliveryRecordSchema.parse(",
  );
  const readyProof = source.indexOf(
    "await assertPullRequestHead(prUrl, pullRequestIdentity);",
  );
  const activeSuccess = source.indexOf('report.activeStatus = "ready";');
  const finalization = source.indexOf("const finalizerErrors = await finalizeWorkflowEvidence({");
  const betweenProofAndFinalization = source.slice(readyProof, finalization);

  expect(recordPublication).toBeGreaterThan(readyProof);
  expect(activeSuccess).toBeGreaterThan(recordPublication);
  expect(betweenProofAndFinalization).not.toContain('runRequired("gh"');
  expect(betweenProofAndFinalization).not.toContain("command().run({");
  expect(source).not.toContain('enter("remote-checks");');
  expect(source).not.toContain('enter("merge");');
  expect(source).toContain("delivery.json");
});

type DeliveryContinuation = (
  rawRecord: string,
  dependencies: {
    readonly deadlineAtMs?: number;
    readonly now: () => number;
    readonly readProtection: (remainingMs: number) => Promise<{
      readonly valid: boolean;
      readonly log: Record<string, unknown>;
    }>;
    readonly readChecks: (remainingMs: number) => Promise<{
      readonly state: "pending" | "passed" | "failed";
      readonly log: Record<string, unknown>;
    }>;
    readonly readPullRequest: (
      phase: "ready" | "merged",
      remainingMs: number,
    ) => Promise<{
      readonly pr: Record<string, unknown>;
      readonly log: Record<string, unknown>;
    }>;
    readonly merge: (
      lockedHeadSha: string,
      remainingMs: number,
    ) => Promise<Record<string, unknown>>;
    readonly requireActiveReadyReport: (
      record: Record<string, unknown>,
    ) => Promise<void>;
    readonly persist: (
      record: Record<string, unknown>,
      persistenceDeadlineAtMs?: number,
    ) => Promise<void>;
  },
) => Promise<{
  readonly status: "pending" | "blocked" | "delivered";
  readonly exitCode: 0 | 1 | 75;
  readonly record: Record<string, unknown>;
}>;

function loadDeliveryContinuation(source: string): DeliveryContinuation | undefined {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = functionDeclarationsNamed(
    sourceFile,
    "runDeliveryContinuation",
  )[0];
  if (declaration === undefined) return undefined;
  const emitted = ts.transpileModule(declaration.getText(sourceFile), {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded: unknown = runInNewContext(
    `${emitted}\nrunDeliveryContinuation;`,
    {
      assertMergedPullRequestState,
      assertReadyPullRequestHead,
      DELIVERY_CONTINUATION_DEADLINE_MS: 1_800_000,
      DeliveryRecordSchema,
      remoteCheckState,
    },
  );
  return typeof loaded === "function" ? (loaded as DeliveryContinuation) : undefined;
}

function deliveryRecordFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const runId = "20260720-123";
  return {
    version: 1,
    runId,
    repository: "example/project",
    prUrl: "https://github.com/example/project/pull/42",
    branch: `orca/improve-${runId}`,
    baseRefName: "main",
    lockedHeadSha: "a".repeat(40),
    active: {
      profile: "simple",
      startedAtMs: 1,
      readyAtMs: 2,
      elapsedMs: 1,
      activeDeadlineAtMs: 600_000,
      verification: [],
    },
    delivery: { status: "pending", attempts: [] },
    ...overrides,
  };
}

function deliveryCommand(command: string): Record<string, unknown> {
  return {
    command,
    status: "passed",
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 1,
  };
}

function readyDeliveryPr(headSha = "a".repeat(40)): Record<string, unknown> {
  return {
    url: "https://github.com/example/project/pull/42",
    baseRefName: "main",
    headRefName: "orca/improve-20260720-123",
    headRefOid: headSha,
    isDraft: false,
  };
}

type DeliveryRecordPersistence = (
  destination: string,
  record: Record<string, unknown>,
  deadlineAtMs?: number,
) => Promise<void>;

type DeliveryContinuationDeadlineParser = (value: string, startedAtMs: number) => number;

function loadDeliveryContinuationDeadlineParser(
  source: string,
): DeliveryContinuationDeadlineParser | undefined {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = functionDeclarationsNamed(
    sourceFile,
    "parseDeliveryContinuationDeadlineAtMs",
  )[0];
  if (declaration === undefined) return undefined;
  const emitted = ts.transpileModule(declaration.getText(sourceFile), {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded: unknown = runInNewContext(
    `${emitted}\nparseDeliveryContinuationDeadlineAtMs;`,
    { DELIVERY_CONTINUATION_DEADLINE_MS: 1_800_000 },
  );
  return typeof loaded === "function" ? (loaded as DeliveryContinuationDeadlineParser) : undefined;
}

function loadDeliveryRecordPersistence(
  source: string,
  bindings: Record<string, unknown>,
): DeliveryRecordPersistence | undefined {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = [
    "isErrnoCode",
    "acquireDeliveryRecordLock",
    "mergeDeliveryAttempt",
    "persistDeliveryRecordAtomically",
  ].map((name) => functionDeclarationsNamed(sourceFile, name)[0]);
  if (declarations.some((declaration) => declaration === undefined)) return undefined;
  const emitted = ts.transpileModule(
    declarations.map((declaration) => declaration!.getText(sourceFile)).join("\n"),
    {
      compilerOptions: {
        module: ts.ModuleKind.None,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const loaded: unknown = runInNewContext(
    `${emitted}\npersistDeliveryRecordAtomically;`,
    {
      DeliveryRecordSchema,
      Date,
      Error,
      JSON,
      process: { pid: 42 },
      setTimeout,
      ...bindings,
    },
  );
  return typeof loaded === "function" ? (loaded as DeliveryRecordPersistence) : undefined;
}

test("delivery continuation only merges a freshly locked ready PR", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  const events: string[] = [];
  const persisted: Record<string, unknown>[] = [];
  const fakeGh = {
    async readPullRequest(phase: "ready" | "merged") {
      events.push(phase === "ready" ? "pr-identity" : "merged-identity");
      return {
        pr: phase === "ready" ? readyDeliveryPr() : { ...readyDeliveryPr(), state: "MERGED" },
        log: deliveryCommand(`gh pr view ${phase}`),
      };
    },
    async readChecks() {
      events.push("checks");
      return { state: "passed" as const, log: deliveryCommand("gh pr checks") };
    },
    async readProtection() {
      events.push("protection");
      return { valid: true, log: deliveryCommand("gh api protection") };
    },
    async merge(lockedHeadSha: string) {
      events.push(`merge:${lockedHeadSha}`);
      return deliveryCommand(`gh pr merge --squash --match-head-commit ${lockedHeadSha}`);
    },
  };
  const result = await continuation(JSON.stringify(deliveryRecordFixture()), {
    now: () => 10,
    requireActiveReadyReport: async () => {},
    readProtection: async () => await fakeGh.readProtection(),
    readChecks: async () => await fakeGh.readChecks(),
    readPullRequest: async (phase) => await fakeGh.readPullRequest(phase),
    merge: async (lockedHeadSha) => await fakeGh.merge(lockedHeadSha),
    persist: async (record) => {
      events.push("persist");
      persisted.push(record);
    },
  });

  expect(result.status).toBe("delivered");
  expect(result.exitCode).toBe(0);
  expect(events).toEqual([
    "pr-identity",
    "checks",
    "protection",
    "checks",
    "pr-identity",
    `merge:${"a".repeat(40)}`,
    "merged-identity",
    "persist",
  ]);
  expect(persisted).toHaveLength(1);
});

test("delivery pending at its exact deadline records pending without a merge", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  const events: string[] = [];
  let now = 0;
  const result = await continuation(JSON.stringify(deliveryRecordFixture()), {
    now: () => now,
    requireActiveReadyReport: async () => {},
    readProtection: async () => {
      events.push("protection");
      return { valid: true, log: deliveryCommand("gh api protection") };
    },
    readChecks: async () => {
      events.push("checks");
      now = 1_800_000;
      return { state: "pending", log: deliveryCommand("gh pr checks") };
    },
    readPullRequest: async () => {
      events.push("pr-identity");
      return { pr: readyDeliveryPr(), log: deliveryCommand("gh pr view") };
    },
    merge: async () => {
      events.push("merge");
      return deliveryCommand("gh pr merge");
    },
    persist: async (record) => {
      events.push("persist");
      expect(record.lockedHeadSha).toBe("a".repeat(40));
    },
  });

  expect(result).toMatchObject({ status: "pending", exitCode: 75 });
  expect(events).toEqual(["pr-identity", "checks", "persist"]);
});

test("delivery terminal reruns return their existing record without commands or persistence", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  for (const status of ["delivered", "blocked"] as const) {
    const record = deliveryRecordFixture({
      delivery: {
        status,
        attempts: [{ startedAtMs: 1, finishedAtMs: 2, status }],
      },
    });
    const events: string[] = [];
    const result = await continuation(JSON.stringify(record), {
      now: () => 10,
      requireActiveReadyReport: async () => {},
      readProtection: async () => {
        events.push("protection");
        return { valid: true, log: deliveryCommand("protection") };
      },
      readChecks: async () => {
        events.push("checks");
        return { state: "passed" as const, log: deliveryCommand("checks") };
      },
      readPullRequest: async () => {
        events.push("pr");
        return { pr: readyDeliveryPr(), log: deliveryCommand("pr") };
      },
      merge: async () => {
        events.push("merge");
        return deliveryCommand("merge");
      },
      persist: async () => {
        events.push("persist");
      },
    });

    expect(result.status).toBe(status);
    expect(result.exitCode).toBe(status === "delivered" ? 0 : 1);
    expect(result.record).toEqual(record);
    expect(events).toEqual([]);
  }
});

test("delivery continuation writes blocked and exits nonzero for failed checks and identity drift", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  for (const scenario of ["failed-checks", "head-drift"] as const) {
    const events: string[] = [];
    const result = await continuation(JSON.stringify(deliveryRecordFixture()), {
      now: () => 10,
      requireActiveReadyReport: async () => {},
      readProtection: async () => {
        events.push("protection");
        return { valid: true, log: deliveryCommand("gh api protection") };
      },
      readChecks: async () => {
        events.push("checks");
        return {
          state: scenario === "failed-checks" ? "failed" : "passed",
          log: deliveryCommand("gh pr checks"),
        };
      },
      readPullRequest: async () => {
        events.push("pr-identity");
        return {
          pr: readyDeliveryPr(scenario === "head-drift" ? "b".repeat(40) : undefined),
          log: deliveryCommand("gh pr view"),
        };
      },
      merge: async () => {
        events.push("merge");
        return deliveryCommand("gh pr merge");
      },
      persist: async () => {
        events.push("persist");
      },
    });
    expect(result).toMatchObject({ status: "blocked", exitCode: 1 });
    expect(events).toContain("persist");
    expect(events).not.toContain("merge");
  }
});

test("delivery continuation persists one blocked base-mismatch attempt without a merge", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  const persisted: Record<string, unknown>[] = [];
  const result = await continuation(JSON.stringify(deliveryRecordFixture()), {
    now: () => 10,
    requireActiveReadyReport: async () => {},
    readProtection: async () => ({ valid: true, log: deliveryCommand("protection") }),
    readChecks: async () => ({ state: "passed", log: deliveryCommand("checks") }),
    readPullRequest: async () => ({
      pr: { ...readyDeliveryPr(), baseRefName: "release" },
      log: deliveryCommand("pr"),
    }),
    merge: async () => {
      throw new Error("merge must not run");
    },
    persist: async (record) => {
      persisted.push(record);
    },
  });

  expect(result).toMatchObject({ status: "blocked", exitCode: 1 });
  expect(persisted).toHaveLength(1);
  expect(persisted[0]?.delivery).toMatchObject({
    status: "blocked",
    attempts: [{ status: "blocked" }],
  });
  expect(persisted[0]?.delivery.attempts[0]?.pr).toBeUndefined();
  expect(persisted[0]?.delivery.attempts[0]?.checks).toEqual([
    deliveryCommand("pr"),
  ]);
});

test("delivery continuation preserves retryable pending evidence at its deadline", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  const persisted: Record<string, unknown>[] = [];
  const result = await continuation(JSON.stringify(deliveryRecordFixture()), {
    deadlineAtMs: 0,
    now: () => 0,
    requireActiveReadyReport: async () => {},
    readProtection: async () => {
      throw new Error("deadline must stop before protection");
    },
    readChecks: async () => {
      throw new Error("deadline must stop before checks");
    },
    readPullRequest: async () => {
      throw new Error("deadline must stop before PR identity");
    },
    merge: async () => {
      throw new Error("deadline must stop before merge");
    },
    persist: async (record) => {
      persisted.push(record);
    },
  });

  expect(result).toMatchObject({ status: "pending", exitCode: 75 });
  expect(persisted).toHaveLength(1);
  expect(persisted[0]?.delivery).toMatchObject({
    status: "pending",
    attempts: [{ status: "pending" }],
  });
});

test("delivery continuation blocks every initial ready-identity mismatch before merge", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  const mismatches = [
    { name: "draft", pr: { ...readyDeliveryPr(), isDraft: true } },
    { name: "branch", pr: { ...readyDeliveryPr(), headRefName: "other-branch" } },
    { name: "repository", pr: { ...readyDeliveryPr(), url: "https://github.com/other/project/pull/42" } },
    { name: "head", pr: readyDeliveryPr("b".repeat(40)) },
  ];
  for (const mismatch of mismatches) {
    const persisted: Record<string, unknown>[] = [];
    let mergeCalls = 0;
    const result = await continuation(JSON.stringify(deliveryRecordFixture()), {
      now: () => 10,
      requireActiveReadyReport: async () => {},
      readProtection: async () => ({ valid: true, log: deliveryCommand("protection") }),
      readChecks: async () => ({ state: "passed", log: deliveryCommand("checks") }),
      readPullRequest: async () => ({ pr: mismatch.pr, log: deliveryCommand("pr") }),
      merge: async () => {
        mergeCalls += 1;
        return deliveryCommand("merge");
      },
      persist: async (record) => {
        persisted.push(record);
      },
    });
    expect(result.status, mismatch.name).toBe("blocked");
    expect(result.exitCode, mismatch.name).toBe(1);
    expect(persisted, mismatch.name).toHaveLength(1);
    expect(mergeCalls, mismatch.name).toBe(0);
  }
});

test("delivery continuation blocks every post-green reread drift before merge", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  for (const scenario of ["protection", "fresh-checks", "fresh-identity"] as const) {
    const events: string[] = [];
    let checkReads = 0;
    let readyReads = 0;
    const result = await continuation(JSON.stringify(deliveryRecordFixture()), {
      now: () => 10,
      requireActiveReadyReport: async () => {},
      readProtection: async () => {
        events.push("protection");
        return {
          valid: scenario !== "protection",
          log: deliveryCommand("protection"),
        };
      },
      readChecks: async () => {
        checkReads += 1;
        events.push("checks");
        return {
          state: scenario === "fresh-checks" && checkReads === 2 ? "failed" : "passed",
          log: deliveryCommand("checks"),
        };
      },
      readPullRequest: async () => {
        readyReads += 1;
        events.push("pr-identity");
        return {
          pr:
            scenario === "fresh-identity" && readyReads === 2
              ? readyDeliveryPr("b".repeat(40))
              : readyDeliveryPr(),
          log: deliveryCommand("pr"),
        };
      },
      merge: async () => {
        events.push("merge");
        return deliveryCommand("merge");
      },
      persist: async () => {
        events.push("persist");
      },
    });
    expect(result.status, scenario).toBe("blocked");
    expect(result.exitCode, scenario).toBe(1);
    expect(events, scenario).toContain("persist");
    expect(events, scenario).not.toContain("merge");
  }
});

test("delivery record persistence serializes concurrent attempts without loss", async () => {
  const source = await Bun.file(path).text();
  const destination = "/tmp/delivery.json";
  const files = new Map<string, string>([
    [destination, JSON.stringify(deliveryRecordFixture())],
  ]);
  let lockHeld = false;
  let firstWriteStarted: (() => void) | undefined;
  let releaseFirstWrite: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => {
    firstWriteStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let writes = 0;
  const persistence = loadDeliveryRecordPersistence(source, {
    mkdir: async () => {
      if (!lockHeld) {
        lockHeld = true;
        return;
      }
      const error = Object.assign(new Error("lock exists"), { code: "EEXIST" });
      throw error;
    },
    readFile: async (file: string) => files.get(file) ?? "",
    rename: async (from: string, to: string) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`missing temporary record ${from}`);
      files.set(to, value);
    },
    rm: async () => {
      lockHeld = false;
    },
    writeFile: async (file: string, value: string) => {
      writes += 1;
      if (writes === 1) {
        firstWriteStarted?.();
        await release;
      }
      files.set(file, value);
    },
  });
  expect(persistence).toBeFunction();
  if (persistence === undefined) return;

  const pending = DeliveryRecordSchema.parse({
    ...deliveryRecordFixture(),
    delivery: {
      status: "pending",
      attempts: [{ startedAtMs: 10, finishedAtMs: 11, status: "pending" }],
    },
  });
  const blocked = DeliveryRecordSchema.parse({
    ...deliveryRecordFixture(),
    delivery: {
      status: "blocked",
      attempts: [{ startedAtMs: 20, finishedAtMs: 21, status: "blocked" }],
    },
  });
  const first = persistence(destination, pending);
  await firstWrite;
  const second = persistence(destination, blocked);
  if (releaseFirstWrite === undefined) throw new Error("first writer did not block");
  releaseFirstWrite();
  await Promise.all([first, second]);

  const persisted = files.get(destination);
  expect(persisted).toBeDefined();
  if (persisted === undefined) return;
  const attempts = DeliveryRecordSchema.parse(JSON.parse(persisted)).delivery.attempts;
  expect(attempts.map((attempt) => attempt.startedAtMs).sort((left, right) => left - right)).toEqual([
    10,
    20,
  ]);
  expect(DeliveryRecordSchema.parse(JSON.parse(persisted)).delivery.status).toBe(
    "blocked",
  );
});

test("delivery record persistence leaves an already terminal record byte-equivalent", async () => {
  const source = await Bun.file(path).text();
  const destination = "/tmp/delivery-terminal.json";
  const terminal = DeliveryRecordSchema.parse({
    ...deliveryRecordFixture(),
    delivery: {
      status: "delivered",
      attempts: [{ startedAtMs: 1, finishedAtMs: 2, status: "delivered" }],
    },
  });
  const files = new Map<string, string>([[destination, JSON.stringify(terminal)]]);
  const persistence = loadDeliveryRecordPersistence(source, {
    mkdir: async () => undefined,
    readFile: async (file: string) => files.get(file) ?? "",
    rename: async (from: string, to: string) => {
      files.set(to, files.get(from) ?? "");
    },
    rm: async () => undefined,
    writeFile: async (file: string, value: string) => {
      files.set(file, value);
    },
  });
  expect(persistence).toBeFunction();
  if (persistence === undefined) return;

  await persistence(
    destination,
    DeliveryRecordSchema.parse({
      ...deliveryRecordFixture(),
      delivery: {
        status: "blocked",
        attempts: [{ startedAtMs: 3, finishedAtMs: 4, status: "blocked" }],
      },
    }),
  );

  expect(files.get(destination)).toBe(JSON.stringify(terminal));
});

test("delivery record persistence ignores an incomplete next attempt after terminal delivery", async () => {
  const source = await Bun.file(path).text();
  const destination = "/tmp/delivery-terminal-incomplete-next.json";
  const terminal = DeliveryRecordSchema.parse({
    ...deliveryRecordFixture(),
    delivery: {
      status: "delivered",
      attempts: [{ startedAtMs: 1, finishedAtMs: 2, status: "delivered" }],
    },
  });
  const files = new Map<string, string>([[destination, JSON.stringify(terminal)]]);
  const persistence = loadDeliveryRecordPersistence(source, {
    mkdir: async () => undefined,
    readFile: async (file: string) => files.get(file) ?? "",
    rename: async (from: string, to: string) => {
      files.set(to, files.get(from) ?? "");
    },
    rm: async () => undefined,
    writeFile: async (file: string, value: string) => {
      files.set(file, value);
    },
  });
  expect(persistence).toBeFunction();
  if (persistence === undefined) return;

  await persistence(
    destination,
    DeliveryRecordSchema.parse({
      ...deliveryRecordFixture(),
      delivery: { status: "pending", attempts: [] },
    }),
  );

  expect(files.get(destination)).toBe(JSON.stringify(terminal));
});

test("delivery continuation holds one record lock across reread, run, persistence, and release", async () => {
  const source = await Bun.file(path).text();
  const lock = source.indexOf("const deliveryLock = await acquireDeliveryRecordLock(");
  const read = source.indexOf("const rawRecord = await readFile(deliveryRecordPath, \"utf8\");");
  const run = source.indexOf("const outcome = await runDeliveryContinuation(rawRecord, {");
  const persist = source.indexOf("deliveryLock,\n          );", run);
  const release = source.indexOf(
    "await rm(deliveryLock, { recursive: true, force: true });",
  );

  expect(lock).toBeGreaterThan(-1);
  expect(read).toBeGreaterThan(lock);
  expect(run).toBeGreaterThan(read);
  expect(persist).toBeGreaterThan(run);
  expect(release).toBeGreaterThan(persist);
});

test("delivery continuation accepts an already elapsed positive absolute deadline", async () => {
  const source = await Bun.file(path).text();
  const parseDeadline = loadDeliveryContinuationDeadlineParser(source);
  expect(parseDeadline).toBeFunction();
  if (parseDeadline === undefined) return;

  expect(parseDeadline("100", 101)).toBe(100);
});

test("delivery record persistence acquires a fresh lock at its continuation deadline", async () => {
  const source = await Bun.file(path).text();
  const destination = "/tmp/delivery.json";
  const files = new Map<string, string>([[destination, JSON.stringify(deliveryRecordFixture())]]);
  let mkdirCalls = 0;
  const persistence = loadDeliveryRecordPersistence(source, {
    Date: { now: () => 1 },
    mkdir: async () => {
      mkdirCalls += 1;
    },
    readFile: async (file: string) => files.get(file) ?? "",
    rename: async (from: string, to: string) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    rm: async () => undefined,
    writeFile: async (file: string, value: string) => {
      files.set(file, value);
    },
  });
  expect(persistence).toBeFunction();
  if (persistence === undefined) return;

  const pending = DeliveryRecordSchema.parse({
    ...deliveryRecordFixture(),
    delivery: {
      status: "pending",
      attempts: [{ startedAtMs: 1, finishedAtMs: 1, status: "pending" }],
    },
  });
  await persistence(destination, pending, 1);

  expect(mkdirCalls).toBe(1);
  expect(DeliveryRecordSchema.parse(JSON.parse(files.get(destination) ?? "")).delivery).toMatchObject({
    status: "pending",
    attempts: [{ status: "pending" }],
  });
});

test("delivery record persistence does not reacquire a released stale lock after its deadline", async () => {
  const source = await Bun.file(path).text();
  const destination = "/tmp/delivery.json";
  const files = new Map<string, string>([[destination, JSON.stringify(deliveryRecordFixture())]]);
  let now = 0;
  let mkdirCalls = 0;
  const persistence = loadDeliveryRecordPersistence(source, {
    Date: { now: () => now },
    mkdir: async () => {
      mkdirCalls += 1;
      if (mkdirCalls === 1) throw Object.assign(new Error("lock exists"), { code: "EEXIST" });
    },
    readFile: async (file: string) => files.get(file) ?? "",
    rename: async (from: string, to: string) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    rm: async () => undefined,
    setTimeout: (resolve: () => void) => {
      now = 1;
      resolve();
    },
    writeFile: async (file: string, value: string) => {
      files.set(file, value);
    },
  });
  expect(persistence).toBeFunction();
  if (persistence === undefined) return;

  await expect(
    persistence(destination, deliveryRecordFixture(), 1),
  ).rejects.toThrow("delivery record lock wait exceeded continuation deadline");
  expect(mkdirCalls).toBe(1);
});

test("delivery record persistence bounds a stale lock by the continuation deadline", async () => {
  const source = await Bun.file(path).text();
  let now = 0;
  const persistence = loadDeliveryRecordPersistence(source, {
    Date: { now: () => now++ },
    mkdir: async () => {
      throw Object.assign(new Error("lock exists"), { code: "EEXIST" });
    },
    setTimeout: () => {
      throw new Error("unbounded lock retry");
    },
  });
  expect(persistence).toBeFunction();
  if (persistence === undefined) return;

  await expect(
    persistence("/tmp/delivery.json", deliveryRecordFixture(), 1),
  ).rejects.toThrow("delivery record lock wait exceeded continuation deadline");
});

test("delivery continuation defensively rejects an unknown delivery record field", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  await expect(
    continuation(JSON.stringify(deliveryRecordFixture({ unexpected: true })), {
      now: () => 0,
      requireActiveReadyReport: async () => {},
      readProtection: async () => ({ valid: true, log: deliveryCommand("protection") }),
      readChecks: async () => ({ state: "passed", log: deliveryCommand("checks") }),
      readPullRequest: async () => ({ pr: readyDeliveryPr(), log: deliveryCommand("pr") }),
      merge: async () => deliveryCommand("merge"),
      persist: async () => {},
    }),
  ).rejects.toThrow();
});

test("scout validates no_candidate citations before preserving zero-candidate evidence", async () => {
  const source = await Bun.file(path).text();
  const validatorStart = source.indexOf("const validateScopedCandidate = (");
  const fanoutStart = source.indexOf("const fanout = await runScopedScoutFanout", validatorStart);
  expect(validatorStart).toBeGreaterThan(-1);
  expect(fanoutStart).toBeGreaterThan(validatorStart);
  const validator = source.slice(validatorStart, fanoutStart);

  expect(validator).toContain(
    "validateScopedScoutResult(value, pair, packet, profile)",
  );
  expect(validator).not.toContain('if (value.status !== "candidate") return [];');
});

test("scout starts its validation allocation before every scope finalization write", async () => {
  const source = await Bun.file(path).text();
  const fanout = source.indexOf("const fanout = await runScopedScoutFanout<ScopedScoutResult>({");
  const validationDeadline = source.indexOf(
    "const validationDeadlineMs = Date.now() + SCOUT_VALIDATION_LIMIT_MS;",
  );
  const finalization = source.indexOf("const scopedResult = await finalizeScopedScoutRecords({");

  expect(fanout).toBeGreaterThan(-1);
  expect(validationDeadline).toBeGreaterThan(fanout);
  expect(finalization).toBeGreaterThan(validationDeadline);
  const finalizationSlice = source.slice(validationDeadline, finalization + 2_500);
  expect(finalizationSlice).toContain("validationRemaining");
  expect(finalizationSlice).toContain("awaitWithinDeadline(");
});

test("delivery blocks a pending record when active-ready report proof fails", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  const events: string[] = [];
  const result = await continuation(JSON.stringify(deliveryRecordFixture()), {
    now: () => 10,
    requireActiveReadyReport: async () => {
      events.push("report-proof");
      throw new Error("active finalization failed");
    },
    readProtection: async () => {
      events.push("protection");
      return { valid: true, log: deliveryCommand("protection") };
    },
    readChecks: async () => {
      events.push("checks");
      return { state: "passed" as const, log: deliveryCommand("checks") };
    },
    readPullRequest: async () => {
      events.push("pr");
      return { pr: readyDeliveryPr(), log: deliveryCommand("pr") };
    },
    merge: async () => {
      events.push("merge");
      return deliveryCommand("merge");
    },
    persist: async (record) => {
      events.push(`persist:${String((record.delivery as { status: string }).status)}`);
    },
  });

  expect(result).toMatchObject({ status: "blocked", exitCode: 1 });
  expect(events).toEqual(["report-proof", "persist:blocked"]);
});

test("delivery preloads report evidence and persists its blocked mirror after proof failure", async () => {
  const source = await Bun.file(path).text();
  const reportRead = source.indexOf(
    'const activeReadyReport = await readFile(deliveryReportPath, "utf8");',
  );
  const continuation = source.indexOf("const outcome = await runDeliveryContinuation(rawRecord, {");
  const proof = source.indexOf("assertActiveReadyDeliveryReport(", continuation);
  const recordPersistence = source.indexOf("await persistDeliveryRecordAtomically(", continuation);
  const reportPersistence = source.indexOf("await persistDeliveryReportEvidence(", continuation);

  expect(reportRead).toBeGreaterThan(-1);
  expect(continuation).toBeGreaterThan(reportRead);
  expect(proof).toBeGreaterThan(continuation);
  expect(recordPersistence).toBeGreaterThan(proof);
  expect(reportPersistence).toBeGreaterThan(recordPersistence);
  expect(source.slice(recordPersistence, reportPersistence)).not.toContain(
    "activeReadyReport !== undefined",
  );
});

test("delivery blocks before remote reads when active-ready proof dependency is unavailable", async () => {
  const source = await Bun.file(path).text();
  const continuation = loadDeliveryContinuation(source);
  expect(continuation).toBeFunction();
  if (continuation === undefined) return;

  const events: string[] = [];
  const result = await continuation(JSON.stringify(deliveryRecordFixture()), {
    now: () => 10,
    readProtection: async () => {
      events.push("protection");
      return { valid: true, log: deliveryCommand("protection") };
    },
    readChecks: async () => {
      events.push("checks");
      return { state: "passed" as const, log: deliveryCommand("checks") };
    },
    readPullRequest: async () => {
      events.push("pr");
      return { pr: readyDeliveryPr(), log: deliveryCommand("pr") };
    },
    merge: async () => {
      events.push("merge");
      return deliveryCommand("merge");
    },
    persist: async (record) => {
      events.push(`persist:${String((record.delivery as { status: string }).status)}`);
    },
  });

  expect(source).toContain(
    "readonly requireActiveReadyReport: (record: DeliveryRecordV1) => Promise<void>;",
  );
  expect(source).not.toContain("requireActiveReadyReport?:");
  expect(result).toMatchObject({ status: "blocked", exitCode: 1 });
  expect(events).toEqual(["persist:blocked"]);
});

function loadDeliveryReportEvidenceRenderer(
  source: string,
): ((rawReport: string, record: Record<string, unknown>, deliveryRecordPath: string) => string) | undefined {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations = [
    "parseDeliveryReportEvidence",
    "renderDeliveryReportEvidence",
  ].map((name) => functionDeclarationsNamed(sourceFile, name)[0]);
  if (declarations.some((declaration) => declaration === undefined)) return undefined;
  const emitted = ts.transpileModule(
    declarations.map((declaration) => declaration!.getText(sourceFile)).join("\n"),
    {
      compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const loaded: unknown = runInNewContext(
    `${emitted}\nrenderDeliveryReportEvidence;`,
    { Error, JSON },
  );
  return typeof loaded === "function"
    ? (loaded as (rawReport: string, record: Record<string, unknown>, deliveryRecordPath: string) => string)
    : undefined;
}

test("delivery report evidence preserves immutable identity while mirroring terminal status", async () => {
  const source = await Bun.file(path).text();
  const render = loadDeliveryReportEvidenceRenderer(source);
  expect(render).toBeFunction();
  if (render === undefined) return;

  const record = deliveryRecordFixture();
  const report = {
    runId: record.runId,
    profile: "simple",
    repository: record.repository,
    prUrl: record.prUrl,
    branch: record.branch,
    matchedHeadSha: record.lockedHeadSha,
    deliveryRecordPath: ".orca/improvement-loop/runs/20260720-123/delivery.json",
    activeStatus: "ready",
    deliveryStatus: "pending",
    sla: "passed",
  };
  const blocked = deliveryRecordFixture({
    delivery: { status: "blocked", attempts: [] },
  });
  const absoluteDeliveryRecordPath = `/tmp/worktree/${String(report.deliveryRecordPath)}`;
  const rendered = JSON.parse(
    render(
      JSON.stringify(report),
      blocked,
      absoluteDeliveryRecordPath,
    ),
  ) as Record<string, unknown>;

  expect(rendered).toMatchObject({
    ...report,
    deliveryStatus: "blocked",
  });
  await expect(Promise.resolve().then(() =>
    render(
      JSON.stringify({ ...report, matchedHeadSha: "b".repeat(40) }),
      record,
      absoluteDeliveryRecordPath,
    ),
  )).rejects.toThrow("delivery report locked head SHA does not match record");
});

test("delivery proof preloads a readable report before status validation so blocked delivery mirrors it", async () => {
  const source = await Bun.file(path).text();
  const reportRead = source.indexOf(
    'const activeReadyReport = await readFile(deliveryReportPath, "utf8");',
  );
  const continuation = source.indexOf("const outcome = await runDeliveryContinuation(rawRecord, {");
  const proofStart = source.indexOf("requireActiveReadyReport: (record) => {");
  const proofEnd = source.indexOf("        readProtection:", proofStart);
  expect(reportRead).toBeGreaterThan(-1);
  expect(continuation).toBeGreaterThan(reportRead);
  expect(proofStart).toBeGreaterThan(-1);
  expect(proofEnd).toBeGreaterThan(proofStart);
  const proof = source.slice(proofStart, proofEnd);
  expect(proof).not.toContain("readFile(deliveryReportPath");
  expect(proof).toContain("assertActiveReadyDeliveryReport(\n            activeReadyReport,");
  expect(proof).toContain("return Promise.resolve();");

  const render = loadDeliveryReportEvidenceRenderer(source);
  expect(render).toBeFunction();
  if (render === undefined) return;
  const pending = deliveryRecordFixture();
  const blocked = deliveryRecordFixture({
    delivery: { status: "blocked", attempts: [] },
  });
  const report = JSON.stringify({
    runId: pending.runId,
    profile: "simple",
    repository: pending.repository,
    prUrl: pending.prUrl,
    branch: pending.branch,
    matchedHeadSha: pending.lockedHeadSha,
    deliveryRecordPath: `.orca/improvement-loop/runs/${String(pending.runId)}/delivery.json`,
    activeStatus: "ready",
    deliveryStatus: "pending",
    sla: "passed",
  });
  const persisted = JSON.parse(
    render(
      report,
      blocked,
      `/tmp/worktree/.orca/improvement-loop/runs/${String(pending.runId)}/delivery.json`,
    ),
  ) as Record<string, unknown>;
  expect(persisted.deliveryStatus).toBe("blocked");
});

test("delivery continuation requires active-ready proof before GitHub reads", async () => {
  const source = await Bun.file(path).text();
  const interfaceStart = source.indexOf("interface DeliveryContinuationDependencies {");
  const interfaceEnd = source.indexOf("interface DeliveryContinuationResult", interfaceStart);
  const interfaceText = source.slice(interfaceStart, interfaceEnd);
  expect(interfaceText).toContain("readonly requireActiveReadyReport:");
  expect(interfaceText).not.toContain("readonly requireActiveReadyReport?:");

  const continuationStart = source.indexOf("async function runDeliveryContinuation(");
  const continuationEnd = source.indexOf("function isErrnoCode", continuationStart);
  const continuation = source.slice(continuationStart, continuationEnd);
  expect(continuation).toContain("await dependencies.requireActiveReadyReport(record);");
  expect(continuation).not.toContain("requireActiveReadyReport?.");
});

test("scout scope evidence retains every rendered packet digest", async () => {
  const source = await Bun.file(path).text();
  expect(source).toContain("packetSha256: packet.sha256");
  expect(source).toContain("sha256: packet.sha256");
});
