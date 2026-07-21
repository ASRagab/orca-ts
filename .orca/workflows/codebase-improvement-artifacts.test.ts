import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  rmdir,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as ts from "typescript";
import { WorkflowConfigSchema } from "./codebase-improvement-lib.ts";

function inspectFinalizerHarnessTimeouts(source: string): {
  readonly testCount: number;
  readonly callCount: number;
  readonly expandedRunCount: number;
  readonly longTimeoutTestCount: number;
  readonly longTimeoutScenarioCount: number;
  readonly extendedInnerTimeoutTestCount: number;
  readonly extendedInnerTimeoutScenarioCount: number;
  readonly issues: readonly string[];
} {
  const sourceFile = ts.createSourceFile(
    "codebase-improvement-artifacts.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const issues: string[] = [];
  let testCount = 0;
  let callCount = 0;
  let expandedRunCount = 0;
  let longTimeoutTestCount = 0;
  let longTimeoutScenarioCount = 0;
  let extendedInnerTimeoutTestCount = 0;
  let extendedInnerTimeoutScenarioCount = 0;
  let directHarnessReferenceCount = 0;
  let indirectHarnessReferenceCount = 0;
  let harnessDeclarationCount = 0;
  let topLevelHarnessDeclarationCount = 0;
  let monitorFixtureDeclarationCount = 0;
  let topLevelMonitorFixtureDeclarationCount = 0;
  let indirectMonitorFixtureReferenceCount = 0;
  let evalCallCount = 0;
  const longTimeoutTitle =
    "terminal commit rejects bound evidence mutation after private staging";
  const extendedInnerTimeoutTitle =
    "successful terminal publication rejects an unbound workflow report";
  const defaultInnerTimeoutMs = 10_000;
  const extendedInnerTimeoutMs = 30_000;
  const cleanupReserveMs = 3_000;
  const longTimeoutScenarios = [
    "report",
    "monitor",
    "latest",
    "latest-ledger-claim",
    "latest-proof-claim",
    "latest-projection-claim",
  ] as const;

  const inspectHarnessReferences = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "runFinalizerHarness") {
      const parent = node.parent;
      const isDeclaration =
        ts.isFunctionDeclaration(parent) &&
        parent.name === node;
      if (isDeclaration) {
        harnessDeclarationCount += 1;
        if (ts.isSourceFile(parent.parent)) {
          topLevelHarnessDeclarationCount += 1;
        }
      }
      const isDirectCall =
        ts.isCallExpression(parent) && parent.expression === node;
      if (isDirectCall) {
        directHarnessReferenceCount += 1;
      } else if (!isDeclaration) {
        indirectHarnessReferenceCount += 1;
      }
    }
    if (ts.isIdentifier(node) && node.text === "terminalMonitorFixture") {
      const parent = node.parent;
      const isDeclaration =
        ts.isFunctionDeclaration(parent) && parent.name === node;
      if (isDeclaration) {
        monitorFixtureDeclarationCount += 1;
        if (ts.isSourceFile(parent.parent)) {
          topLevelMonitorFixtureDeclarationCount += 1;
        }
      }
      const isDirectCall =
        ts.isCallExpression(parent) && parent.expression === node;
      if (!isDeclaration && !isDirectCall) {
        indirectMonitorFixtureReferenceCount += 1;
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "eval"
    ) {
      evalCallCount += 1;
    }
    ts.forEachChild(node, inspectHarnessReferences);
  };
  inspectHarnessReferences(sourceFile);

  const staticArrayLength = (
    expression: ts.Expression,
    namedArrays: ReadonlyMap<string, number>,
  ): number | undefined => {
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.length;
    }
    if (
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return staticArrayLength(expression.expression, namedArrays);
    }
    return ts.isIdentifier(expression)
      ? namedArrays.get(expression.text)
      : undefined;
  };

  const inlineArrayLiteral = (
    expression: ts.Expression,
  ): ts.ArrayLiteralExpression | undefined => {
    let current = expression;
    while (
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return ts.isArrayLiteralExpression(current) ? current : undefined;
  };

  const containsDirectHarnessCall = (node: ts.Node): boolean => {
    let found = false;
    const inspect = (candidate: ts.Node): void => {
      if (
        ts.isCallExpression(candidate) &&
        ts.isIdentifier(candidate.expression) &&
        candidate.expression.text === "runFinalizerHarness"
      ) {
        found = true;
        return;
      }
      ts.forEachChild(candidate, inspect);
    };
    inspect(node);
    return found;
  };

  const firstDirectHarnessCall = (
    loop: ts.ForOfStatement,
  ): ts.CallExpression | undefined => {
    if (loop.awaitModifier !== undefined || !ts.isBlock(loop.statement)) {
      return undefined;
    }
    const firstStatement = loop.statement.statements[0];
    if (
      firstStatement === undefined ||
      !ts.isVariableStatement(firstStatement) ||
      firstStatement.declarationList.declarations.length !== 1
    ) {
      return undefined;
    }
    const initializer =
      firstStatement.declarationList.declarations[0]?.initializer;
    if (
      initializer === undefined ||
      !ts.isAwaitExpression(initializer) ||
      !ts.isCallExpression(initializer.expression) ||
      !ts.isIdentifier(initializer.expression.expression) ||
      initializer.expression.expression.text !== "runFinalizerHarness"
    ) {
      return undefined;
    }
    return initializer.expression;
  };

  const invokesHarnessLoopUnconditionally = (
    loop: ts.ForOfStatement,
    callback: ts.Node | undefined,
  ): boolean => {
    if (
      callback === undefined ||
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
      !ts.isBlock(callback.body) ||
      firstDirectHarnessCall(loop) === undefined
    ) {
      return false;
    }
    let current: ts.Node = loop;
    while (current.parent !== callback.body) {
      const parent = current.parent;
      if (
        ts.isBlock(parent) &&
        parent.statements[0] === current
      ) {
        current = parent;
        continue;
      }
      if (
        ts.isTryStatement(parent) &&
        parent.tryBlock === current &&
        parent.catchClause === undefined &&
        parent.finallyBlock !== undefined
      ) {
        let hasReturn = false;
        const inspectFinally = (node: ts.Node): void => {
          if (ts.isReturnStatement(node)) {
            hasReturn = true;
            return;
          }
          ts.forEachChild(node, inspectFinally);
        };
        inspectFinally(parent.finallyBlock);
        if (hasReturn) return false;
        current = parent;
        continue;
      }
      return false;
    }
    const loopStatementIndex = callback.body.statements.indexOf(
      current as ts.Statement,
    );
    if (loopStatementIndex < 0) return false;
    let hasPreLoopReturn = false;
    const inspectPrefix = (node: ts.Node): void => {
      if (ts.isReturnStatement(node)) {
        hasPreLoopReturn = true;
        return;
      }
      if (
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        return;
      }
      ts.forEachChild(node, inspectPrefix);
    };
    for (const statement of callback.body.statements.slice(0, loopStatementIndex)) {
      inspectPrefix(statement);
    }
    if (hasPreLoopReturn) return false;
    if (!ts.isBlock(loop.statement)) return false;
    let hasPostCallExit = false;
    const inspectLoopTail = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) || ts.isBreakStatement(node)) {
        hasPostCallExit = true;
        return;
      }
      if (
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)
      ) {
        return;
      }
      ts.forEachChild(node, inspectLoopTail);
    };
    for (const statement of loop.statement.statements.slice(1)) {
      inspectLoopTail(statement);
    }
    if (hasPostCallExit) return false;
    return true;
  };

  const expectedHarnessLoopBindings = new Map<string, readonly string[]>([
    [
      "preflight supervisor discards private staging after signal or failure",
      ["afterPreflightPublish=outcome"],
    ],
    [
      "terminal commit rejects bound evidence mutation after private staging",
      ["terminalEvidenceMutation=mutation"],
    ],
    [
      "signals or timeout after terminal staging leave no success stage",
      ["afterTerminalStage=scenario.boundary"],
    ],
    [
      "finalization enforces the package-lock existence and SHA contract",
      [
        "packageLock.initial=scenario.initial",
        "packageLock.mutation=scenario.mutation",
      ],
    ],
    [
      "terminal package-lock drift blocks success publication",
      [
        "packageLock.initial=scenario.initial",
        "terminalPackageLockRaceClaim=scenario.mutation",
      ],
    ],
    [
      "successful terminal publication validates monitor identity and outcome",
      ["monitorFiles[0]=monitor"],
    ],
  ]);

  const expectedHarnessCallbackDigests = new Map<string, string>([
    [
      "preflight supervisor discards private staging after signal or failure",
      "cc03e3143febf8b345019a2b16d4b3f827f76199f18d4d81fdf37bf66f7d8d38",
    ],
    [
      "terminal commit rejects bound evidence mutation after private staging",
      "8ee57e39ec09ffbde10ccd03bc31409335248b696455692425a7a3cfef07d927",
    ],
    [
      "signals or timeout after terminal staging leave no success stage",
      "1912b3cbd8fdb9c5c6697f37c118c784c4eb8abd253913ed8d1944e06e554116",
    ],
    [
      "finalizer harness removes its exact root when spawn fails",
      "01f4a6c887dfa1884c19fa995b40eead6d90f988a6787d2d4f7f9f6f3def76b1",
    ],
    [
      "finalizer harness stops its owned process group on timeout",
      "f3f2339310e9d3b807c030c14dff69bb50a0816694afd85e553d275d868ef2f2",
    ],
    [
      "TERM retracts success when every quarantine path is occupied",
      "7a07da373034eaeddf0d92d943dac5ee52780a4ca43fba4de66eabbb6d481128",
    ],
    [
      "INT retracts success when every quarantine path is occupied",
      "158127170ef798876f02b920a0fa8c25990060130e0707f7677f3ad172469e93",
    ],
    [
      "HUP retracts success when every quarantine path is occupied",
      "029d90bb7d5e522f6121038562abfea6a2fe7960d0845c0eee46b338b1842338",
    ],
    [
      "finalization enforces the package-lock existence and SHA contract",
      "dd72f37cf6384247815dac0aa4f9a2f093a0e27ff69bc23cb2b4565e2abf1bc4",
    ],
    [
      "terminal package-lock drift blocks success publication",
      "ea957ad89644c578bfc29ae3d142cab0419622c12e8b9c715a7ea2fb1119815f",
    ],
    [
      "successful terminal publication validates monitor identity and outcome",
      "234e0f651fc812a2abf839947daaa727ab106798daeb47a9fa7a68e6073ea360",
    ],
  ]);

  const expectedHarnessLoopScenarioDigests = new Map<string, string>([
    [
      "preflight supervisor discards private staging after signal or failure",
      "788be804e281a1003c974f9f9ce1210e107f6cf479a260daef81060ba299c9b3",
    ],
    [
      "terminal commit rejects bound evidence mutation after private staging",
      "c2385e302ed4ea8c40d1de0b680ccf792fb04c8fab41efe26dff8e5e3fda50bf",
    ],
    [
      "signals or timeout after terminal staging leave no success stage",
      "185ad005fd3f50e084288effc970f07adc6f0ac47490c0a5918bb42fe7e89fa0",
    ],
    [
      "finalization enforces the package-lock existence and SHA contract",
      "ab10828d5c2a80f9b1deb24f5bdb339c99f8a676cb959489a96151cf3ba5ecef",
    ],
    [
      "terminal package-lock drift blocks success publication",
      "758c03789e26c1d4da9b477d495b6a6847b6464e48fe7722fb5542def3863ad1",
    ],
    [
      "successful terminal publication validates monitor identity and outcome",
      "d3204035db7fbf43b4391937fde91a0561079456e2be808ff23a057860edb0b5",
    ],
  ]);

  const bindsLoopScenarioToHarness = (
    loop: ts.ForOfStatement,
    title: string,
  ): boolean => {
    if (!ts.isVariableDeclarationList(loop.initializer)) return false;
    const bindingNames = new Set<string>();
    const collectBindingNames = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) {
        bindingNames.add(name.text);
        return;
      }
      for (const element of name.elements) {
        if (!ts.isOmittedExpression(element)) collectBindingNames(element.name);
      }
    };
    for (const declaration of loop.initializer.declarations) {
      collectBindingNames(declaration.name);
    }
    const call = firstDirectHarnessCall(loop);
    if (
      call === undefined ||
      bindingNames.size === 0 ||
      call.arguments.length !== 3 ||
      !ts.isIdentifier(call.arguments[0]!) ||
      call.arguments[0]!.text !== "launcher" ||
      !ts.isNumericLiteral(call.arguments[1]!) ||
      Number(call.arguments[1]!.text) !== 0
    ) {
      return false;
    }
    const referencesBinding = (node: ts.Node): boolean => {
      let found = false;
      const inspect = (candidate: ts.Node): void => {
        if (ts.isIdentifier(candidate) && bindingNames.has(candidate.text)) {
          found = true;
          return;
        }
        ts.forEachChild(candidate, inspect);
      };
      inspect(node);
      return found;
    };
    const unwrap = (expression: ts.Expression): ts.Expression => {
      let current = expression;
      while (
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isNonNullExpression(current)
      ) {
        current = current.expression;
      }
      return current;
    };
    const selectorText = (expression: ts.Expression): string | undefined => {
      const current = unwrap(expression);
      if (ts.isIdentifier(current)) {
        return bindingNames.has(current.text) ? current.text : undefined;
      }
      if (!ts.isPropertyAccessExpression(current)) return undefined;
      const base = selectorText(current.expression);
      return base === undefined ? undefined : `${base}.${current.name.text}`;
    };
    const staticPropertyName = (name: ts.PropertyName): string | undefined =>
      ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
        ? name.text
        : undefined;
    const selected: string[] = [];
    const isPureConstant = (expression: ts.Expression): boolean => {
      const current = unwrap(expression);
      if (
        ts.isStringLiteralLike(current) ||
        ts.isNumericLiteral(current) ||
        current.kind === ts.SyntaxKind.TrueKeyword ||
        current.kind === ts.SyntaxKind.FalseKeyword ||
        current.kind === ts.SyntaxKind.NullKeyword
      ) {
        return true;
      }
      if (ts.isIdentifier(current)) return !bindingNames.has(current.text);
      return ts.isTemplateExpression(current)
        ? current.templateSpans.every((span) => isPureConstant(span.expression))
        : false;
    };
    const inspectValue = (
      expression: ts.Expression,
      path: string,
    ): boolean => {
      const current = unwrap(expression);
      const selector = selectorText(current);
      if (selector !== undefined) {
        selected.push(`${path}=${selector}`);
        return true;
      }
      if (ts.isArrayLiteralExpression(current)) {
        for (const [index, element] of current.elements.entries()) {
          if (
            ts.isSpreadElement(element) ||
            !inspectValue(element, `${path}[${String(index)}]`)
          ) {
            return false;
          }
        }
        return true;
      }
      if (ts.isObjectLiteralExpression(current)) {
        const propertyNames = new Set<string>();
        for (const property of current.properties) {
          if (!ts.isPropertyAssignment(property)) return false;
          const name = staticPropertyName(property.name);
          if (name === undefined || propertyNames.has(name)) return false;
          propertyNames.add(name);
          const propertyPath = path === "" ? name : `${path}.${name}`;
          if (!inspectValue(property.initializer, propertyPath)) return false;
        }
        return true;
      }
      return !referencesBinding(current) && isPureConstant(current);
    };
    const options = call.arguments[2];
    const expected = expectedHarnessLoopBindings.get(title);
    return (
      options !== undefined &&
      expected !== undefined &&
      inspectValue(options, "") &&
      selected.sort().join("\n") === [...expected].sort().join("\n")
    );
  };

  const invokesLongTimeoutScenariosUnconditionally = (
    callback: ts.Node | undefined,
  ): boolean => {
    if (
      callback === undefined ||
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
      !ts.isBlock(callback.body)
    ) {
      return false;
    }
    const loops = callback.body.statements.filter(
      (statement): statement is ts.ForOfStatement =>
        ts.isForOfStatement(statement) &&
        containsDirectHarnessCall(statement.statement),
    );
    if (loops.length !== 1) return false;
    const loop = loops[0]!;
    if (!invokesHarnessLoopUnconditionally(loop, callback)) return false;

    let hasSkippingControlFlow = false;
    const inspectControlFlow = (node: ts.Node): void => {
      if (
        ts.isIfStatement(node) ||
        ts.isConditionalExpression(node) ||
        ts.isSwitchStatement(node) ||
        ts.isReturnStatement(node) ||
        ts.isThrowStatement(node) ||
        ts.isBreakStatement(node) ||
        ts.isContinueStatement(node) ||
        ts.isTryStatement(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node) ||
        ts.isLabeledStatement(node)
      ) {
        hasSkippingControlFlow = true;
        return;
      }
      ts.forEachChild(node, inspectControlFlow);
    };
    inspectControlFlow(callback.body);
    return !hasSkippingControlFlow;
  };

  const enumeratesExactLongTimeoutScenarios = (
    callback: ts.Node | undefined,
  ): boolean => {
    if (
      callback === undefined ||
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
      !ts.isBlock(callback.body)
    ) {
      return false;
    }
    const loops = callback.body.statements.filter(
      (statement): statement is ts.ForOfStatement =>
        ts.isForOfStatement(statement) &&
        containsDirectHarnessCall(statement.statement),
    );
    if (loops.length !== 1) return false;

    let expression = loops[0]!.expression;
    while (
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      expression = expression.expression;
    }
    if (!ts.isArrayLiteralExpression(expression)) return false;
    const values = expression.elements.map((element) =>
      ts.isStringLiteralLike(element) ? element.text : undefined,
    );
    return (
      values.length === longTimeoutScenarios.length &&
      values.every(
        (value, index) => value === longTimeoutScenarios[index],
      )
    );
  };

  const bindsLongTimeoutMutationDirectly = (
    callback: ts.Node | undefined,
  ): boolean => {
    if (
      callback === undefined ||
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
      !ts.isBlock(callback.body)
    ) {
      return false;
    }
    const loops = callback.body.statements.filter(
      (statement): statement is ts.ForOfStatement =>
        ts.isForOfStatement(statement) &&
        containsDirectHarnessCall(statement.statement),
    );
    if (loops.length !== 1) return false;
    const loop = loops[0]!;
    if (
      !ts.isVariableDeclarationList(loop.initializer) ||
      loop.initializer.declarations.length !== 1 ||
      !ts.isIdentifier(loop.initializer.declarations[0]!.name) ||
      loop.initializer.declarations[0]!.name.text !== "mutation"
    ) {
      return false;
    }
    const call = firstDirectHarnessCall(loop);
    const options = call?.arguments[2];
    if (options === undefined || !ts.isObjectLiteralExpression(options)) {
      return false;
    }
    const bindings = options.properties.filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
        property.name.text === "terminalEvidenceMutation",
    );
    return (
      bindings.length === 1 &&
      ts.isIdentifier(bindings[0]!.initializer) &&
      bindings[0]!.initializer.text === "mutation"
    );
  };

  const longTimeoutOptionsHaveNoSpreads = (
    callback: ts.Node | undefined,
  ): boolean => {
    if (
      callback === undefined ||
      !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ||
      !ts.isBlock(callback.body)
    ) {
      return false;
    }
    const loops = callback.body.statements.filter(
      (statement): statement is ts.ForOfStatement =>
        ts.isForOfStatement(statement) &&
        containsDirectHarnessCall(statement.statement),
    );
    if (loops.length !== 1) return false;
    const call = firstDirectHarnessCall(loops[0]!);
    const options = call?.arguments[2];
    return (
      options !== undefined &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.every((property) => !ts.isSpreadAssignment(property))
    );
  };

  const harnessTimeoutOption = (
    call: ts.CallExpression,
  ): { readonly valid: boolean; readonly value: number | undefined } => {
    const options = call.arguments[2];
    if (options === undefined) return { valid: true, value: undefined };
    if (!ts.isObjectLiteralExpression(options)) {
      return { valid: false, value: undefined };
    }
    let value: number | undefined;
    for (const property of options.properties) {
      if (ts.isSpreadAssignment(property)) {
        return { valid: false, value: undefined };
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const name =
        ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)
          ? property.name.text
          : undefined;
      if (name !== "timeoutMs") continue;
      if (value !== undefined || !ts.isNumericLiteral(property.initializer)) {
        return { valid: false, value: undefined };
      }
      value = Number(property.initializer.text);
    }
    return { valid: true, value };
  };

  const defaultTimeoutMatches = [
    ...source.matchAll(/const timeoutMs = options\.timeoutMs \?\? ([\d_]+);/g),
  ];
  if (
    defaultTimeoutMatches.length !== 1 ||
    Number(defaultTimeoutMatches[0]?.[1]?.replaceAll("_", "")) !==
      defaultInnerTimeoutMs
  ) {
    issues.push("runFinalizerHarness default inner timeout must be exactly 10000ms");
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "test"
    ) {
      const name = node.arguments[0];
      const title =
        name !== undefined && ts.isStringLiteralLike(name)
          ? name.text
          : `<test at line ${String(
              sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
                .line + 1,
            )}>`;
      let testCallCount = 0;
      let expandedTestRunCount = 0;
      const testHarnessCalls: ts.CallExpression[] = [];
      const body = node.arguments[1];
      if (body !== undefined) {
        const namedArrays = new Map<string, number>();
        const collectNamedArrays = (bodyNode: ts.Node): void => {
          if (
            ts.isVariableDeclaration(bodyNode) &&
            ts.isIdentifier(bodyNode.name) &&
            bodyNode.initializer !== undefined
          ) {
            const length = staticArrayLength(bodyNode.initializer, namedArrays);
            if (length !== undefined) namedArrays.set(bodyNode.name.text, length);
          }
          ts.forEachChild(bodyNode, collectNamedArrays);
        };
        collectNamedArrays(body);

        const inspectBody = (bodyNode: ts.Node, multiplier: number): void => {
          if (
            ts.isCallExpression(bodyNode) &&
            ts.isIdentifier(bodyNode.expression) &&
            bodyNode.expression.text === "runFinalizerHarness"
          ) {
            testCallCount += 1;
            expandedTestRunCount += multiplier;
            testHarnessCalls.push(bodyNode);
            return;
          }
          if (ts.isForOfStatement(bodyNode)) {
            const hasHarnessCall = containsDirectHarnessCall(bodyNode.statement);
            const loopLength = staticArrayLength(bodyNode.expression, namedArrays);
            if (hasHarnessCall) {
              const scenarios = inlineArrayLiteral(bodyNode.expression);
              if (scenarios === undefined) {
                issues.push(
                  `${title}: finalizer harness loop must use an inline literal scenario array`,
                );
              } else if (
                scenarios.elements.some((element) => ts.isSpreadElement(element))
              ) {
                issues.push(
                  `${title}: finalizer harness loop must enumerate literal scenarios without spreads`,
                );
              } else {
                const scenarioDigest = createHash("sha256")
                  .update(scenarios.getText(sourceFile).replace(/\s+/g, " "))
                  .digest("hex");
                if (
                  expectedHarnessLoopScenarioDigests.get(title) !== scenarioDigest
                ) {
                  issues.push(
                    `${title}: finalizer harness loop must preserve exact scenario literals`,
                  );
                }
              }
              if (loopLength === undefined) {
                issues.push(
                  `${title}: finalizer harness loop must use a statically enumerable array`,
                );
              }
              if (!invokesHarnessLoopUnconditionally(bodyNode, body)) {
                issues.push(
                  `${title}: finalizer harness loop must invoke every scenario unconditionally`,
                );
              }
              if (!bindsLoopScenarioToHarness(bodyNode, title)) {
                issues.push(
                  `${title}: finalizer harness loop must bind its scenario to the harness call`,
                );
              }
              if (
                !ts.isVariableDeclarationList(bodyNode.initializer) ||
                (bodyNode.initializer.flags & ts.NodeFlags.Const) === 0
              ) {
                issues.push(
                  `${title}: finalizer harness loop binding must be const`,
                );
              }
            }
            inspectBody(bodyNode.statement, multiplier * (loopLength ?? 1));
            return;
          }
          ts.forEachChild(bodyNode, (child) => inspectBody(child, multiplier));
        };
        inspectBody(body, 1);
      }

      if (testCallCount > 0) {
        testCount += 1;
        callCount += testCallCount;
        expandedRunCount += expandedTestRunCount;
        const expectedCallbackDigest = expectedHarnessCallbackDigests.get(title);
        const callbackDigest = body === undefined
          ? undefined
          : createHash("sha256")
            .update(body.getText(sourceFile).replace(/\s+/g, " ").trim())
            .digest("hex");
        if (
          expectedCallbackDigest !== undefined &&
          callbackDigest !== expectedCallbackDigest
        ) {
          issues.push(
            `${title}: finalizer harness callback must preserve exact source`,
          );
        }
        const timeout = node.arguments[2];
        const timeoutMs =
          timeout !== undefined && ts.isNumericLiteral(timeout)
            ? Number(timeout.text)
            : undefined;
        const expectedTimeout =
          title === longTimeoutTitle || title === extendedInnerTimeoutTitle
            ? 45_000
            : 15_000;
        if (title === longTimeoutTitle) {
          longTimeoutTestCount += 1;
          longTimeoutScenarioCount += expandedTestRunCount;
          if (!invokesLongTimeoutScenariosUnconditionally(body)) {
            issues.push(
              "45-second finalizer harness test must invoke every scenario unconditionally",
            );
          }
          if (!enumeratesExactLongTimeoutScenarios(body)) {
            issues.push(
              "45-second finalizer harness test must enumerate the exact six mutation scenarios",
            );
          }
          if (!bindsLongTimeoutMutationDirectly(body)) {
            issues.push(
              "45-second finalizer harness test must bind each mutation directly to terminalEvidenceMutation",
            );
          }
          if (!longTimeoutOptionsHaveNoSpreads(body)) {
            issues.push(
              "45-second finalizer harness test must not spread or override harness options",
            );
          }
        }
        if (title === extendedInnerTimeoutTitle) {
          extendedInnerTimeoutTestCount += 1;
          extendedInnerTimeoutScenarioCount += expandedTestRunCount;
        }
        for (const call of testHarnessCalls) {
          const innerTimeout = harnessTimeoutOption(call);
          if (!innerTimeout.valid) {
            issues.push(
              `${title}: finalizer harness timeoutMs must be a direct numeric option without spreads`,
            );
            continue;
          }
          const effectiveInnerTimeoutMs =
            innerTimeout.value ?? defaultInnerTimeoutMs;
          if (
            innerTimeout.value !== undefined &&
            innerTimeout.value > defaultInnerTimeoutMs &&
            title !== extendedInnerTimeoutTitle
          ) {
            issues.push(
              `${title}: only the unbound-report family may exceed the default inner timeout`,
            );
          }
          if (
            title === extendedInnerTimeoutTitle &&
            innerTimeout.value !== extendedInnerTimeoutMs
          ) {
            issues.push(
              `${title}: every harness call requires explicit 30000ms inner timeout`,
            );
          }
          if (
            timeoutMs !== undefined &&
            effectiveInnerTimeoutMs + cleanupReserveMs > timeoutMs
          ) {
            issues.push(
              `${title}: inner timeout must leave at least 3000ms cleanup reserve before outer timeout`,
            );
          }
        }
        if (timeoutMs !== expectedTimeout) {
          issues.push(
            `${title}: ${String(testCallCount)} finalizer harness call(s) require explicit ${String(expectedTimeout)}ms timeout`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (indirectHarnessReferenceCount > 0) {
    issues.push("runFinalizerHarness must not be aliased or referenced indirectly");
  }
  if (
    harnessDeclarationCount !== 1 ||
    topLevelHarnessDeclarationCount !== 1
  ) {
    issues.push(
      "runFinalizerHarness must have exactly one top-level function declaration",
    );
  }
  if (
    monitorFixtureDeclarationCount !== 1 ||
    topLevelMonitorFixtureDeclarationCount !== 1 ||
    indirectMonitorFixtureReferenceCount > 0
  ) {
    issues.push(
      "terminalMonitorFixture must have exactly one top-level declaration and direct calls only",
    );
  }
  if (evalCallCount > 0) {
    issues.push("finalizer harness artifact tests must not call eval");
  }
  if (directHarnessReferenceCount !== callCount) {
    issues.push("every runFinalizerHarness call must be inside one test callback");
  }
  if (longTimeoutTestCount !== 1) {
    issues.push("exactly one six-mutation family may use its 45-second timeout");
  }
  if (longTimeoutScenarioCount !== 6) {
    issues.push("45-second finalizer harness test must cover exactly six scenarios");
  }
  if (extendedInnerTimeoutTestCount !== 1) {
    issues.push("exactly one unbound-report family may use the extended inner timeout");
  }
  if (extendedInnerTimeoutScenarioCount !== 27) {
    issues.push("extended inner timeout must cover exactly 27 unbound-report scenarios");
  }
  return {
    testCount,
    callCount,
    expandedRunCount,
    longTimeoutTestCount,
    longTimeoutScenarioCount,
    extendedInnerTimeoutTestCount,
    extendedInnerTimeoutScenarioCount,
    issues: issues.sort(),
  };
}

function launcherDeadlineLines(milliseconds: number): string[] {
  return [`launcher_deadline_ms=${String(milliseconds)}`];
}

function focusedPreflightCommand(source: string): string | undefined {
  const preflight = extractShellFunction(source, "run_preflight_gates");
  if (preflight === undefined) return undefined;
  const lines = preflight.split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("  bun test ./.orca/workflows/"),
  );
  if (start < 0) return undefined;
  const command = [lines[start]!];
  while (command.at(-1)?.trimEnd().endsWith("\\")) {
    const next = lines[start + command.length];
    if (next === undefined) return undefined;
    command.push(next);
  }
  return command
    .join("\n")
    .replace(/\\\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractIssueLedgerValidator(source: string): string | undefined {
  return source.match(
    /^validate_issue_ledger\(\) \{\n[\s\S]*?^\}/m,
  )?.[0];
}

function extractShellFunction(
  source: string,
  name: string,
): string | undefined {
  const extracted = source.match(
    new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"),
  )?.[0];
  if (extracted === undefined || name !== "remaining_launcher_ms") {
    return extracted;
  }
  const dependencies = [
    "controller_run_until",
    "controller_deadline_cutoffs",
    "controller_capture_before_deadline",
  ].map((dependency) =>
    source.match(
      new RegExp(`^${dependency}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"),
    )?.[0]
  );
  return dependencies.some((dependency) => dependency === undefined)
    ? undefined
    : ['controller_started_seconds="$SECONDS"', ...dependencies, extracted]
      .join("\n\n");
}

type ControllerHangScenario =
  | "controller-dependencies"
  | "owner-scan"
  | "finalization"
  | "terminal-clock";

interface HarnessProcessRow {
  readonly command: string;
  readonly pid: number;
  readonly ppid: number;
}

function harnessProcessTable(): readonly HarnessProcessRow[] {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]);
  if (result.exitCode !== 0) {
    throw new Error("controller harness process inspection failed");
  }
  return result.stdout
    .toString()
    .split("\n")
    .flatMap((line): HarnessProcessRow[] => {
      const match = line.match(/^\s*([1-9][0-9]*)\s+([0-9]+)\s+(.*)$/);
      if (match === null) return [];
      return [{
        command: match[3]!,
        pid: Number(match[1]),
        ppid: Number(match[2]),
      }];
    });
}

function collectOwnedHarnessPids(
  rootPid: number,
  script: string,
  tracked: ReadonlySet<number>,
): Set<number> {
  const rows = harnessProcessTable();
  const livePids = new Set(rows.map((row) => row.pid));
  const owned = new Set([...tracked].filter((pid) => livePids.has(pid)));
  for (const row of rows) {
    if (row.pid === rootPid || row.command.includes(script)) owned.add(row.pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  return owned;
}

function signalExactHarnessPids(
  pids: ReadonlySet<number>,
  signal: "TERM" | "KILL",
): void {
  for (const pid of [...pids].sort((left, right) => right - left)) {
    Bun.spawnSync(["kill", `-${signal}`, String(pid)]);
  }
}

async function terminateOwnedHarness(
  rootPid: number,
  script: string,
  tracked: Set<number>,
): Promise<readonly number[]> {
  for (const pid of collectOwnedHarnessPids(rootPid, script, tracked)) {
    tracked.add(pid);
  }
  signalExactHarnessPids(tracked, "TERM");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(25);
    const live = collectOwnedHarnessPids(rootPid, script, tracked);
    for (const pid of live) tracked.add(pid);
    if (live.size === 0) return [];
  }
  signalExactHarnessPids(
    collectOwnedHarnessPids(rootPid, script, tracked),
    "KILL",
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(25);
    const live = collectOwnedHarnessPids(rootPid, script, tracked);
    if (live.size === 0) return [];
  }
  return [...collectOwnedHarnessPids(rootPid, script, tracked)].sort(
    (left, right) => left - right,
  );
}

async function runControllerHangScenario(
  scenario: ControllerHangScenario,
): Promise<{
  readonly elapsedMs: number;
  readonly entered: boolean;
  readonly exitCode: number;
  readonly termObserved: boolean;
}> {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const controller = extractShellFunction(launcher, "controller_run_until");
  const controllerCutoffs = extractShellFunction(
    launcher,
    "controller_deadline_cutoffs",
  );
  const controllerRunner = extractShellFunction(
    launcher,
    "controller_run_before_deadline",
  );
  const controllerCapture = extractShellFunction(
    launcher,
    "controller_capture_before_deadline",
  );
  const captureAction = extractShellFunction(launcher, "capture_command_output");
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const root = await mkdtemp(join(tmpdir(), `orcats-${scenario}-`));
  const script = join(root, "harness.sh");
  const enteredMarker = join(root, "entered");
  const exactClockMarker = join(root, "exact-clock");
  const termMarker = join(root, "term");
  const usesHighLevel =
    scenario === "owner-scan" ||
    scenario === "terminal-clock";
  const scenarioDeadlineMs = usesHighLevel ? 4_000 : 2_000;
  const fallbackUsesHighLevel =
    scenario === "controller-dependencies" || usesHighLevel;
  const invoke = controller === undefined
    ? fallbackUsesHighLevel
      ? "run_before_deadline true"
      : "hang_until_kill"
    : usesHighLevel
      ? "run_before_deadline true"
      : "controller_run_until 1 2 hang_until_kill";
  const lines = [
    "#!/bin/bash",
    "set -u",
    controller ?? "",
    controllerCutoffs ?? "",
    controllerRunner ?? "",
    captureAction ?? "",
    controllerCapture ?? "",
    remaining ?? "",
    bounded ?? "",
    `entered_marker=${JSON.stringify(enteredMarker)}`,
    `exact_clock_marker=${JSON.stringify(exactClockMarker)}`,
    `term_marker=${JSON.stringify(termMarker)}`,
    "hang_until_kill() {",
    "  trap 'printf term > \"$term_marker\"' TERM",
    "  while :; do :; done",
    "}",
    "now_ms() {",
    scenario === "terminal-clock"
      ? [
          '  if [[ -e "$exact_clock_marker" ]]; then',
          '    : > "$entered_marker"',
          "    while :; do :; done",
          "  fi",
          '  : > "$exact_clock_marker"',
          "  printf '0\\n'",
        ].join("\n")
      : "  printf '0\\n'",
    "}",
    ...(scenario === "controller-dependencies"
      ? [
          "mktemp() { : > \"$entered_marker\"; while :; do :; done; }",
          "sleep() { : > \"$entered_marker\"; while :; do :; done; }",
          "ps() { : > \"$entered_marker\"; while :; do :; done; }",
          "awk() { : > \"$entered_marker\"; while :; do :; done; }",
          "rm() { : > \"$entered_marker\"; while :; do :; done; }",
        ]
      : []),
    ...(scenario === "owner-scan"
      ? ["ps() { : > \"$entered_marker\"; while :; do :; done; }"]
      : []),
    ...(scenario === "terminal-clock" ? ["ps() { return 0; }"] : []),
    "launcher_signal_status=0",
    "terminal_commit_signal_status=0",
    `launcher_deadline_ms=${String(scenarioDeadlineMs)}`,
    `launcher_deadline_at_ms=${String(scenarioDeadlineMs)}`,
    "started_at_ms=0",
    "controller_started_seconds=0",
    "SECONDS=0",
    "set +e",
    invoke,
    'status="$?"',
    "set -e",
    'exit "$status"',
  ];
  await Bun.write(script, lines.join("\n"));

  const startedAt = Date.now();
  const harnessProcess = Bun.spawn(["/bin/bash", script], {
    env: { ...process.env, TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const trackedPids = new Set<number>();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>((resolveTimeout) => {
    timeoutId = setTimeout(() => {
      void (async () => {
        await terminateOwnedHarness(harnessProcess.pid, script, trackedPids);
        resolveTimeout(await Promise.race([
          harnessProcess.exited,
          Bun.sleep(750).then(() => 255),
        ]));
      })();
    }, scenarioDeadlineMs + 750);
  });
  let result:
    | {
        readonly elapsedMs: number;
        readonly entered: boolean;
        readonly exitCode: number;
        readonly termObserved: boolean;
      }
    | undefined;
  try {
    const exitCode = await Promise.race([harnessProcess.exited, timeout]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    result = {
      elapsedMs: Date.now() - startedAt,
      entered: await Bun.file(enteredMarker).exists(),
      exitCode,
      termObserved: await Bun.file(termMarker).exists(),
    };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    const processResidue = await terminateOwnedHarness(
      harnessProcess.pid,
      script,
      trackedPids,
    );
    const controllerResidue = (await readdir(root))
      .filter((name) => /^orcats-(command|controller)-/.test(name))
      .sort();
    try {
      expect(processResidue).toEqual([]);
      expect(controllerResidue).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  if (result === undefined) throw new Error("controller harness produced no result");
  return result;
}

async function runControllerCaptureStartupSignalScenario(
  scenario: "now-ms" | "startup-git",
): Promise<{
  readonly controllerResidue: readonly string[];
  readonly elapsedAfterSignalMs: number;
  readonly entered: boolean;
  readonly exitCode: number;
  readonly processResidue: readonly number[];
  readonly timedOut: boolean;
}> {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const controller = extractShellFunction(launcher, "controller_run_until");
  const cutoffs = extractShellFunction(
    launcher,
    "controller_deadline_cutoffs",
  );
  const historicalRunner = extractShellFunction(
    launcher,
    "controller_run_before_deadline",
  );
  const capture = extractShellFunction(
    launcher,
    "controller_capture_before_deadline",
  );
  expect(controller).toBeDefined();
  expect(cutoffs).toBeDefined();
  expect(capture).toBeDefined();
  if (controller === undefined || cutoffs === undefined || capture === undefined) {
    throw new Error("controller capture harness dependencies are unavailable");
  }

  const root = await mkdtemp(join(tmpdir(), `orcats-capture-${scenario}-`));
  const bin = join(root, "bin");
  const fakeGit = join(bin, "git");
  const script = join(root, "launcher.sh");
  const enteredMarker = join(root, "entered");
  await mkdir(bin);
  await Bun.write(
    fakeGit,
    [
      "#!/bin/bash",
      '[[ "${1:-}" == -C && "${3:-}" == rev-parse ]] || exit 64',
      ': > "$ORCA_CAPTURE_ENTERED"',
      "while :; do :; done",
    ].join("\n"),
  );
  await chmod(fakeGit, 0o755);
  const invocation = scenario === "now-ms"
    ? "controller_capture_before_deadline captured now_ms"
    : `controller_capture_before_deadline captured git -C ${JSON.stringify(root)} rev-parse HEAD`;
  await Bun.write(
    script,
    [
      "#!/bin/bash",
      "set -u",
      controller,
      cutoffs,
      historicalRunner ?? "",
      capture,
      "now_ms() {",
      '  : > "$ORCA_CAPTURE_ENTERED"',
      "  while :; do :; done",
      "}",
      'controller_started_seconds="$SECONDS"',
      "started_at_ms=0",
      "launcher_deadline_ms=30000",
      "launcher_signal_status=0",
      "trap 'launcher_signal_status=143; exit 143' TERM",
      "trap 'launcher_signal_status=130; exit 130' INT",
      "trap 'launcher_signal_status=129; exit 129' HUP",
      "set +e",
      invocation,
      'status="$?"',
      "set -e",
      'exit "$status"',
    ].join("\n"),
  );

  const harnessProcess = Bun.spawn(["/bin/bash", script], {
    env: {
      ...globalThis.process.env,
      ORCA_CAPTURE_ENTERED: enteredMarker,
      PATH: `${bin}:${globalThis.process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const trackedPids = new Set<number>();
  try {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (await Bun.file(enteredMarker).exists()) break;
      await Bun.sleep(10);
    }
    const entered = await Bun.file(enteredMarker).exists();
    for (const pid of collectOwnedHarnessPids(
      harnessProcess.pid,
      script,
      trackedPids,
    )) {
      trackedPids.add(pid);
    }
    const signalledAt = Date.now();
    harnessProcess.kill("SIGTERM");
    const outcome = await Promise.race([
      harnessProcess.exited.then((exitCode) => ({ exitCode, timedOut: false })),
      Bun.sleep(2_000).then(() => ({ exitCode: 255, timedOut: true })),
    ]);
    await Bun.sleep(50);
    return {
      controllerResidue: (await readdir(root))
        .filter((name) => /^orcats-(command|controller)-/.test(name))
        .sort(),
      elapsedAfterSignalMs: Date.now() - signalledAt,
      entered,
      exitCode: outcome.exitCode,
      processResidue: [...collectOwnedHarnessPids(
        harnessProcess.pid,
        script,
        trackedPids,
      )].sort((left, right) => left - right),
      timedOut: outcome.timedOut,
    };
  } finally {
    const cleanupResidue = await terminateOwnedHarness(
      harnessProcess.pid,
      script,
      trackedPids,
    );
    try {
      expect(cleanupResidue).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

function boundedCaptureContractIssues(source: string): string[] {
  const issues: string[] = [];
  const controllerRun = extractShellFunction(source, "controller_run_until");
  const successfulRecordFallback = [
    "            controller_capture_payload_seen=true",
    "          else",
    "            return 125",
    "          fi",
  ].join("\n");
  if (
    controllerRun === undefined ||
    !controllerRun.includes(successfulRecordFallback)
  ) {
    issues.push("captured broker must reject every untyped successful record");
  }
  if (extractShellFunction(source, "capture_before_deadline") === undefined) {
    issues.push("launcher must define main-shell bounded output capture");
  }
  const controllerCapture = extractShellFunction(
    source,
    "controller_capture_before_deadline",
  );
  if (controllerCapture === undefined) {
    issues.push("launcher must define controller bounded output capture");
  } else {
    if (/\$\(controller_run_before_deadline(?:\s|\\)/.test(controllerCapture)) {
      issues.push("controller capture must not run inside command substitution");
    }
    if (
      !controllerCapture.includes(
        "controller_deadline_cutoffs term_second kill_second || return $?",
      )
    ) {
      issues.push("controller capture must compute current-shell deadline cutoffs");
    }
    const directControllerCall = controllerCapture.indexOf(
      'controller_run_until "$term_second" "$kill_second"',
    );
    const directCaptureOption = controllerCapture.indexOf(
      '--capture capture_value "$@" || capture_status=$?',
      directControllerCall,
    );
    if (directControllerCall < 0 || directCaptureOption < directControllerCall) {
      issues.push("controller capture must invoke the low-level controller directly");
    }
    if (
      !controllerCapture.includes(
        "printf -v \"$output_name\" '%s' \"$capture_value\"",
      )
    ) {
      issues.push("controller capture must assign through the caller output name");
    }
  }
  if (/\$\(run_before_deadline(?:\s|\\)/.test(source)) {
    issues.push("bounded commands must never run inside command substitution");
  }
  const captureCalls = source.match(
    /\bcapture_before_deadline\s+[A-Za-z_][A-Za-z0-9_]*\s+/g,
  );
  if ((captureCalls ?? []).length !== 31) {
    issues.push("all 31 bounded output captures must use the main-shell helper");
  }
  return issues;
}

function extractNestedShellFunction(
  source: string,
  name: string,
): string | undefined {
  const extracted = source.match(
    new RegExp(`^  ${name}\\(\\) \\{\\n[\\s\\S]*?^  \\}`, "m"),
  )?.[0];
  return extracted
    ?.split("\n")
    .map((line) => line.startsWith("  ") ? line.slice(2) : line)
    .join("\n");
}

function canonicalPublicationContractIssues(source: string): string[] {
  const issues: string[] = [];
  const bounded = extractShellFunction(source, "run_before_deadline");
  const reserve = extractShellFunction(
    source,
    "run_before_deadline_with_reserve",
  );
  const action = extractShellFunction(source, "atomic_rename_action");
  const recovery = extractShellFunction(
    source,
    "validate_atomic_rename_recovery",
  );
  const publication = extractShellFunction(
    source,
    "atomic_rename_before_deadline",
  );
  const prior = extractShellFunction(source, "quarantine_prior_evidence");
  const current = extractNestedShellFunction(
    source,
    "quarantine_current_latest",
  );
  const tombstone = extractNestedShellFunction(
    source,
    "publish_latest_failure_tombstone",
  );
  const commit = extractNestedShellFunction(source, "commit_terminal_evidence");
  const terminalLedgerRecovery = extractShellFunction(
    source,
    "validate_terminal_ledger_recovery",
  );
  const capture = extractShellFunction(source, "capture_before_deadline");
  const render = extractNestedShellFunction(source, "render_latest_evidence");
  const renderAction = extractShellFunction(
    source,
    "render_latest_evidence_action",
  );
  const fileCleanup = extractShellFunction(
    source,
    "discard_private_path_before_deadline",
  );
  const signalHandler = extractNestedShellFunction(
    source,
    "handle_finalize_signal",
  );
  const compactCommit = commit
    ?.replace(/\\\n\s*/g, " ")
    .replace(/\s+/g, " ");

  if (
    !source.includes("canonical_recovery_reserve_ms=1000") ||
    reserve === undefined ||
    !reserve.includes('local outer_deadline_at_ms="$launcher_deadline_at_ms"') ||
    !reserve.includes('launcher_deadline_at_ms="$outer_deadline_at_ms"')
  ) {
    issues.push("publication worker must reserve and restore exactly 1000 ms");
  }
  if (
    bounded === undefined ||
    !bounded.includes("local controller_term_grace_seconds=1") ||
    !bounded.includes("local command_cleanup_reserve_seconds=2") ||
    !bounded.includes(
      [
        "command_active_term_second=$((",
        "    command_active_kill_second - controller_term_grace_seconds",
        "  ))",
      ].join("\n"),
    ) ||
    reserve === undefined ||
    !reserve.includes("local controller_term_grace_seconds=1") ||
    !reserve.includes("local command_cleanup_reserve_seconds=2") ||
    !reserve.includes(
      [
        "outer_controller_reserve_ms=$((",
        "    (controller_term_grace_seconds + command_cleanup_reserve_seconds) * 1000",
        "  ))",
      ].join("\n"),
    ) ||
    !reserve.includes(
      "total_reserve_ms=$(( reserve_ms + outer_controller_reserve_ms ))",
    ) ||
    !reserve.includes(
      'launcher_deadline_at_ms=$(( outer_deadline_at_ms - total_reserve_ms ))',
    )
  ) {
    issues.push(
      "publication recovery reserve must compose inner cleanup and outer controller budget",
    );
  }

  const actionRemainder = action?.lastIndexOf(
    "remaining_launcher_ms remaining_ms || move_status=124",
  ) ?? -1;
  const actionFinalDestination = action?.lastIndexOf(
    '[[ -e "$destination_path" || -L "$destination_path" ]]',
  ) ?? -1;
  const actionAcquire = action?.indexOf(
    'if ! mkdir "$publication_lock" 2>/dev/null; then',
  ) ?? -1;
  const actionLockedSource = action?.lastIndexOf(
    'if [[ ! -f "$source_path" || -L "$source_path" ]]; then',
  ) ?? -1;
  const actionRename = action?.lastIndexOf(
    'mv -- "$source_path" "$destination_path" || move_status=$?',
  ) ?? -1;
  const actionRelease = action?.lastIndexOf(
    'publication_release_lock "$move_status" || :',
  ) ?? -1;
  const actionClearTraps = action?.lastIndexOf("trap - EXIT TERM INT HUP") ?? -1;
  const actionReturn = action?.lastIndexOf('return "$move_status"') ?? -1;
  if (
    action === undefined ||
    !action.includes('[[ ! -f "$source_path" || -L "$source_path" ]]') ||
    !action.includes(
      '[[ -e "$destination_path" || -L "$destination_path" ]]',
    ) ||
    !action.includes(
      'current_sha256=$(sha256_file "$source_path") || move_status=$?',
    ) ||
    !action.includes(
      '"$validator" "$source_path" "$@" || move_status=$?',
    ) ||
    actionFinalDestination < 0 ||
    actionRemainder < 0 ||
    actionRemainder <= actionFinalDestination ||
    actionRename <= actionRemainder ||
    actionRelease <= actionRename ||
    !action.includes(
      '    mv -- "$source_path" "$destination_path" || move_status=$?\n  fi\n  publication_release_lock "$move_status" || :',
    ) ||
    actionClearTraps <= actionRelease ||
    actionReturn <= actionClearTraps ||
    !action.trimEnd().endsWith('return "$move_status"\n}')
  ) {
    issues.push(
      "rename action must validate under lock immediately before its final mv",
    );
  }
  if (
    action === undefined ||
    !action.includes(
      'if [[ "$move_status" -eq 0 && \\\n    "$current_sha256" != "$expected_sha256" ]]; then\n    move_status=65\n  fi',
    )
  ) {
    issues.push("rename action must reject bytes changed after digest capture");
  }
  if (
    action === undefined ||
    !action.includes(
      'if [[ "$move_status" -eq 0 && "$remaining_ms" -le 0 ]]; then\n    move_status=124\n  fi',
    )
  ) {
    issues.push("rename action must reject exact-zero remainder before mv");
  }
  if (
    action === undefined ||
    !action.includes(
      'local publication_lock="${destination_path}.publication-lock"',
    ) ||
    !action.includes('if ! mkdir "$publication_lock" 2>/dev/null; then') ||
    !action.includes("    return 73") ||
    !action.includes("publication_lock_owned=true") ||
    actionAcquire < 0 ||
    actionLockedSource <= actionAcquire
  ) {
    issues.push("rename action must acquire one destination-keyed exclusive lock");
  }
  if (
    action === undefined ||
    !action.includes(
      'local publication_owner_name="owner.$RANDOM.$RANDOM"',
    ) ||
    !action.includes(
      'local publication_owner_marker="$publication_lock/$publication_owner_name"',
    ) ||
    !action.includes(
      '( set -o noclobber; : > "$publication_owner_marker" ) 2>/dev/null',
    ) ||
    !action.includes(
      '[[ ! -f "$publication_owner_marker" || -L "$publication_owner_marker" ]]',
    ) ||
    !action.includes("publication_owner_created=true")
  ) {
    issues.push("publication lock owner must be noclobber-created and exactly verified");
  }
  const ownerVerified = action?.indexOf("publication_owner_created=true") ?? -1;
  const exitTrap = action?.indexOf("trap 'publication_handle_exit' EXIT") ?? -1;
  const termTrap = action?.indexOf(
    "trap 'publication_handle_signal 143' TERM",
  ) ?? -1;
  const intTrap = action?.indexOf(
    "trap 'publication_handle_signal 130' INT",
  ) ?? -1;
  const hupTrap = action?.indexOf(
    "trap 'publication_handle_signal 129' HUP",
  ) ?? -1;
  if (
    action === undefined ||
    !action.includes("publication_handle_exit() {") ||
    !action.includes("publication_handle_signal() {") ||
    !action.includes('local signal_status="$1"') ||
    !action.includes('exit "$signal_status"') ||
    exitTrap <= ownerVerified ||
    termTrap <= exitTrap ||
    intTrap <= termTrap ||
    hupTrap <= intTrap ||
    actionLockedSource <= hupTrap ||
    actionFinalDestination <= hupTrap
  ) {
    issues.push("publication traps must clean owned lock with original status");
  }
  const authoritativeReleaseCount =
    action?.match(/publication_release_lock "\$move_status" \|\| :/g)?.length ?? 0;
  const firstAuthoritativeRelease = action?.indexOf(
    'publication_release_lock "$move_status" || :',
  ) ?? -1;
  if (
    action === undefined ||
    authoritativeReleaseCount !== 1 ||
    firstAuthoritativeRelease <= actionRename
  ) {
    issues.push(
      "publication lock must remain owned through final destination check and mv",
    );
  }
  if (
    action === undefined ||
    !action.includes('local caller_status="$1"') ||
    !action.includes('local cleanup_owner_created="$publication_owner_created"') ||
    !action.includes('local cleanup_lock_owned="$publication_lock_owned"') ||
    !action.includes("publication_owner_created=false") ||
    !action.includes("publication_lock_owned=false") ||
    !action.includes('-f "$publication_owner_marker"') ||
    !action.includes('! -L "$publication_owner_marker"') ||
    !action.includes('rm -f -- "$publication_owner_marker"') ||
    !action.includes('rmdir -- "$publication_lock"') ||
    !action.includes('return "$caller_status"') ||
    authoritativeReleaseCount !== 1 ||
    actionRelease <= actionRename ||
    actionReturn <= actionRelease
  ) {
    issues.push("publication cleanup must preserve authoritative move status");
  }
  if (
    action !== undefined &&
    (/\bkill\b[^\n]*-0/.test(action) ||
      /\bps\b[^\n]*publication/.test(action) ||
      /owner\.\$\$|owner\.\$\{?BASHPID/.test(action) ||
      /\bfind\b[^\n]*publication_lock/.test(action) ||
      /rm\s+-rf[^\n]*publication_lock/.test(action))
  ) {
    issues.push("publication lock must never inspect or reclaim stale owners");
  }

  if (
    recovery === undefined ||
    !recovery.includes(
      '[[ -e "$source_path" || -L "$source_path" ]]',
    ) ||
    !recovery.includes(
      '[[ ! -f "$destination_path" || -L "$destination_path" ]]',
    ) ||
    !recovery.includes('current_sha256=$(sha256_file "$destination_path")') ||
    !recovery.includes('"$validator" "$destination_path" "$@"')
  ) {
    issues.push("rename recovery must prove exclusive exact destination bytes");
  }

  const restore = publication?.indexOf(
    'launcher_deadline_at_ms="$outer_deadline_at_ms"',
  ) ?? -1;
  const recover = publication?.indexOf(
    "validate_atomic_rename_recovery",
  ) ?? -1;
  const rejectNonTimeout = publication?.indexOf(
    'if [[ "$rename_status" -ne 124 ]]; then',
  ) ?? -1;
  const recoveryAttempt = publication?.lastIndexOf(
    "run_before_deadline validate_atomic_rename_recovery",
  ) ?? -1;
  const recoverySignalBlock = [
    '  if [[ "${launcher_signal_status:-0}" -ne 0 ]]; then',
    '    return "$launcher_signal_status"',
    "  fi",
    '  if [[ "${terminal_commit_signal_status:-0}" -ne 0 ]]; then',
    '    return "$terminal_commit_signal_status"',
    "  fi",
  ].join("\n");
  const recoverySignalGate = publication?.indexOf(
    recoverySignalBlock,
    recoveryAttempt,
  ) ?? -1;
  const recoverySuccess = publication?.indexOf(
    'if [[ "$recovery_status" -eq 0 ]]; then',
    recoveryAttempt,
  ) ?? -1;
  if (
    publication === undefined ||
    !publication.includes(
      'run_before_deadline_with_reserve "$canonical_recovery_reserve_ms"',
    ) ||
    restore < 0 ||
    recover <= restore
  ) {
    issues.push("ambiguous rename must recover under restored outer deadline");
  }
  if (rejectNonTimeout < 0 || recover <= rejectNonTimeout) {
    issues.push("rename recovery must accept only status 124 ambiguity");
  }
  if (
    recoveryAttempt < 0 ||
    !publication?.includes("local recovery_status=0") ||
    !publication.includes('"$validator" "$@" || recovery_status=$?') ||
    recoverySignalGate <= recoveryAttempt ||
    recoverySuccess <= recoverySignalGate ||
    publication.includes('return "$recovery_status"')
  ) {
    issues.push("rename recovery must preserve supervised signal status");
  }

  const terminalMerge =
    'run_before_deadline_with_reserve "$canonical_recovery_reserve_ms" ' +
    'merge_issue_ledger "$candidate_ledger" "$ledger_base_snapshot" ' +
    "terminal-commit";
  if (
    !compactCommit?.includes(terminalMerge) ||
    compactCommit.includes(
      'run_before_deadline merge_issue_ledger "$candidate_ledger" ' +
        '"$ledger_base_snapshot" terminal-commit',
    )
  ) {
    issues.push("terminal ledger merge must reserve recovery time");
  }

  const terminalRecoveryCall =
    'run_before_deadline validate_terminal_ledger_recovery "$ledger" ' +
    '"$terminal_ledger_sha256" "$terminal_commit_id" ' +
    '"$terminal_report_sha256" "$terminal_monitor_sha256" ' +
    '"$terminal_candidate_sha256" ' +
    '"$terminal_latest_projection_sha256"';
  const terminalRecoveryCallCount =
    compactCommit?.match(/\bvalidate_terminal_ledger_recovery\b/g)?.length ?? 0;
  if (
    !compactCommit?.includes(terminalRecoveryCall) ||
    terminalRecoveryCallCount !== 1
  ) {
    issues.push(
      "terminal ledger recovery must be deadline-supervised exactly once",
    );
  }
  if (
    compactCommit?.includes('[[ -f "$ledger"') ||
    compactCommit?.includes("issue_ledger_has_terminal_commit") ||
    compactCommit?.includes('sha256_file "$ledger"')
  ) {
    issues.push(
      "terminal ledger recovery reads must stay inside one supervised action",
    );
  }
  const terminalRecoverySignalGate =
    'if [[ "$terminal_ledger_status" -ne 0 && ' +
    '"$terminal_commit_signal_status" -eq 0 ]]; then';
  const terminalRecoverySignalRecheck =
    'if [[ "$terminal_commit_signal_status" -ne 0 ]]; then ' +
    'terminal_ledger_status="$terminal_commit_signal_status" ' +
    'elif [[ "$terminal_ledger_recovery_status" -eq 0 ]]; then ' +
    "terminal_ledger_status=0 fi";
  const launcherSignalRecoveryGate =
    'if [[ "$terminal_ledger_status" -ne 0 && ' +
    '"$terminal_commit_signal_status" -eq 0 && ' +
    '"$launcher_signal_status" -eq 0 ]]; then';
  const launcherSignalRecoveryOverwrite =
    'elif [[ "$launcher_signal_status" -ne 0 ]]; then ' +
    'terminal_ledger_status="$launcher_signal_status"';
  if (
    !compactCommit?.includes(terminalRecoverySignalGate) ||
    !compactCommit.includes(terminalRecoverySignalRecheck) ||
    compactCommit.includes(launcherSignalRecoveryGate) ||
    compactCommit.includes(launcherSignalRecoveryOverwrite)
  ) {
    issues.push(
      "terminal recovery signal adjudication must preserve commit-point semantics",
    );
  }
  if (
    terminalLedgerRecovery === undefined ||
    !terminalLedgerRecovery.includes(
      '[[ -f "$ledger_path" && ! -L "$ledger_path" ]]',
    ) ||
    !terminalLedgerRecovery.includes("issue_ledger_has_terminal_commit") ||
    !terminalLedgerRecovery.includes(
      'current_sha256=$(sha256_file "$ledger_path")',
    ) ||
    !terminalLedgerRecovery.includes(
      '[[ "$current_sha256" == "$expected_sha256" ]]',
    ) ||
    !compactCommit?.includes("local terminal_ledger_recovery_status=0")
  ) {
    issues.push("terminal ledger recovery must bind one exact read-only result");
  }

  const routes = [
    [
      prior,
      'atomic_rename_before_deadline "$stable_path" "$quarantine_path" validate_regular_publication_file',
      "prior-evidence quarantine",
    ],
    [
      current,
      'atomic_rename_before_deadline "$latest" "$latest_tmp" validate_regular_publication_file',
      "current-latest quarantine",
    ],
    [
      tombstone,
      'atomic_rename_before_deadline "$tombstone" "$latest" validate_failure_tombstone_file',
      "failure tombstone",
    ],
    [
      commit,
      'atomic_rename_before_deadline "$latest_tmp" "$latest" validate_latest_publication_file',
      "latest commit",
    ],
    [
      commit,
      'atomic_rename_before_deadline "$preflight_stage" "$preflight_path" validate_preflight_publication_file',
      "preflight commit",
    ],
  ] as const;
  for (const [body, required, label] of routes) {
    const compactBody = body
      ?.replace(/\\\n\s*/g, " ")
      .replace(/\s+/g, " ");
    if (!compactBody?.includes(required)) {
      issues.push(`${label} must use supervised atomic publication`);
    }
  }

  if (
    capture === undefined ||
    !capture.includes('run_before_deadline --capture capture_value "$@"') ||
    capture.includes("capture_path") ||
    capture.includes("orcats-command-output")
  ) {
    issues.push("capture redirection must execute inside supervised worker");
  }
  if (
    renderAction === undefined ||
    !renderAction.includes('> "$latest_tmp"') ||
    render === undefined ||
    !render.includes("run_before_deadline render_latest_evidence_action") ||
    render.includes('run_before_deadline jq -n')
  ) {
    issues.push("latest render redirection must execute inside supervised worker");
  }
  if (
    tombstone === undefined ||
    !tombstone.includes(
      'run_before_deadline write_failure_tombstone "$tombstone" "$status"',
    )
  ) {
    issues.push("failure tombstone write must execute inside supervised worker");
  }
  if (
    fileCleanup === undefined ||
    !fileCleanup.includes("remaining_launcher_ms remaining_ms || return 0") ||
    !fileCleanup.includes('if [[ "$remaining_ms" -le 0 ]]; then') ||
    !fileCleanup.includes('run_before_deadline rm -f -- "$path"') ||
    !signalHandler?.includes(
      'local signal_preflight_fallback="${preflight_path}.signal.${run_id}"',
    ) ||
    !signalHandler?.includes(
      'local signal_latest_fallback="${latest}.signal.${run_id}"',
    ) ||
    signalHandler?.includes("mktemp -d") === true ||
    !signalHandler?.includes(
      'discard_private_path_before_deadline "$signal_preflight_fallback"',
    ) ||
    !signalHandler?.includes(
      'discard_private_path_before_deadline "$signal_latest_fallback"',
    ) ||
    !compactCommit?.includes(
      'discard_private_path_before_deadline "$ledger_base_snapshot"',
    )
  ) {
    issues.push("finalizer private cleanup must be deadline-supervised");
  }
  return issues;
}

type AtomicPublicationScenario =
  | "success"
  | "timeout-before-rename"
  | "below-reserve-timeout-after-rename"
  | "at-reserve-timeout-after-rename"
  | "forced-timeout-after-rename"
  | "failure-after-rename"
  | "occupied-destination"
  | "symlink-destination"
  | "wrong-destination-bytes";

type CanonicalPublicationRoute =
  | "prior-quarantine"
  | "current-quarantine"
  | "failure-tombstone"
  | "latest-commit"
  | "preflight-commit";

type CanonicalRouteScenario =
  | "success"
  | "source-hash-mismatch"
  | "exact-zero";

type ConcurrentPublisher = "A" | "B";

type ConcurrentCanonicalPublicationDiagnostic = {
  readonly readyCountBeforeWinnerRelease: number;
  readonly statuses: readonly number[];
  readonly statusByPublisher: Readonly<Record<ConcurrentPublisher, number>>;
  readonly canonicalRunIds: {
    readonly latest: string | undefined;
    readonly preflight: string | undefined;
  };
  readonly pairValid: boolean;
  readonly stages: Readonly<
    Record<ConcurrentPublisher, { readonly latest: boolean; readonly preflight: boolean }>
  >;
  readonly locks: { readonly latest: boolean; readonly preflight: boolean };
  readonly liveGroups: readonly number[];
};

function preflightPublicationFixtures(
  publisher: ConcurrentPublisher,
  preflightPath: string,
): {
  readonly latest: Record<string, unknown>;
  readonly preflight: Record<string, unknown>;
} {
  const runId = `publisher-${publisher.toLowerCase()}`;
  const runtimeHead = `head-${publisher.toLowerCase()}`;
  const runtimeSha256 = publisher === "A" ? "a".repeat(64) : "d".repeat(64);
  const baseSha = publisher === "A" ? "b".repeat(40) : "e".repeat(40);
  const artifactDigest = publisher === "A" ? "c".repeat(64) : "f".repeat(64);
  const preflightCore = {
    runId,
    runtimeHead,
    runtimeSha256,
    baseSha,
    artifactDigest,
    originFetchUrl: "https://github.com/ASRagab/orca-ts.git",
    originPushUrl: "git@github.com:ASRagab/orca-ts.git",
    repository: "ASRagab/orca-ts",
    checkedAt: "2026-07-18T00:00:00Z",
    status: "succeeded",
    exitCode: 0,
    elapsedMs: 50,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    supervisorStatus: "terminal",
    checkedAtMs: 100,
    expiresAtMs: 600_100,
  };
  return {
    latest: {
      runId,
      mode: "preflight",
      status: "succeeded",
      exitCode: 0,
      runtimeHead,
      runtimeSha256,
      preflightArtifactDigest: artifactDigest,
      preflightBaseSha: baseSha,
      preflightPath,
    },
    preflight: {
      ...preflightCore,
      terminalProof: sha256Text(`${stableJson(preflightCore)}\n`),
    },
  };
}

async function runConcurrentCanonicalPublicationHarness(
  launcher: string,
): Promise<ConcurrentCanonicalPublicationDiagnostic> {
  const sha256 = extractShellFunction(launcher, "sha256_file");
  const action = extractShellFunction(launcher, "atomic_rename_action");
  if (sha256 === undefined || action === undefined) {
    return {
      readyCountBeforeWinnerRelease: 0,
      statuses: [99, 99],
      statusByPublisher: { A: 99, B: 99 },
      canonicalRunIds: { latest: undefined, preflight: undefined },
      pairValid: false,
      stages: {
        A: { latest: true, preflight: true },
        B: { latest: true, preflight: true },
      },
      locks: { latest: false, preflight: false },
      liveGroups: [],
    };
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-concurrent-publication-"));
  const latestDestination = join(root, "latest.json");
  const preflightDestination = join(root, "preflight.json");
  const script = join(root, "publish.sh");
  const publishers = ["A", "B"] as const;
  const stages = Object.fromEntries(
    publishers.map((publisher) => [
      publisher,
      {
        latest: join(root, `${publisher}.latest.stage.json`),
        preflight: join(root, `${publisher}.preflight.stage.json`),
      },
    ]),
  ) as Record<ConcurrentPublisher, { latest: string; preflight: string }>;
  const marker = (
    publisher: ConcurrentPublisher,
    kind: "latest" | "preflight",
    state: "ready" | "release" | "done",
  ): string => join(root, `${publisher}.${kind}.${state}`);
  for (const publisher of publishers) {
    const fixture = preflightPublicationFixtures(publisher, preflightDestination);
    await Bun.write(stages[publisher].latest, `${stableJson(fixture.latest)}\n`);
    await Bun.write(stages[publisher].preflight, `${stableJson(fixture.preflight)}\n`);
    expect(
      hasAuthoritativePreflightPair(fixture.latest, fixture.preflight),
      publisher,
    ).toBe(true);
  }
  await Bun.write(
    script,
    [
      "#!/bin/sh",
      "set -euo pipefail",
      sha256,
      action,
      `root=${JSON.stringify(root)}`,
      `latest_destination=${JSON.stringify(latestDestination)}`,
      `preflight_destination=${JSON.stringify(preflightDestination)}`,
      'publisher="${PUBLISHER:?}"',
      'latest_source="$root/$publisher.latest.stage.json"',
      'preflight_source="$root/$publisher.preflight.stage.json"',
      'run_id=$(printf "%s" "$publisher" | tr "[:upper:]" "[:lower:]")',
      'run_id="publisher-$run_id"',
      "remaining_launcher_ms() { printf -v \"$1\" '%s' 5000; }",
      "validate_harness_publication() {",
      '  local path="$1"',
      '  local expected_run_id="$2"',
      '  [[ -f "$path" && ! -L "$path" ]] || return 65',
      "  jq -e --arg runId \"$expected_run_id\" '",
      '    type == "object" and .runId == $runId and',
      '    .status == "succeeded" and .exitCode == 0',
      "  ' \"$path\" >/dev/null",
      "}",
      "mv() {",
      '  local destination="${!#}"',
      '  local kind=""',
      '  local ready=""',
      '  local release=""',
      '  local done=""',
      '  if [[ "$destination" == "$latest_destination" ]]; then',
      "    kind=latest",
      '  elif [[ "$destination" == "$preflight_destination" ]]; then',
      "    kind=preflight",
      "  else",
      "    return 97",
      "  fi",
      '  ready="$root/$publisher.$kind.ready"',
      '  release="$root/$publisher.$kind.release"',
      '  done="$root/$publisher.$kind.done"',
      '  : > "$ready"',
      '  while [[ ! -e "$release" ]]; do sleep 0.01; done',
      '  command mv "$@" || return $?',
      '  : > "$done"',
      "}",
      'latest_sha256=$(sha256_file "$latest_source")',
      'preflight_sha256=$(sha256_file "$preflight_source")',
      "publication_status=0",
      "atomic_rename_action \"$latest_source\" \"$latest_destination\" \\",
      "  \"$latest_sha256\" validate_harness_publication \"$run_id\" || \\",
      "  publication_status=$?",
      'if [[ "$publication_status" -eq 0 ]]; then',
      "  atomic_rename_action \"$preflight_source\" \"$preflight_destination\" \\",
      "    \"$preflight_sha256\" validate_harness_publication \"$run_id\" || \\",
      "    publication_status=$?",
      "fi",
      'exit "$publication_status"',
    ].join("\n"),
  );

  type HarnessProcess = {
    readonly publisher: ConcurrentPublisher;
    readonly process: ReturnType<typeof Bun.spawn>;
    readonly stdout: Promise<string>;
    readonly stderr: Promise<string>;
  };
  const owned: HarnessProcess[] = [];
  const groupAlive = (pid: number): boolean => {
    try {
      globalThis.process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const spawnPublisher = (publisher: ConcurrentPublisher): HarnessProcess => {
    const child = Bun.spawn(["/bin/bash", script], {
      detached: true,
      env: { ...globalThis.process.env, PUBLISHER: publisher },
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = {
      publisher,
      process: child,
      stdout: new Response(child.stdout).text(),
      stderr: new Response(child.stderr).text(),
    };
    owned.push(result);
    return result;
  };
  const waitForFile = async (path: string): Promise<void> => {
    for (let attempt = 0; attempt < 700; attempt += 1) {
      if (await Bun.file(path).exists()) return;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for harness file: ${path}`);
  };
  const waitForReadyOrExit = async (
    path: string,
    child: HarnessProcess,
  ): Promise<"ready" | "exited"> => {
    let exited = false;
    void child.process.exited.then(() => {
      exited = true;
    });
    for (let attempt = 0; attempt < 700; attempt += 1) {
      if (await Bun.file(path).exists()) return "ready";
      if (exited) return "exited";
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ready or exit: ${path}`);
  };
  const releaseAndWait = async (
    publisher: ConcurrentPublisher,
    kind: "latest" | "preflight",
  ): Promise<void> => {
    await Bun.write(marker(publisher, kind, "release"), "release\n");
    await waitForFile(marker(publisher, kind, "done"));
  };
  const waitForGroupGone = async (pid: number): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!groupAlive(pid)) return;
      await Bun.sleep(10);
    }
    expect(groupAlive(pid), String(pid)).toBe(false);
  };
  const terminateOwned = async (child: HarnessProcess): Promise<void> => {
    if (groupAlive(child.process.pid)) {
      try {
        globalThis.process.kill(-child.process.pid, "SIGTERM");
      } catch {}
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!groupAlive(child.process.pid)) break;
      await Bun.sleep(10);
    }
    if (groupAlive(child.process.pid)) {
      try {
        globalThis.process.kill(-child.process.pid, "SIGKILL");
      } catch {}
    }
    await child.process.exited;
    await Promise.all([child.stdout.catch(() => ""), child.stderr.catch(() => "")]);
  };

  try {
    const processA = spawnPublisher("A");
    if (
      await waitForReadyOrExit(marker("A", "latest", "ready"), processA) ===
        "exited"
    ) {
      throw new Error(
        `publisher A exited before latest barrier: status=${String(await processA.process.exited)} stdout=${await processA.stdout} stderr=${await processA.stderr}\n${await Bun.file(script).text()}`,
      );
    }
    const processB = spawnPublisher("B");
    const bLatest = await waitForReadyOrExit(
      marker("B", "latest", "ready"),
      processB,
    );
    const readyCountBeforeWinnerRelease = bLatest === "ready" ? 2 : 1;
    await releaseAndWait("A", "latest");
    await waitForFile(marker("A", "preflight", "ready"));
    if (bLatest === "ready") {
      await releaseAndWait("B", "latest");
      await waitForFile(marker("B", "preflight", "ready"));
      await releaseAndWait("B", "preflight");
      await releaseAndWait("A", "preflight");
    } else {
      await processB.process.exited;
      await releaseAndWait("A", "preflight");
    }
    const statusByPublisher = {
      A: await processA.process.exited,
      B: await processB.process.exited,
    };
    await Promise.all([
      processA.stdout,
      processA.stderr,
      processB.stdout,
      processB.stderr,
    ]);
    await Promise.all(owned.map(({ process }) => waitForGroupGone(process.pid)));
    const latest = await Bun.file(latestDestination).exists()
      ? await Bun.file(latestDestination).json() as Record<string, unknown>
      : undefined;
    const preflight = await Bun.file(preflightDestination).exists()
      ? await Bun.file(preflightDestination).json() as Record<string, unknown>
      : undefined;
    return {
      readyCountBeforeWinnerRelease,
      statuses: Object.values(statusByPublisher).sort((left, right) => left - right),
      statusByPublisher,
      canonicalRunIds: {
        latest: typeof latest?.runId === "string" ? latest.runId : undefined,
        preflight: typeof preflight?.runId === "string"
          ? preflight.runId
          : undefined,
      },
      pairValid: hasAuthoritativePreflightPair(latest, preflight),
      stages: {
        A: {
          latest: await Bun.file(stages.A.latest).exists(),
          preflight: await Bun.file(stages.A.preflight).exists(),
        },
        B: {
          latest: await Bun.file(stages.B.latest).exists(),
          preflight: await Bun.file(stages.B.preflight).exists(),
        },
      },
      locks: {
        latest: await Bun.file(`${latestDestination}.publication-lock`).exists(),
        preflight: await Bun.file(`${preflightDestination}.publication-lock`).exists(),
      },
      liveGroups: owned
        .map(({ process }) => process.pid)
        .filter((pid) => groupAlive(pid)),
    };
  } finally {
    try {
      await Promise.all(owned.map((child) => terminateOwned(child)));
      expect(
        owned.filter(({ process }) => groupAlive(process.pid)),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

type PublicationLockLifecycleScenario =
  | "TERM"
  | "INT"
  | "HUP"
  | "KILL"
  | "owner-cleanup-failure"
  | "directory-cleanup-failure";

type PublicationLockLifecycleDiagnostic = {
  readonly firstStatus: number;
  readonly freshStatus: number;
  readonly lockAtBarrier: boolean;
  readonly ownersAtBarrier: number;
  readonly lockAfterFirst: boolean;
  readonly ownersAfterFirst: number;
  readonly destinationBytes: string | undefined;
  readonly stages: {
    readonly first: boolean;
    readonly fresh: boolean;
  };
  readonly calls: {
    readonly firstValidator: boolean;
    readonly firstMove: boolean;
    readonly freshValidator: boolean;
    readonly freshMove: boolean;
  };
  readonly liveGroups: readonly number[];
};

async function runPublicationLockLifecycleHarness(
  launcher: string,
  scenario: PublicationLockLifecycleScenario,
): Promise<PublicationLockLifecycleDiagnostic> {
  const sha256 = extractShellFunction(launcher, "sha256_file");
  const action = extractShellFunction(launcher, "atomic_rename_action");
  if (sha256 === undefined || action === undefined) {
    return {
      firstStatus: 99,
      freshStatus: 99,
      lockAtBarrier: false,
      ownersAtBarrier: 0,
      lockAfterFirst: false,
      ownersAfterFirst: 0,
      destinationBytes: undefined,
      stages: { first: true, fresh: true },
      calls: {
        firstValidator: false,
        firstMove: false,
        freshValidator: false,
        freshMove: false,
      },
      liveGroups: [],
    };
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-publication-lock-life-"));
  const destination = join(root, "canonical.json");
  const lock = `${destination}.publication-lock`;
  const firstStage = join(root, "first.stage.json");
  const freshStage = join(root, "fresh.stage.json");
  const ready = join(root, "first.move.ready");
  const release = join(root, "first.move.release");
  const script = join(root, "publish.sh");
  await Bun.write(
    firstStage,
    '{"exitCode":0,"runId":"first","status":"succeeded"}\n',
  );
  await Bun.write(
    freshStage,
    '{"exitCode":0,"runId":"fresh","status":"succeeded"}\n',
  );
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      sha256,
      action,
      `root=${JSON.stringify(root)}`,
      `destination_path=${JSON.stringify(destination)}`,
      `publication_lock=${JSON.stringify(lock)}`,
      'role="${ROLE:?}"',
      'source_path="$root/$role.stage.json"',
      'expected_run_id="$role"',
      "remaining_launcher_ms() { printf -v \"$1\" '%s' 5000; }",
      "validate_harness_publication() {",
      '  local path="$1"',
      '  local run_id="$2"',
      '  : > "$root/$role.validator.called"',
      '  [[ -f "$path" && ! -L "$path" ]] || return 65',
      "  jq -e --arg runId \"$run_id\" '",
      '    type == "object" and .runId == $runId and',
      '    .status == "succeeded" and .exitCode == 0',
      "  ' \"$path\" >/dev/null",
      "}",
      "mv() {",
      '  : > "$root/$role.move.called"',
      '  if [[ "$role" == first && "${BLOCK_MOVE:-false}" == true ]]; then',
      `    : > ${JSON.stringify(ready)}`,
      `    while [[ ! -e ${JSON.stringify(release)} ]]; do sleep 0.01; done`,
      "  fi",
      '  command mv "$@"',
      "}",
      "rm() {",
      '  local target="${!#}"',
      '  if [[ "${FORCE_OWNER_CLEANUP_FAILURE:-false}" == true &&',
      '    "$target" == "$publication_lock"/owner.* ]]; then',
      "    return 91",
      "  fi",
      '  command rm "$@"',
      "}",
      "rmdir() {",
      '  local target="${!#}"',
      '  if [[ "${FORCE_DIRECTORY_CLEANUP_FAILURE:-false}" == true &&',
      '    "$target" == "$publication_lock" ]]; then',
      "    return 92",
      "  fi",
      '  command rmdir "$@"',
      "}",
      'expected_sha256=$(sha256_file "$source_path")',
      "publication_status=0",
      "atomic_rename_action \"$source_path\" \"$destination_path\" \\",
      "  \"$expected_sha256\" validate_harness_publication \\",
      "  \"$expected_run_id\" || publication_status=$?",
      'exit "$publication_status"',
    ].join("\n"),
  );

  type HarnessProcess = {
    readonly process: ReturnType<typeof Bun.spawn>;
    readonly stdout: Promise<string>;
    readonly stderr: Promise<string>;
  };
  const owned: HarnessProcess[] = [];
  const groupAlive = (pid: number): boolean => {
    try {
      globalThis.process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const spawnPublisher = (
    role: "first" | "fresh",
    extra: Record<string, string> = {},
  ): HarnessProcess => {
    const child = Bun.spawn(["/bin/bash", script], {
      detached: true,
      env: { ...globalThis.process.env, ROLE: role, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = {
      process: child,
      stdout: new Response(child.stdout).text(),
      stderr: new Response(child.stderr).text(),
    };
    owned.push(result);
    return result;
  };
  const waitForReadyOrExit = async (
    child: HarnessProcess,
  ): Promise<"ready" | "exited"> => {
    let exited = false;
    void child.process.exited.then(() => {
      exited = true;
    });
    for (let attempt = 0; attempt < 700; attempt += 1) {
      if (await Bun.file(ready).exists()) return "ready";
      if (exited) return "exited";
      await Bun.sleep(10);
    }
    throw new Error("timed out waiting for publication lock barrier");
  };
  const pathExists = async (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false,
    );
  const ownerCount = async (): Promise<number> => {
    if (!(await pathExists(lock))) return 0;
    if (Bun.spawnSync(["test", "-d", lock]).exitCode !== 0) return 0;
    return (await readdir(lock)).filter((name) => name.startsWith("owner.")).length;
  };
  const waitForGroupGone = async (pid: number): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (!groupAlive(pid)) return;
      await Bun.sleep(10);
    }
    expect(groupAlive(pid), String(pid)).toBe(false);
  };
  const terminateOwned = async (child: HarnessProcess): Promise<void> => {
    if (groupAlive(child.process.pid)) {
      try {
        globalThis.process.kill(-child.process.pid, "SIGTERM");
      } catch {}
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!groupAlive(child.process.pid)) break;
      await Bun.sleep(10);
    }
    if (groupAlive(child.process.pid)) {
      try {
        globalThis.process.kill(-child.process.pid, "SIGKILL");
      } catch {}
    }
    await child.process.exited;
    await Promise.all([child.stdout.catch(() => ""), child.stderr.catch(() => "")]);
  };

  try {
    const first = spawnPublisher("first", {
      BLOCK_MOVE: "true",
      FORCE_OWNER_CLEANUP_FAILURE: String(
        scenario === "owner-cleanup-failure",
      ),
      FORCE_DIRECTORY_CLEANUP_FAILURE: String(
        scenario === "directory-cleanup-failure",
      ),
    });
    const firstBarrier = await waitForReadyOrExit(first);
    if (firstBarrier === "exited") {
      throw new Error(
        `first publisher exited before barrier: status=${String(await first.process.exited)} stderr=${await first.stderr}`,
      );
    }
    const lockAtBarrier = await pathExists(lock);
    const ownersAtBarrier = await ownerCount();
    if (
      scenario === "TERM" ||
      scenario === "INT" ||
      scenario === "HUP" ||
      scenario === "KILL"
    ) {
      globalThis.process.kill(-first.process.pid, `SIG${scenario}`);
    } else {
      await Bun.write(release, "release\n");
    }
    const firstStatus = await first.process.exited;
    await Promise.all([first.stdout, first.stderr]);
    await waitForGroupGone(first.process.pid);
    const lockAfterFirst = await pathExists(lock);
    const ownersAfterFirst = await ownerCount();
    const fresh = spawnPublisher("fresh");
    const freshStatus = await fresh.process.exited;
    await Promise.all([fresh.stdout, fresh.stderr]);
    await waitForGroupGone(fresh.process.pid);
    const destinationBytes = await Bun.file(destination).exists()
      ? await Bun.file(destination).text()
      : undefined;
    return {
      firstStatus,
      freshStatus,
      lockAtBarrier,
      ownersAtBarrier,
      lockAfterFirst,
      ownersAfterFirst,
      destinationBytes,
      stages: {
        first: await Bun.file(firstStage).exists(),
        fresh: await Bun.file(freshStage).exists(),
      },
      calls: {
        firstValidator: await Bun.file(join(root, "first.validator.called")).exists(),
        firstMove: await Bun.file(join(root, "first.move.called")).exists(),
        freshValidator: await Bun.file(join(root, "fresh.validator.called")).exists(),
        freshMove: await Bun.file(join(root, "fresh.move.called")).exists(),
      },
      liveGroups: owned
        .map(({ process }) => process.pid)
        .filter((pid) => groupAlive(pid)),
    };
  } finally {
    try {
      await Promise.all(owned.map((child) => terminateOwned(child)));
      expect(
        owned.filter(({ process }) => groupAlive(process.pid)),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

type PreexistingPublicationLockKind = "directory" | "file" | "symlink";

async function runPreexistingPublicationLockHarness(
  launcher: string,
  kind: PreexistingPublicationLockKind,
  sourcePresent = true,
): Promise<{
  readonly kind: PreexistingPublicationLockKind;
  readonly status: number;
  readonly stageExists: boolean;
  readonly destinationExists: boolean;
  readonly validatorCalled: boolean;
  readonly moveCalled: boolean;
  readonly lockIsDirectory: boolean;
  readonly lockIsFile: boolean;
  readonly lockIsSymlink: boolean;
  readonly groupAlive: boolean;
}> {
  const sha256 = extractShellFunction(launcher, "sha256_file");
  const action = extractShellFunction(launcher, "atomic_rename_action");
  if (sha256 === undefined || action === undefined) {
    return {
      kind,
      status: 99,
      stageExists: true,
      destinationExists: false,
      validatorCalled: false,
      moveCalled: false,
      lockIsDirectory: false,
      lockIsFile: false,
      lockIsSymlink: false,
      groupAlive: false,
    };
  }
  const root = await mkdtemp(join(tmpdir(), "orcats-preexisting-pub-lock-"));
  const source = join(root, "stage.json");
  const destination = join(root, "canonical.json");
  const lock = `${destination}.publication-lock`;
  const target = join(root, "symlink-target");
  const validatorMarker = join(root, "validator.called");
  const moveMarker = join(root, "move.called");
  const script = join(root, "publish.sh");
  const sourceBytes =
    '{"exitCode":0,"runId":"run","status":"succeeded"}\n';
  const expectedSha256 = sha256Text(sourceBytes);
  if (sourcePresent) await Bun.write(source, sourceBytes);
  if (kind === "directory") {
    await mkdir(lock);
  } else if (kind === "file") {
    await Bun.write(lock, "occupied\n");
  } else {
    await mkdir(target);
    await symlink(target, lock);
  }
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      sha256,
      action,
      `source_path=${JSON.stringify(source)}`,
      `destination_path=${JSON.stringify(destination)}`,
      `validator_marker=${JSON.stringify(validatorMarker)}`,
      `move_marker=${JSON.stringify(moveMarker)}`,
      "remaining_launcher_ms() { printf -v \"$1\" '%s' 5000; }",
      "validate_harness_publication() {",
      '  : > "$validator_marker"',
      '  [[ -f "$1" && ! -L "$1" ]]',
      "}",
      "mv() {",
      '  : > "$move_marker"',
      '  command mv "$@"',
      "}",
      `expected_sha256=${JSON.stringify(expectedSha256)}`,
      "status=0",
      "atomic_rename_action \"$source_path\" \"$destination_path\" \\",
      "  \"$expected_sha256\" validate_harness_publication || status=$?",
      'exit "$status"',
    ].join("\n"),
  );
  const process = Bun.spawn(["/bin/bash", script], {
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(process.stdout).text();
  const stderr = new Response(process.stderr).text();
  const processGroupAlive = (): boolean => {
    try {
      globalThis.process.kill(-process.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const status = await process.exited;
    await Promise.all([stdout, stderr]);
    for (let attempt = 0; attempt < 200 && processGroupAlive(); attempt += 1) {
      await Bun.sleep(10);
    }
    return {
      kind,
      status,
      stageExists: await Bun.file(source).exists(),
      destinationExists: await Bun.file(destination).exists(),
      validatorCalled: await Bun.file(validatorMarker).exists(),
      moveCalled: await Bun.file(moveMarker).exists(),
      lockIsDirectory:
        Bun.spawnSync(["test", "-d", lock]).exitCode === 0 &&
        Bun.spawnSync(["test", "-L", lock]).exitCode !== 0,
      lockIsFile: Bun.spawnSync(["test", "-f", lock]).exitCode === 0,
      lockIsSymlink: Bun.spawnSync(["test", "-L", lock]).exitCode === 0,
      groupAlive: processGroupAlive(),
    };
  } finally {
    if (processGroupAlive()) {
      try {
        globalThis.process.kill(-process.pid, "SIGKILL");
      } catch {}
    }
    await process.exited;
    await Promise.all([stdout.catch(() => ""), stderr.catch(() => "")]);
    expect(processGroupAlive()).toBe(false);
    await rm(root, { recursive: true, force: true });
  }
}

async function runAtomicPublicationHarness(
  launcher: string,
  scenario: AtomicPublicationScenario,
  signal?: "SIGTERM" | "SIGINT" | "SIGHUP",
  signalPoint:
    | "before-rename"
    | "during-recovery"
    | "after-recovery" = "before-rename",
  recoveryStatusAfterValidation: 0 | 125 = 0,
  shellPath = "bash",
  holdInheritedPipes = false,
  controllerObservationDelayMs = 0,
): Promise<{
  exitCode: number;
  sourceExists: boolean;
  destinationExists: boolean;
  destinationIsSymlink: boolean;
  destinationBytes: string | undefined;
  deadlineRestored: boolean;
  stdout: string;
  stderr: string;
  childExitedBeforeMarker: boolean;
  processGroupAliveAfterCleanup: boolean;
  rootExistsAfterCleanup: boolean;
  leaderExitedWithInheritedPipeHolder: boolean;
  inheritedPipeFallbackUsed: boolean;
}> {
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const atomicAction = extractShellFunction(launcher, "atomic_rename_action");
  const forceTimeoutAfterRename = scenario === "forced-timeout-after-rename";
  const tightWindowRecoveryNowMs =
    scenario === "below-reserve-timeout-after-rename"
      ? 4_001
      : scenario === "at-reserve-timeout-after-rename"
      ? 4_000
      : undefined;
  const injectAfterRecovery = signal !== undefined &&
    signalPoint === "after-recovery";
  const functions = [
    extractShellFunction(launcher, "sha256_file"),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    injectAfterRecovery && bounded !== undefined
      ? bounded.replace(
          "run_before_deadline() {",
          "run_before_deadline_original() {",
        )
      : bounded,
    extractShellFunction(launcher, "run_before_deadline_with_reserve"),
    extractShellFunction(launcher, "capture_command_output"),
    extractShellFunction(launcher, "capture_before_deadline"),
    forceTimeoutAfterRename && atomicAction !== undefined
      ? atomicAction.replace(
          "atomic_rename_action() {",
          "atomic_rename_action_original() {",
        )
      : atomicAction,
    extractShellFunction(launcher, "validate_atomic_rename_recovery"),
    extractShellFunction(launcher, "atomic_rename_before_deadline"),
  ];
  if (functions.some((value) => value === undefined)) {
    return {
      exitCode: 99,
      sourceExists: true,
      destinationExists: false,
      destinationIsSymlink: false,
      destinationBytes: undefined,
      deadlineRestored: false,
      stdout: "",
      stderr: "required launcher function missing",
      childExitedBeforeMarker: false,
      processGroupAliveAfterCleanup: false,
      rootExistsAfterCleanup: false,
      leaderExitedWithInheritedPipeHolder: false,
      inheritedPipeFallbackUsed: false,
    };
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-atomic-publication-"));
  const source = join(root, "stage.json");
  const destination = join(root, "canonical.json");
  const external = join(root, "external.json");
  const actionMarker = join(root, "action.marker");
  const outerDeadline = join(root, "outer-deadline");
  const restoredDeadline = join(root, "restored-deadline");
  const script = join(root, "publish.sh");
  const expected = '{"runId":"run","status":"succeeded","exitCode":0}\n';
  await Bun.write(source, expected);
  if (scenario === "occupied-destination") {
    await Bun.write(destination, expected);
  } else if (scenario === "symlink-destination") {
    await Bun.write(external, expected);
    await symlink(external, destination);
  }

  const blockBeforeRename = (signal !== undefined && signalPoint === "before-rename") ||
    scenario === "timeout-before-rename";
  const blockDuringRecovery =
    (signal !== undefined && signalPoint === "during-recovery") ||
    tightWindowRecoveryNowMs !== undefined;
  const signalName = signal?.replace(/^SIG/, "");
  const signalStatus = signal === "SIGTERM"
    ? 143
    : signal === "SIGINT"
    ? 130
    : signal === "SIGHUP"
    ? 129
    : undefined;
  const deadlineMs = scenario.startsWith("timeout-")
    ? 1_300
    : tightWindowRecoveryNowMs === undefined
    ? 10_000
    : 8_000;
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      ...(holdInheritedPipes ? ["sleep 30 &"] : []),
      ...(tightWindowRecoveryNowMs === undefined
        ? ["now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }"]
        : [
            "now_ms() {",
            '  if [[ -e "${destination_path:-}" ]]; then',
            `    printf '${String(tightWindowRecoveryNowMs)}\\n'`,
            "  else",
            "    printf '100\\n'",
            "  fi",
            "}",
          ]),
      "ps() {",
      '  if [[ "${1:-}" == eww ]]; then return 0; fi',
      '  command ps "$@"',
      "}",
      ...(scenario === "wrong-destination-bytes" ||
      scenario === "failure-after-rename"
          ? [
              "mv() {",
              '  command mv "$@" || return $?',
              ...(scenario === "wrong-destination-bytes"
                ? ['  printf wrong > "$destination_path"']
                : []),
              "  return 7",
              "}",
            ]
          : []),
      ...functions as string[],
      ...(forceTimeoutAfterRename
        ? [
            "atomic_rename_action() {",
            "  local wrapped_status=0",
            '  atomic_rename_action_original "$@" || wrapped_status=$?',
            '  if [[ "$wrapped_status" -eq 0 ]]; then',
            "    return 124",
            "  fi",
            '  return "$wrapped_status"',
            "}",
          ]
        : []),
      ...(injectAfterRecovery
        ? [
            "run_before_deadline() {",
            "  local wrapped_status=0",
            '  run_before_deadline_original "$@" || wrapped_status=$?',
            '  if [[ "${1:-}" == validate_atomic_rename_recovery ]]; then',
            `    kill -${String(signalName)} "$$"`,
            "  fi",
            '  return "$wrapped_status"',
            "}",
            `trap 'launcher_signal_status=${String(signalStatus)}' ${String(signalName)}`,
          ]
        : []),
      `source_path=${JSON.stringify(source)}`,
      `destination_path=${JSON.stringify(destination)}`,
      `action_marker=${JSON.stringify(actionMarker)}`,
      `outer_deadline_path=${JSON.stringify(outerDeadline)}`,
      `restored_deadline_path=${JSON.stringify(restoredDeadline)}`,
      "canonical_recovery_reserve_ms=1000",
      "launcher_signal_status=0",
      "terminal_commit_signal_status=0",
      "validate_harness_publication() {",
      '  local path="$1"',
      ...(blockBeforeRename
        ? [
            '  if [[ "$path" == "$source_path" ]]; then',
            '    : > "$action_marker"',
            "    sleep 30",
            "  fi",
          ]
        : []),
      ...(blockDuringRecovery
        ? [
            '  if [[ "$path" == "$destination_path" ]]; then',
            '    : > "$action_marker"',
            "    sleep 30",
            "  fi",
          ]
        : []),
      '  [[ -f "$path" && ! -L "$path" ]] || return 65',
      "  jq -e --arg runId run '",
      '    type == "object" and .runId == $runId and',
      '    .status == "succeeded" and .exitCode == 0',
      "  ' \"$path\" >/dev/null",
      ...(injectAfterRecovery && recoveryStatusAfterValidation !== 0
        ? [
            '  if [[ "$path" == "$destination_path" ]]; then',
            `    return ${String(recoveryStatusAfterValidation)}`,
            "  fi",
          ]
        : []),
      "}",
      `launcher_deadline_ms=${String(deadlineMs)}`,
      tightWindowRecoveryNowMs === undefined
        ? 'started_at_ms="$(now_ms)"'
        : "started_at_ms=0",
      'launcher_deadline_at_ms=$(( started_at_ms + launcher_deadline_ms ))',
      'controller_started_seconds="$SECONDS"',
      'launcher_absolute_deadline_at_ms="$launcher_deadline_at_ms"',
      'printf "%s\\n" "$launcher_deadline_at_ms" > "$outer_deadline_path"',
      'atomic_rename_before_deadline "$source_path" "$destination_path" validate_harness_publication',
      'status="$?"',
      'printf "%s\\n" "$launcher_deadline_at_ms" > "$restored_deadline_path"',
      'exit "$status"',
    ].join("\n"),
  );

  const process = Bun.spawn([shellPath, script], {
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdoutSettled = false;
  let stderrSettled = false;
  const stdoutPromise = new Response(process.stdout).text().then(
    (value) => {
      stdoutSettled = true;
      return value;
    },
    (error) => {
      stdoutSettled = true;
      throw error;
    },
  );
  const stderrPromise = new Response(process.stderr).text().then(
    (value) => {
      stderrSettled = true;
      return value;
    },
    (error) => {
      stderrSettled = true;
      throw error;
    },
  );
  const processTargetAlive = (target: number): boolean => {
    try {
      globalThis.process.kill(target, 0);
      return true;
    } catch {
      return false;
    }
  };
  const processAlive = (): boolean => processTargetAlive(process.pid);
  const processGroupAlive = (): boolean => processTargetAlive(-process.pid);
  let leaderExitedWithInheritedPipeHolder = false;
  const observedProcessExit = process.exited.then((exitCode) => {
    if (holdInheritedPipes) {
      leaderExitedWithInheritedPipeHolder =
        processGroupAlive() && !stdoutSettled && !stderrSettled;
    }
    return exitCode;
  });
  const stopOwnedProcess = async (): Promise<void> => {
    if (processGroupAlive()) {
      try {
        globalThis.process.kill(-process.pid, "SIGTERM");
      } catch {
        // The owned group exited between the liveness check and signal.
      }
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!processGroupAlive()) return;
      await Bun.sleep(10);
    }
    if (processGroupAlive()) {
      try {
        globalThis.process.kill(-process.pid, "SIGKILL");
      } catch {
        // The owned group exited between the liveness check and signal.
      }
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!processGroupAlive()) return;
      await Bun.sleep(10);
    }
  };
  let inheritedPipeFallbackUsed = false;
  const inheritedPipeFallback = holdInheritedPipes
    ? (async () => {
        const leaderExited = await Promise.race([
          observedProcessExit.then(() => true),
          Bun.sleep(5_000).then(() => false),
        ]);
        if (leaderExited) await Bun.sleep(250);
        if (processGroupAlive()) {
          inheritedPipeFallbackUsed = true;
          await stopOwnedProcess();
        }
      })()
    : Promise.resolve();
  const pathExists = async (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false,
    );
  let settled:
    | {
      exitCode: number;
      sourceExists: boolean;
      destinationExists: boolean;
      destinationIsSymlink: boolean;
      destinationBytes: string | undefined;
      deadlineRestored: boolean;
      childExitedBeforeMarker: boolean;
    }
    | undefined;
  let childExitedBeforeMarker = false;
  let processGroupAliveAfterCleanup = true;
  let rootExistsAfterCleanup = true;
  let stdout = "";
  let stderr = "";

  try {
    if (signal !== undefined && signalPoint !== "after-recovery") {
      const markerResult = await Promise.race([
        (async () => {
          for (let attempt = 0; attempt < 500; attempt += 1) {
            if (await Bun.file(actionMarker).exists()) {
              if (controllerObservationDelayMs > 0) {
                await Bun.sleep(controllerObservationDelayMs);
              }
              return "marker" as const;
            }
            await Bun.sleep(10);
          }
          return "timeout" as const;
        })(),
        process.exited.then((exitCode) => ({ exitCode }) as const),
      ]);
      if (typeof markerResult === "object") {
        childExitedBeforeMarker = true;
      } else if (markerResult === "marker") {
        process.kill(signal);
      }
    }
    const exitCode = await observedProcessExit;
    const sourceExists = await Bun.file(source).exists();
    const destinationExists = await Bun.file(destination).exists();
    const destinationIsSymlink =
      Bun.spawnSync(["test", "-L", destination]).exitCode === 0;
    const outerDeadlineExists = await Bun.file(outerDeadline).exists();
    const restoredDeadlineExists = await Bun.file(restoredDeadline).exists();
    settled = {
      exitCode,
      sourceExists,
      destinationExists,
      destinationIsSymlink,
      destinationBytes: destinationExists
        ? await Bun.file(destination).text()
        : undefined,
      deadlineRestored:
        outerDeadlineExists &&
        restoredDeadlineExists &&
        await Bun.file(outerDeadline).text() ===
          await Bun.file(restoredDeadline).text(),
      childExitedBeforeMarker,
    };
  } finally {
    await stopOwnedProcess();
    await observedProcessExit;
    [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    await inheritedPipeFallback;
    expect(processAlive()).toBe(false);
    await rm(root, { recursive: true, force: true });
    processGroupAliveAfterCleanup = processGroupAlive();
    rootExistsAfterCleanup = await pathExists(root);
    expect(processGroupAliveAfterCleanup).toBe(false);
    expect(rootExistsAfterCleanup).toBe(false);
  }
  if (settled === undefined) {
    throw new Error("atomic publication harness did not settle");
  }
  return {
    ...settled,
    stdout,
    stderr,
    processGroupAliveAfterCleanup,
    rootExistsAfterCleanup,
    leaderExitedWithInheritedPipeHolder,
    inheritedPipeFallbackUsed,
  };
}

async function runAtomicActionCutoffHarness(
  launcher: string,
): Promise<{
  exitCode: number;
  sourceExists: boolean;
  destinationExists: boolean;
  destinationBytes: string | undefined;
  validatorCompleted: boolean;
}> {
  const sha256 = extractShellFunction(launcher, "sha256_file");
  const action = extractShellFunction(launcher, "atomic_rename_action");
  if (sha256 === undefined || action === undefined) {
    return {
      exitCode: 99,
      sourceExists: true,
      destinationExists: false,
      destinationBytes: undefined,
      validatorCompleted: false,
    };
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-atomic-cutoff-"));
  const source = join(root, "stage.json");
  const destination = join(root, "canonical.json");
  const validatorMarker = join(root, "validator-complete");
  const script = join(root, "publish.sh");
  const expected = '{"runId":"run","status":"succeeded","exitCode":0}\n';
  await Bun.write(source, expected);
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      sha256,
      action,
      "remaining_launcher_ms() {",
      '  printf -v "$1" "%s" 0',
      "}",
      "validate_harness_publication() {",
      '  local path="$1"',
      '  [[ -f "$path" && ! -L "$path" ]] || return 65',
      "  jq -e '",
      '    type == "object" and .runId == "run" and',
      '    .status == "succeeded" and .exitCode == 0',
      "  ' \"$path\" >/dev/null || return $?",
      `  : > ${JSON.stringify(validatorMarker)}`,
      "}",
      `source_path=${JSON.stringify(source)}`,
      `destination_path=${JSON.stringify(destination)}`,
      'expected_sha256=$(sha256_file "$source_path") || exit $?',
      "atomic_rename_action \"$source_path\" \"$destination_path\" \\",
      "  \"$expected_sha256\" validate_harness_publication",
      'exit "$?"',
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await process.exited;
    const sourceExists = await Bun.file(source).exists();
    const destinationExists = await Bun.file(destination).exists();
    return {
      exitCode,
      sourceExists,
      destinationExists,
      destinationBytes: destinationExists
        ? await Bun.file(destination).text()
        : undefined,
      validatorCompleted: await Bun.file(validatorMarker).exists(),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runTerminalLedgerRecoveryDeadlineHarness(
  launcher: string,
  scenario: "cleanup-cutoff" | "pre-rename-signal" | "stalled-recovery",
  shellPath = "bash",
  holdInheritedPipes = false,
): Promise<{
  exitCode: number;
  ledger: string | undefined;
  expectedLedger: string;
  expectedSha256: string;
  recoveryOwner: "owned" | "unowned" | undefined;
  recoveryStarted: boolean;
  recoveryStartCount: number;
  launcherSignalStatus: number | undefined;
  recoveryTerminatedBeforeRelease: boolean;
  recoveryChildDeadBeforeRelease: boolean;
  remainingDescendants: string[];
  remainingProcessGroups: string[];
  stderr: string;
  childExitedBeforeMarker: boolean;
  processGroupAliveAfterCleanup: boolean;
  rootExistsAfterCleanup: boolean;
  leaderExitedWithInheritedPipeHolder: boolean;
  inheritedPipeFallbackUsed: boolean;
}> {
  const missingResult = {
    exitCode: 99,
    ledger: undefined,
    expectedLedger: "",
    expectedSha256: "",
    recoveryOwner: undefined,
    recoveryStarted: false,
    recoveryStartCount: 0,
    launcherSignalStatus: undefined,
    recoveryTerminatedBeforeRelease: false,
    recoveryChildDeadBeforeRelease: false,
    remainingDescendants: [],
    remainingProcessGroups: [],
    stderr: "required launcher function missing",
    childExitedBeforeMarker: false,
    processGroupAliveAfterCleanup: false,
    rootExistsAfterCleanup: false,
    leaderExitedWithInheritedPipeHolder: false,
    inheritedPipeFallbackUsed: false,
  } as const;
  const now = extractShellFunction(launcher, "now_ms");
  const sha256 = extractShellFunction(launcher, "sha256_file");
  const terminalRecord = extractShellFunction(
    launcher,
    "issue_ledger_has_terminal_commit",
  );
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const reserved = extractShellFunction(
    launcher,
    "run_before_deadline_with_reserve",
  );
  const release = extractNestedShellFunction(
    launcher,
    "release_failed_terminal_commit",
  );
  const commit = extractNestedShellFunction(launcher, "commit_terminal_evidence");
  const recovery = extractShellFunction(
    launcher,
    "validate_terminal_ledger_recovery",
  );
  if (
    now === undefined ||
    sha256 === undefined ||
    terminalRecord === undefined ||
    remaining === undefined ||
    bounded === undefined ||
    reserved === undefined ||
    release === undefined ||
    commit === undefined
  ) {
    return missingResult;
  }

  const mergeHookCount = commit.match(/\bmerge_issue_ledger\b/g)?.length ?? 0;
  const recoveryHookCount =
    (commit.match(/\bvalidate_terminal_ledger_recovery\b/g)?.length ?? 0) +
    (commit.match(/\bissue_ledger_has_terminal_commit\b/g)?.length ?? 0);
  if (mergeHookCount !== 1 || recoveryHookCount !== 1) return missingResult;
  let hookedCommit = commit.replace(
    /\bmerge_issue_ledger\b/,
    "harness_merge_issue_ledger",
  );
  hookedCommit = recovery === undefined
    ? hookedCommit.replace(
        /\bissue_ledger_has_terminal_commit\b/,
        "harness_validate_terminal_ledger_recovery",
      )
    : hookedCommit.replace(
        /\bvalidate_terminal_ledger_recovery\b/,
        "harness_validate_terminal_ledger_recovery",
      );
  const productionRecovery = recovery?.replace(
    "validate_terminal_ledger_recovery() {",
    "production_validate_terminal_ledger_recovery() {",
  );
  if (
    recovery !== undefined &&
    productionRecovery === recovery
  ) {
    return missingResult;
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-terminal-recovery-"));
  const ledger = join(root, "issues.jsonl");
  const stagedLedger = join(root, "issues.staged.jsonl");
  const baseLedger = join(root, "issues.base.jsonl");
  const mergeReady = join(root, "merge-ready");
  const mergeCommitted = join(root, "merge-committed");
  const mergeBlocker = join(root, "merge-blocker");
  const innerExpired = join(root, "inner-expired");
  const mergeRelease = join(root, "merge-release");
  const recoveryStarted = join(root, "recovery-started");
  const recoveryRelease = join(root, "recovery-release");
  const recoveryOwner = join(root, "recovery-owner");
  const recoveryTerminated = join(root, "recovery-terminated");
  const launcherSignalStatusPath = join(root, "launcher-signal-status");
  const mergePid = join(root, "merge.pid");
  const mergePgid = join(root, "merge.pgid");
  const recoveryPid = join(root, "recovery.pid");
  const recoveryPgid = join(root, "recovery.pgid");
  const deadlinePath = join(root, "deadline");
  const script = join(root, "terminal-recovery.sh");
  const reportSha256 = "1".repeat(64);
  const monitorSha256 = "2".repeat(64);
  const candidateSha256 = "3".repeat(64);
  const projectionSha256 = "4".repeat(64);
  const expectedLedger = `${JSON.stringify({
    id: "terminal",
    runId: "run",
    at: "2026-07-17T00:00:00.000Z",
    classification: "gate",
    stage: "finalize",
    elapsedMs: 0,
    evidence: "terminal",
    status: "resolved",
    terminalCommit: true,
    terminalCommitId: "commit",
    reportSha256,
    monitorSha256,
    candidateLedgerSha256: candidateSha256,
    latestProjectionSha256: projectionSha256,
  })}\n`;
  const expectedSha256 = createHash("sha256")
    .update(expectedLedger)
    .digest("hex");
  await Bun.write(stagedLedger, expectedLedger);
  await Bun.write(baseLedger, "base\n");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      ...(holdInheritedPipes ? ["sleep 30 &"] : []),
      now,
      sha256,
      terminalRecord,
      ...(productionRecovery === undefined ? [] : [productionRecovery]),
      remaining,
      bounded,
      reserved,
      release,
      hookedCommit,
      "atomic_rename_before_deadline() { return 0; }",
      "discard_private_path_before_deadline() { rm -f -- \"$1\"; }",
      "handle_finalize_signal() { exit \"$1\"; }",
      "harness_merge_issue_ledger() {",
      '  local worker_pid=""',
      `  command sh -c 'printf "%s\\n" "$PPID"' > ${JSON.stringify(mergePid)} || return $?`,
      `  IFS= read -r worker_pid < ${JSON.stringify(mergePid)} || return $?`,
      '  [[ "$worker_pid" =~ ^[1-9][0-9]*$ ]] || return 125',
      `  command ps -o pgid= -p "$worker_pid" > ${JSON.stringify(mergePgid)} || return $?`,
      ...(scenario === "pre-rename-signal"
        ? [
            `  trap ': > ${JSON.stringify(innerExpired)}; while [[ ! -e ${JSON.stringify(mergeRelease)} ]]; do sleep 0.01; done; exit 124' TERM`,
            `  : > ${JSON.stringify(mergeReady)}`,
            `  while [[ ! -e ${JSON.stringify(mergeRelease)} ]]; do sleep 0.01; done`,
          ]
        : []),
      `  command mv ${JSON.stringify(stagedLedger)} "$ledger" || return $?`,
      `  : > ${JSON.stringify(mergeCommitted)}`,
      ...(scenario === "pre-rename-signal"
        ? []
        : scenario === "cleanup-cutoff"
        ? [
            `  trap ': > ${JSON.stringify(innerExpired)}; exit 124' TERM`,
            "  IFS= read -r _ <&6",
          ]
        : [
            `  trap ': > ${JSON.stringify(innerExpired)}; while [[ ! -e ${JSON.stringify(mergeRelease)} ]]; do sleep 0.01; done; exit 124' TERM`,
            `  while [[ ! -e ${JSON.stringify(mergeRelease)} ]]; do sleep 0.01; done`,
          ]),
      "  return 124",
      "}",
      "harness_validate_terminal_ledger_recovery() {",
      '  local worker_pid=""',
      `  command sh -c 'printf "%s\\n" "$PPID"' > ${JSON.stringify(recoveryPid)} || return $?`,
      `  IFS= read -r worker_pid < ${JSON.stringify(recoveryPid)} || return $?`,
      '  [[ "$worker_pid" =~ ^[1-9][0-9]*$ ]] || return 125',
      `  command ps -o pgid= -p "$worker_pid" > ${JSON.stringify(recoveryPgid)} || return $?`,
      '  if [[ -n "${ORCA_IMPROVEMENT_COMMAND_OWNER:-}" ]]; then',
      `    printf 'owned\\n' > ${JSON.stringify(recoveryOwner)}`,
      "  else",
      `    printf 'unowned\\n' > ${JSON.stringify(recoveryOwner)}`,
      "  fi",
      `  printf 'started\\n' >> ${JSON.stringify(recoveryStarted)}`,
      ...(scenario === "stalled-recovery"
        ? [
            `  trap ': > ${JSON.stringify(recoveryTerminated)}; exit 143' TERM`,
            `  while [[ ! -e ${JSON.stringify(recoveryRelease)} ]]; do sleep 0.01; done`,
          ]
        : []),
      productionRecovery === undefined
        ? '  issue_ledger_has_terminal_commit "$@"'
        : '  production_validate_terminal_ledger_recovery "$@"',
      "}",
      ...(scenario === "cleanup-cutoff"
        ? [
            `command mkfifo ${JSON.stringify(mergeBlocker)}`,
            `exec 6<> ${JSON.stringify(mergeBlocker)}`,
          ]
        : []),
      "launcher_signal_status=0",
      "terminal_commit_signal_status=0",
      `trap 'printf "%s\\n" "$launcher_signal_status" > ${JSON.stringify(launcherSignalStatusPath)}' EXIT`,
      "terminal_commit_owned=false",
      "canonical_recovery_reserve_ms=1000",
      "mode=live",
      "final_status=0",
      `ledger=${JSON.stringify(ledger)}`,
      `candidate_ledger=${JSON.stringify(stagedLedger)}`,
      `ledger_base_snapshot=${JSON.stringify(baseLedger)}`,
      'terminal_commit_id="commit"',
      `terminal_report_sha256=${JSON.stringify(reportSha256)}`,
      `terminal_monitor_sha256=${JSON.stringify(monitorSha256)}`,
      `terminal_candidate_sha256=${JSON.stringify(candidateSha256)}`,
      `terminal_latest_projection_sha256=${JSON.stringify(projectionSha256)}`,
      `terminal_ledger_sha256=${JSON.stringify(expectedSha256)}`,
      `latest_tmp=${JSON.stringify(join(root, "latest.tmp"))}`,
      `latest=${JSON.stringify(join(root, "latest.json"))}`,
      'run_id="run"',
      "launcher_deadline_ms=10000",
      'started_at_ms="$(now_ms)"',
      'launcher_deadline_at_ms=$(( started_at_ms + launcher_deadline_ms ))',
      'controller_started_seconds="$SECONDS"',
      `printf '%s\\n' "$launcher_deadline_at_ms" > ${JSON.stringify(deadlinePath)}`,
      "commit_terminal_evidence",
      'exit "$?"',
    ].join("\n"),
  );
  const processTargetAlive = (target: number): boolean => {
    try {
      globalThis.process.kill(target, 0);
      return true;
    } catch {
      return false;
    }
  };
  const readRecordedId = async (path: string): Promise<string | undefined> => {
    if (!(await Bun.file(path).exists())) return undefined;
    const value = (await Bun.file(path).text()).trim();
    return /^[1-9]\d*$/.test(value) ? value : undefined;
  };
  const ownedPidPaths = [mergePid, recoveryPid];
  const ownedPgidPaths = [mergePgid, recoveryPgid];
  const liveOwnedPids = async (): Promise<string[]> => {
    const pids = await Promise.all(
      ownedPidPaths.map(async (path) =>
        await Bun.file(path).exists() ? (await Bun.file(path).text()).trim() : ""
      ),
    );
    return pids.filter((pid) =>
      /^[1-9]\d*$/.test(pid) && processTargetAlive(Number(pid))
    );
  };
  const liveOwnedGroups = async (): Promise<string[]> => {
    const pgids = await Promise.all(
      ownedPgidPaths.map(async (path) =>
        await Bun.file(path).exists() ? (await Bun.file(path).text()).trim() : ""
      ),
    );
    return pgids.filter((pgid) =>
      /^[1-9]\d*$/.test(pgid) && processTargetAlive(-Number(pgid))
    );
  };
  const harnessProcess = Bun.spawn([shellPath, script], {
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdoutSettled = false;
  let stderrSettled = false;
  const stdoutPromise = new Response(harnessProcess.stdout).text().then(
    (value) => {
      stdoutSettled = true;
      return value;
    },
    (error) => {
      stdoutSettled = true;
      throw error;
    },
  );
  const stderrPromise = new Response(harnessProcess.stderr).text().then(
    (value) => {
      stderrSettled = true;
      return value;
    },
    (error) => {
      stderrSettled = true;
      throw error;
    },
  );
  let observedExitCode: number | undefined;
  const harnessExited = harnessProcess.exited.then((exitCode) => {
    observedExitCode = exitCode;
    return exitCode;
  });
  let childExitedBeforeMarker = false;
  const waitForHarnessFile = async (path: string): Promise<boolean> => {
    for (let attempt = 0; attempt < 700; attempt += 1) {
      if (await Bun.file(path).exists()) return true;
      if (observedExitCode !== undefined) {
        childExitedBeforeMarker = true;
        return false;
      }
      await Bun.sleep(10);
    }
    return false;
  };
  const processGroupAlive = (): boolean => {
    try {
      globalThis.process.kill(-harnessProcess.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let leaderExitedWithInheritedPipeHolder = false;
  const observedHarnessExit = harnessExited.then((exitCode) => {
    if (holdInheritedPipes) {
      leaderExitedWithInheritedPipeHolder =
        processGroupAlive() && !stdoutSettled && !stderrSettled;
    }
    return exitCode;
  });
  const cleanupTargets = new Set<number>([
    harnessProcess.pid,
    -harnessProcess.pid,
  ]);
  const refreshCleanupTargets = async (): Promise<void> => {
    for (const path of ownedPidPaths) {
      const pid = await readRecordedId(path);
      if (pid !== undefined) cleanupTargets.add(Number(pid));
    }
    for (const path of ownedPgidPaths) {
      const pgid = await readRecordedId(path);
      if (pgid !== undefined) cleanupTargets.add(-Number(pgid));
    }
  };
  const waitForCleanupTargets = async (
    signal: NodeJS.Signals,
  ): Promise<boolean> => {
    const signaledTargets = new Set<number>();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await refreshCleanupTargets();
      const liveTargets = [...cleanupTargets].filter((target) =>
        processTargetAlive(target)
      );
      if (liveTargets.length === 0) return true;
      for (const target of liveTargets) {
        if (signaledTargets.has(target)) continue;
        signaledTargets.add(target);
        try {
          globalThis.process.kill(target, signal);
        } catch {
          // The process exited between the liveness check and signal.
        }
      }
      await Bun.sleep(10);
    }
    return false;
  };
  let inheritedPipeFallbackUsed = false;
  const inheritedPipeFallback = holdInheritedPipes
    ? (async () => {
        await observedHarnessExit;
        await Bun.sleep(250);
        if (processGroupAlive()) {
          inheritedPipeFallbackUsed = true;
          if (!(await waitForCleanupTargets("SIGTERM"))) {
            await waitForCleanupTargets("SIGKILL");
          }
        }
      })()
    : Promise.resolve();
  let recoveryTerminatedBeforeRelease = false;
  let recoveryChildDeadBeforeRelease = false;
  let processGroupAliveAfterCleanup = true;
  let rootExistsAfterCleanup = true;
  let settled:
    | {
      exitCode: number;
      ledger: string | undefined;
      expectedLedger: string;
      expectedSha256: string;
      recoveryOwner: "owned" | "unowned" | undefined;
      recoveryStarted: boolean;
      recoveryStartCount: number;
      launcherSignalStatus: number | undefined;
      recoveryTerminatedBeforeRelease: boolean;
      recoveryChildDeadBeforeRelease: boolean;
      remainingDescendants: string[];
      remainingProcessGroups: string[];
      childExitedBeforeMarker: boolean;
    }
    | undefined;
  let stderr = "";
  try {
    let markerReady = await waitForHarnessFile(
      scenario === "pre-rename-signal" ? mergeReady : mergeCommitted,
    );
    if (markerReady && scenario === "pre-rename-signal") {
      globalThis.process.kill(harnessProcess.pid, "SIGTERM");
    }
    if (markerReady) markerReady = await waitForHarnessFile(innerExpired);
    if (markerReady && scenario !== "cleanup-cutoff") {
      await Bun.write(mergeRelease, "release\n");
    }
    if (markerReady) {
      markerReady = await waitForHarnessFile(recoveryStarted);
    }
    if (markerReady && scenario === "stalled-recovery") {
      const deadlineAt = Number((await Bun.file(deadlinePath).text()).trim());
      while (Date.now() <= deadlineAt + 150) await Bun.sleep(10);
      try {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          recoveryTerminatedBeforeRelease = await Bun.file(
            recoveryTerminated,
          ).exists();
          const pid = await readRecordedId(recoveryPid);
          recoveryChildDeadBeforeRelease =
            pid !== undefined && !processTargetAlive(Number(pid));
          if (
            recoveryTerminatedBeforeRelease &&
            recoveryChildDeadBeforeRelease
          ) {
            break;
          }
          await Bun.sleep(10);
        }
      } finally {
        await Bun.write(recoveryRelease, "release\n");
      }
    }
    const exitCode = await observedHarnessExit;
    const ownerValue = await Bun.file(recoveryOwner).exists()
      ? (await Bun.file(recoveryOwner).text()).trim()
      : "";
    const recoveryStartCount = await Bun.file(recoveryStarted).exists()
      ? (await Bun.file(recoveryStarted).text()).trimEnd().split("\n").length
      : 0;
    const signalStatusValue = await Bun.file(launcherSignalStatusPath).exists()
      ? Number((await Bun.file(launcherSignalStatusPath).text()).trim())
      : undefined;
    settled = {
      exitCode,
      ledger: await Bun.file(ledger).exists()
        ? await Bun.file(ledger).text()
        : undefined,
      expectedLedger,
      expectedSha256,
      recoveryOwner: ownerValue === "owned" || ownerValue === "unowned"
        ? ownerValue
        : undefined,
      recoveryStarted: await Bun.file(recoveryStarted).exists(),
      recoveryStartCount,
      launcherSignalStatus: Number.isInteger(signalStatusValue)
        ? signalStatusValue
        : undefined,
      recoveryTerminatedBeforeRelease,
      recoveryChildDeadBeforeRelease,
      remainingDescendants: await liveOwnedPids(),
      remainingProcessGroups: await liveOwnedGroups(),
      childExitedBeforeMarker,
    };
  } finally {
    try {
      if (!(await waitForCleanupTargets("SIGTERM"))) {
        await waitForCleanupTargets("SIGKILL");
      }
      await observedHarnessExit;
      [, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      await inheritedPipeFallback;
      await refreshCleanupTargets();
      expect(await liveOwnedPids()).toEqual([]);
      expect(await liveOwnedGroups()).toEqual([]);
      expect(
        [...cleanupTargets].filter((target) => processTargetAlive(target)),
      ).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      processGroupAliveAfterCleanup = processGroupAlive();
      rootExistsAfterCleanup = await stat(root).then(
        () => true,
        () => false,
      );
      expect(processGroupAliveAfterCleanup).toBe(false);
      expect(rootExistsAfterCleanup).toBe(false);
    }
  }
  if (settled === undefined) {
    throw new Error("terminal ledger recovery harness did not settle");
  }
  return {
    ...settled,
    stderr,
    processGroupAliveAfterCleanup,
    rootExistsAfterCleanup,
    leaderExitedWithInheritedPipeHolder,
    inheritedPipeFallbackUsed,
  };
}

async function runPrivateCleanupHarness(
  launcher: string,
  target: "file" | "directory",
  remainingMs: 0 | 5_000,
): Promise<{ exitCode: number; pathExists: boolean }> {
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const fileCleanup = extractShellFunction(
    launcher,
    "discard_private_path_before_deadline",
  );
  const directoryCleanup = extractShellFunction(
    launcher,
    "discard_private_directory_before_deadline",
  );
  if (
    remaining === undefined ||
    bounded === undefined ||
    fileCleanup === undefined ||
    directoryCleanup === undefined
  ) {
    return { exitCode: 99, pathExists: true };
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-private-cleanup-"));
  const path = join(root, target);
  const script = join(root, "cleanup.sh");
  if (target === "file") {
    await Bun.write(path, "private\n");
  } else {
    await mkdir(path);
  }
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { printf '1000\\n'; }",
      "ps() {",
      '  if [[ "${1:-}" == eww ]]; then return 0; fi',
      '  command ps "$@"',
      "}",
      remaining,
      bounded,
      fileCleanup,
      directoryCleanup,
      "launcher_signal_status=0",
      "terminal_commit_signal_status=0",
      `launcher_deadline_ms=${String(remainingMs)}`,
      "started_at_ms=1000",
      `launcher_deadline_at_ms=${String(1_000 + remainingMs)}`,
      'controller_started_seconds="$SECONDS"',
      `${target === "file" ? "discard_private_path_before_deadline" : "discard_private_directory_before_deadline"} ${JSON.stringify(path)}`,
      'exit "$?"',
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await process.exited;
    const pathExists = await stat(path).then(
      () => true,
      () => false,
    );
    return { exitCode, pathExists };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCanonicalRouteHarness(
  launcher: string,
  route: CanonicalPublicationRoute,
  scenario: CanonicalRouteScenario,
): Promise<{
  exitCode: number;
  sourceExists: boolean;
  sourceBytes: string | undefined;
  destinationExists: boolean;
  destinationBytes: string | undefined;
  stderr: string;
}> {
  const topLevelNames = [
    "sha256_file",
    "remaining_launcher_ms",
    "run_before_deadline",
    "run_before_deadline_with_reserve",
    "capture_command_output",
    "capture_before_deadline",
    "validate_regular_publication_file",
    "validate_latest_publication_file",
    "validate_preflight_publication_file",
    "validate_failure_tombstone_file",
    "atomic_rename_action",
    "validate_atomic_rename_recovery",
    "atomic_rename_before_deadline",
    "discard_private_path_before_deadline",
    "quarantine_prior_evidence",
    "write_failure_tombstone",
  ] as const;
  const nestedNames = [
    "record_finalize_failure",
    "quarantine_current_latest",
    "publish_latest_failure_tombstone",
    "release_failed_terminal_commit",
    "commit_terminal_evidence",
  ] as const;
  const topLevel = new Map(
    topLevelNames.map((name) => [name, extractShellFunction(launcher, name)]),
  );
  const nested = new Map(
    nestedNames.map((name) => [name, extractNestedShellFunction(launcher, name)]),
  );
  if (
    [...topLevel.values(), ...nested.values()].some(
      (value) => value === undefined,
    )
  ) {
    return {
      exitCode: 99,
      sourceExists: true,
      sourceBytes: undefined,
      destinationExists: false,
      destinationBytes: undefined,
      stderr: "missing extracted function",
    };
  }
  const fn = (name: typeof topLevelNames[number]): string =>
    topLevel.get(name) as string;
  const nestedFn = (name: typeof nestedNames[number]): string =>
    nested.get(name) as string;
  const renamed = (source: string, from: string, to: string): string =>
    source.replace(`${from}() {`, `${to}() {`);

  const root = await mkdtemp(join(tmpdir(), "orcats-canonical-route-"));
  const script = join(root, "route.sh");
  const sourceMarker = join(root, "source-path");
  const destinationMarker = join(root, "destination-path");
  const latest = join(root, "latest.json");
  const latestQuarantine = join(root, "latest.json.superseded");
  const latestTmp = join(root, "latest.json.tmp");
  const preflightStage = join(root, "preflight.json.stage");
  const preflightPath = join(root, "preflight.json");
  const preflightQuarantine = join(root, "preflight.json.superseded");
  const ledgerSnapshot = join(root, "issues.base.jsonl");
  const candidateLedger = join(root, "candidate-issues.jsonl");
  const regularBytes = `{"route":${JSON.stringify(route)}}\n`;
  const latestBytes = '{"runId":"run","exitCode":0}\n';
  const preflightBytes =
    '{"runId":"run","status":"succeeded","exitCode":0}\n';
  if (route === "prior-quarantine" || route === "current-quarantine") {
    await Bun.write(latest, regularBytes);
  } else if (route === "latest-commit") {
    await Bun.write(latestTmp, latestBytes);
  } else if (route === "preflight-commit") {
    await Bun.write(latestTmp, latestBytes);
    await Bun.write(preflightStage, preflightBytes);
  }
  await Bun.write(ledgerSnapshot, "base\n");
  await Bun.write(candidateLedger, "candidate\n");

  const productionBounded = renamed(
    fn("run_before_deadline"),
    "run_before_deadline",
    "production_run_before_deadline",
  );
  const productionCapture = renamed(
    fn("capture_before_deadline"),
    "capture_before_deadline",
    "production_capture_before_deadline",
  );
  const productionAtomic = renamed(
    fn("atomic_rename_before_deadline"),
    "atomic_rename_before_deadline",
    "production_atomic_rename_before_deadline",
  );
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      `route=${JSON.stringify(route)}`,
      `route_scenario=${JSON.stringify(scenario)}`,
      "force_cutoff=false",
      "now_ms() {",
      '  if [[ "$force_cutoff" == true ]]; then',
      '    printf "%s\\n" "$launcher_deadline_at_ms"',
      "  else",
      "    printf '100\\n'",
      "  fi",
      "}",
      "ps() {",
      '  if [[ "${1:-}" == eww ]]; then return 0; fi',
      '  command ps "$@"',
      "}",
      fn("sha256_file"),
      fn("remaining_launcher_ms"),
      productionBounded,
      "run_before_deadline() {",
      '  local command_name="${1:-}"',
      "  local status=0",
      '  production_run_before_deadline "$@" || status=$?',
      '  if [[ "$route_scenario" == exact-zero &&',
      '    "$route" == failure-tombstone &&',
      '    "$command_name" == write_failure_tombstone &&',
      '    "$status" -eq 0 ]]; then',
      "    force_cutoff=true",
      "  fi",
      '  return "$status"',
      "}",
      fn("run_before_deadline_with_reserve"),
      fn("capture_command_output"),
      productionCapture,
      "capture_before_deadline() {",
      '  production_capture_before_deadline "$@" || return $?',
      '  if [[ "$route_scenario" == source-hash-mismatch &&',
      '    "${1:-}" == expected_sha256 &&',
      '    "${2:-}" == sha256_file &&',
      '    "${3:-}" == "$route_source" ]]; then',
      '    printf "\\n" >> "$route_source" || return $?',
      "  fi",
      "}",
      fn("validate_regular_publication_file"),
      fn("validate_latest_publication_file"),
      fn("validate_preflight_publication_file"),
      fn("validate_failure_tombstone_file"),
      fn("atomic_rename_action"),
      fn("validate_atomic_rename_recovery"),
      productionAtomic,
      "atomic_rename_before_deadline() {",
      "  local destination_path=\"$2\"",
      "  local status=0",
      '  production_atomic_rename_before_deadline "$@" || status=$?',
      '  if [[ "$route_scenario" == exact-zero &&',
      '    "$route" == preflight-commit &&',
      '    "$destination_path" == "$latest" &&',
      '    "$status" -eq 0 ]]; then',
      "    force_cutoff=true",
      "  fi",
      '  return "$status"',
      "}",
      fn("discard_private_path_before_deadline"),
      fn("quarantine_prior_evidence"),
      fn("write_failure_tombstone"),
      nestedFn("record_finalize_failure"),
      nestedFn("quarantine_current_latest"),
      nestedFn("publish_latest_failure_tombstone"),
      nestedFn("release_failed_terminal_commit"),
      nestedFn("commit_terminal_evidence"),
      "merge_issue_ledger() { return 0; }",
      `run_id=${JSON.stringify("run")}`,
      `mode=${JSON.stringify(route === "preflight-commit" ? "preflight" : "live")}`,
      "final_status=0",
      "launcher_signal_status=0",
      "terminal_commit_signal_status=0",
      "terminal_commit_owned=false",
      "canonical_recovery_reserve_ms=1000",
      "launcher_deadline_ms=10000",
      "started_at_ms=0",
      "launcher_deadline_at_ms=10000",
      'controller_started_seconds="$SECONDS"',
      `latest=${JSON.stringify(latest)}`,
      `latest_quarantine=${JSON.stringify(latestQuarantine)}`,
      `latest_tmp=${JSON.stringify(latestTmp)}`,
      `preflight_stage=${JSON.stringify(preflightStage)}`,
      `preflight_path=${JSON.stringify(preflightPath)}`,
      `preflight_quarantine=${JSON.stringify(preflightQuarantine)}`,
      `ledger_base_snapshot=${JSON.stringify(ledgerSnapshot)}`,
      `candidate_ledger=${JSON.stringify(candidateLedger)}`,
      'terminal_commit_id="commit"',
      'terminal_report_sha256="report"',
      'terminal_monitor_sha256="monitor"',
      'terminal_candidate_sha256="candidate"',
      'terminal_latest_projection_sha256="projection"',
      'terminal_ledger_sha256="ledger"',
      `source_marker=${JSON.stringify(sourceMarker)}`,
      `destination_marker=${JSON.stringify(destinationMarker)}`,
      "case \"$route\" in",
      '  prior-quarantine) route_source="$latest"; route_destination="$latest_quarantine" ;;',
      '  current-quarantine) route_source="$latest"; route_destination="$latest_tmp" ;;',
      '  failure-tombstone) route_source="${latest}.failure.${run_id}.$$"; route_destination="$latest" ;;',
      '  latest-commit) route_source="$latest_tmp"; route_destination="$latest" ;;',
      '  preflight-commit) route_source="$preflight_stage"; route_destination="$preflight_path" ;;',
      "  *) exit 64 ;;",
      "esac",
      'printf "%s" "$route_source" > "$source_marker"',
      'printf "%s" "$route_destination" > "$destination_marker"',
      'if [[ "$route_scenario" == exact-zero &&',
      '  "$route" != failure-tombstone &&',
      '  "$route" != preflight-commit ]]; then',
      "  force_cutoff=true",
      "fi",
      "case \"$route\" in",
      "  prior-quarantine) quarantine_prior_evidence ;;",
      "  current-quarantine) quarantine_current_latest ;;",
      "  failure-tombstone) publish_latest_failure_tombstone 74 ;;",
      "  latest-commit|preflight-commit) commit_terminal_evidence ;;",
      "  *) exit 64 ;;",
      "esac",
      'exit "$?"',
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderrPromise = new Response(process.stderr).text();
    const exitCode = await process.exited;
    const stderr = await stderrPromise;
    const sourcePath = await Bun.file(sourceMarker).text();
    const destinationPath = await Bun.file(destinationMarker).text();
    const sourceExists = await stat(sourcePath).then(
      () => true,
      () => false,
    );
    const destinationExists = await stat(destinationPath).then(
      () => true,
      () => false,
    );
    return {
      exitCode,
      sourceExists,
      sourceBytes: sourceExists ? await Bun.file(sourcePath).text() : undefined,
      destinationExists,
      destinationBytes: destinationExists
        ? await Bun.file(destinationPath).text()
        : undefined,
      stderr,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("value is not JSON-safe");
  return encoded;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hasAuthoritativePreflightPair(
  latest: Record<string, unknown> | undefined,
  preflight: Record<string, unknown> | undefined,
): boolean {
  if (latest === undefined || preflight === undefined) return false;
  const expectedPreflightKeys = [
    "artifactDigest",
    "baseSha",
    "checkedAt",
    "checkedAtMs",
    "elapsedMs",
    "exitCode",
    "expiresAtMs",
    "originFetchUrl",
    "originPushUrl",
    "repository",
    "runId",
    "runtimeHead",
    "runtimeSha256",
    "status",
    "supervisorStatus",
    "terminalProof",
    "workerCompletedAtMs",
    "workerExitCode",
  ];
  if (
    JSON.stringify(Object.keys(preflight).sort()) !==
      JSON.stringify(expectedPreflightKeys) ||
    preflight.status !== "succeeded" ||
    preflight.exitCode !== 0 ||
    preflight.workerExitCode !== 0 ||
    preflight.supervisorStatus !== "terminal" ||
    latest.mode !== "preflight" ||
    latest.exitCode !== 0 ||
    latest.runId !== preflight.runId ||
    latest.runtimeHead !== preflight.runtimeHead ||
    latest.runtimeSha256 !== preflight.runtimeSha256 ||
    latest.preflightArtifactDigest !== preflight.artifactDigest ||
    latest.preflightBaseSha !== preflight.baseSha ||
    typeof latest.preflightPath !== "string" ||
    latest.preflightPath.length === 0 ||
    typeof preflight.runId !== "string" ||
    preflight.runId.length === 0 ||
    typeof preflight.terminalProof !== "string" ||
    !/^[0-9a-f]{64}$/.test(preflight.terminalProof) ||
    !isNonnegativeInteger(preflight.elapsedMs) ||
    !isNonnegativeInteger(preflight.workerCompletedAtMs) ||
    !isNonnegativeInteger(preflight.checkedAtMs) ||
    !isNonnegativeInteger(preflight.expiresAtMs) ||
    preflight.workerCompletedAtMs > preflight.checkedAtMs ||
    preflight.checkedAtMs > preflight.expiresAtMs
  ) {
    return false;
  }
  const proofInput = { ...preflight };
  delete proofInput.terminalProof;
  return sha256Text(`${stableJson(proofInput)}\n`) === preflight.terminalProof;
}

function hasAuthoritativeLivePair(
  latest: Record<string, unknown> | undefined,
  ledger: string | undefined,
): boolean {
  if (
    latest === undefined ||
    ledger === undefined ||
    latest.mode !== "live" ||
    latest.exitCode !== 0
  ) {
    return false;
  }
  const claims = [
    "ledgerSha256",
    "candidateLedgerSha256",
    "reportSha256",
    "monitorSha256",
    "latestProjectionSha256",
    "terminalProof",
  ] as const;
  if (
    typeof latest.runId !== "string" ||
    typeof latest.terminalCommitId !== "string" ||
    latest.terminalCommitId.length === 0 ||
    claims.some((claim) =>
      typeof latest[claim] !== "string" ||
      !/^[0-9a-f]{64}$/.test(latest[claim] as string)
    )
  ) {
    return false;
  }
  const ledgerSha256 = sha256Text(ledger);
  if (latest.ledgerSha256 !== ledgerSha256) return false;
  const projection = { ...latest };
  delete projection.ledgerSha256;
  delete projection.latestProjectionSha256;
  delete projection.terminalProof;
  const projectionSha256 = sha256Text(`${stableJson(projection)}\n`);
  if (latest.latestProjectionSha256 !== projectionSha256) return false;
  const proof = sha256Text(
    [
      latest.terminalCommitId,
      latest.ledgerSha256,
      latest.candidateLedgerSha256,
      latest.reportSha256,
      latest.monitorSha256,
      latest.latestProjectionSha256,
      "",
    ].join("\n"),
  );
  if (latest.terminalProof !== proof) return false;
  let rows: Record<string, unknown>[];
  try {
    rows = ledger.trim().split("\n").filter(Boolean).map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new TypeError("ledger row must be an object");
      return parsed;
    });
  } catch {
    return false;
  }
  return rows.filter((row) =>
    row.terminalCommit === true &&
    row.runId === latest.runId &&
    row.terminalCommitId === latest.terminalCommitId &&
    row.reportSha256 === latest.reportSha256 &&
    row.monitorSha256 === latest.monitorSha256 &&
    row.candidateLedgerSha256 === latest.candidateLedgerSha256 &&
    row.latestProjectionSha256 === latest.latestProjectionSha256
  ).length === 1;
}

async function runBlockedRedirectionHarness(
  launcher: string,
  target: "capture" | "render",
): Promise<{ exitCode: number; elapsedMs: number }> {
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const action = target === "capture"
    ? extractShellFunction(launcher, "capture_command_output")
    : extractShellFunction(launcher, "render_latest_evidence_action");
  const render = target === "render"
    ? extractNestedShellFunction(launcher, "render_latest_evidence")
    : undefined;
  if (
    remaining === undefined ||
    bounded === undefined ||
    action === undefined ||
    (target === "render" && render === undefined)
  ) {
    return { exitCode: 99, elapsedMs: 0 };
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-blocked-redirection-"));
  const blocked = join(root, "blocked.fifo");
  const script = join(root, "redirect.sh");
  expect(Bun.spawnSync(["mkfifo", blocked]).exitCode).toBe(0);
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      "ps() {",
      '  if [[ "${1:-}" == eww ]]; then return 0; fi',
      '  command ps "$@"',
      "}",
      remaining,
      bounded,
      action,
      ...(render === undefined ? [] : [render]),
      "launcher_signal_status=0",
      "terminal_commit_signal_status=0",
      'launcher_deadline_at_ms=$(( $(now_ms) + 300 ))',
      `latest_tmp=${JSON.stringify(blocked)}`,
      'terminal_latest_projection_sha256=""',
      'final_status=1',
      'run_id="run"',
      'branch="branch"',
      `worktree=${JSON.stringify(root)}`,
      'complexity="simple"',
      `mode=${JSON.stringify(target)}`,
      'phase="finalize"',
      'launcher_log="log"',
      'monitor_path=""',
      'report_path=""',
      'ledger="ledger"',
      'pr_url=""',
      'runtime_path="runtime"',
      'runtime_head="head"',
      'runtime_sha256="sha"',
      'runtime_version="version"',
      'final_base_sha="base"',
      'final_artifact_digest="digest"',
      'final_preflight_path="preflight"',
      'final_preflight_digest="digest"',
      'final_preflight_base_sha="base"',
      'final_protected_package_lock="lock"',
      'final_package_lock_before="before"',
      'final_package_lock_after="after"',
      'terminal_commit_id="commit"',
      'terminal_ledger_sha256=""',
      'terminal_candidate_sha256=""',
      'terminal_report_sha256=""',
      'terminal_monitor_sha256=""',
      'terminal_proof=""',
      'elapsed_ms=1',
      target === "capture"
        ? `run_before_deadline capture_command_output ${JSON.stringify(blocked)} printf captured`
        : "render_latest_evidence",
      'exit "$?"',
    ].join("\n"),
  );

  const startedAt = Date.now();
  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: await process.exited,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runMergeProtectionValidator(
  launcher: string,
  protection: Record<string, unknown>,
): Promise<number> {
  const validator = extractShellFunction(
    launcher,
    "validate_required_merge_protection",
  );
  expect(validator).toBeDefined();
  if (validator === undefined) return 99;
  const root = await mkdtemp(join(tmpdir(), "orcats-merge-protection-"));
  const script = join(root, "validate.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      validator,
      `printf '%s\\n' ${JSON.stringify(JSON.stringify(protection))} | validate_required_merge_protection Verify 15368`,
    ].join("\n"),
  );
  try {
    return await Bun.spawn(["bash", script], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function extractShellArray(source: string, name: string): string[] | undefined {
  const body = source.match(
    new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)$`, "m"),
  )?.[1];
  if (body === undefined) return undefined;
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  const values = lines.map((line) => line.match(/^  "([^"]+)"$/)?.[1]);
  if (values.some((value) => value === undefined)) return undefined;
  return values as string[];
}

function ledgerFullPrefixContractIssues(source: string): string[] {
  const merge = extractShellFunction(source, "merge_issue_ledger");
  if (merge === undefined) return ["launcher must define merge_issue_ledger"];
  const issues: string[] = [];
  for (const required of [
    'target_bytes=$(wc -c < "$target_ledger"',
    '"$target_bytes" -lt "$base_bytes"',
    'cmp -s "$base_ledger"',
    '<(dd if="$target_ledger" bs=1 count="$base_bytes"',
  ]) {
    if (!merge.includes(required)) {
      issues.push("ledger merge must byte-compare the complete captured base");
      break;
    }
  }
  if (!merge.includes('if ! has_base_ledger_prefix "$ledger"; then')) {
    issues.push("source ledger must retain the complete captured base");
  }
  if (!merge.includes('if ! has_base_ledger_prefix "$candidate_ledger"; then')) {
    issues.push("candidate ledger must retain the complete captured base");
  }
  return issues;
}

function ledgerLockContractIssues(source: string): string[] {
  const merge = extractShellFunction(source, "merge_issue_ledger");
  if (merge === undefined) return ["launcher must define merge_issue_ledger"];
  const issues: string[] = [];
  for (const forbidden of [
    'mv "$ledger_lock"',
    'rm -rf "$ledger_lock"',
    'rm -fr "$ledger_lock"',
  ]) {
    if (merge.includes(forbidden)) {
      issues.push("ledger lock must never be renamed or recursively deleted");
      break;
    }
  }
  for (const required of [
    'ledger_lock_owner_name="owner.$$.$RANDOM"',
    "inspect_ledger_lock()",
    "verify_owned_ledger_lock()",
    'if ! verify_owned_ledger_lock; then',
    'rm -- "$ledger_lock_owner_marker"',
    'rmdir "$ledger_lock"',
    '"$inspected_owner_marker"',
    'kill -0 "$inspected_owner_pid"',
  ]) {
    if (!merge.includes(required)) {
      issues.push(`ledger owner-marker protocol missing: ${required}`);
    }
  }
  if (merge.includes('rm -f "$ledger_lock_owner_marker"')) {
    issues.push("ledger release must fail if its exact marker disappeared");
  }
  const acquireLoop = merge.indexOf("  while true; do");
  const deadlineCheck = merge.indexOf(
    "remaining_launcher_ms remaining_ms || return 124",
    acquireLoop,
  );
  const lockCreate = merge.indexOf('if mkdir "$ledger_lock"', acquireLoop);
  if (
    acquireLoop < 0 ||
    deadlineCheck < acquireLoop ||
    lockCreate < acquireLoop ||
    deadlineCheck > lockCreate
  ) {
    issues.push("every ledger acquisition or recovery attempt must start bounded");
  }
  return issues;
}

function terminalPackageLockContractIssues(source: string): string[] {
  const finalizer = extractShellFunction(source, "finalize");
  if (finalizer === undefined) return ["launcher must define finalizer"];
  const commit = finalizer.match(
    /  commit_terminal_evidence\(\) \{[\s\S]*?\n  \}\n\n  render_latest_evidence/,
  )?.[0];
  if (commit === undefined) {
    return ["finalizer must define terminal evidence commit"];
  }
  const checks = [...finalizer.matchAll(/assert_package_lock_unchanged/g)];
  const preflightStage = finalizer.indexOf(
    'run_before_deadline publish_preflight_attestation "$preflight_stage"',
  );
  const call = finalizer.indexOf("    commit_terminal_evidence");
  const diagnostics = finalizer.indexOf('  echo "exit=$final_status"');
  const latestCommit = commit.indexOf("validate_latest_publication_file");
  const preflightCommit = commit.indexOf(
    "validate_preflight_publication_file",
  );
  const committedExit = commit.indexOf("      exit 0", preflightCommit);
  const terminalCheck = checks.at(-1)?.index ?? -1;
  const issues: string[] = [];
  if (checks.length !== 2) {
    issues.push("finalizer must check package-lock before staging and before success publication");
  }
  if (
    preflightStage < 0 ||
    call < 0 ||
    diagnostics < 0 ||
    latestCommit < 0 ||
    preflightCommit < 0 ||
    committedExit < 0 ||
    terminalCheck <= preflightStage ||
    diagnostics <= terminalCheck ||
    call <= diagnostics ||
    preflightCommit <= latestCommit ||
    committedExit <= preflightCommit
  ) {
    issues.push(
      "terminal package-lock check must follow private staging and precede latest then preflight publication",
    );
  }
  if (
    commit
      .slice(
        preflightCommit + "validate_preflight_publication_file".length,
        committedExit,
      )
      .match(/\b(?:rm|mv|jq|echo)\b/)
  ) {
    issues.push("preflight publication must be the irrevocable commit point");
  }
  if (!finalizer.slice(terminalCheck, call).includes(
    'render_latest_evidence',
  )) {
    issues.push("terminal package-lock failure must publish only failure-shaped latest evidence");
  }
  return issues;
}

async function runIssueLedgerValidatorHarness(
  validator: string,
  ledger: string,
  options: { shellPath?: string; timeoutMs?: number } = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  processGroupAliveAfterCleanup: boolean;
  rootExistsAfterCleanup: boolean;
}> {
  const root = await mkdtemp(join(tmpdir(), "orcats-ledger-validator-"));
  const script = join(root, "validate-ledger.sh");
  const stdoutPath = join(root, "stdout.log");
  const stderrPath = join(root, "stderr.log");
  let process: ReturnType<typeof Bun.spawn> | undefined;
  const processGroupAlive = (): boolean => {
    if (process === undefined) return false;
    try {
      globalThis.process.kill(-process.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForProcessGroupExit = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!processGroupAlive()) return true;
      await Bun.sleep(10);
    }
    return !processGroupAlive();
  };
  const stopOwnedProcessGroup = async (): Promise<void> => {
    if (process !== undefined && processGroupAlive()) {
      try {
        globalThis.process.kill(-process.pid, "SIGTERM");
      } catch {}
      if (!await waitForProcessGroupExit()) {
        try {
          globalThis.process.kill(-process.pid, "SIGKILL");
        } catch {}
        await waitForProcessGroupExit();
      }
    }
    if (processGroupAlive()) {
      throw new Error("issue ledger validator process group survived cleanup");
    }
  };
  let processGroupAliveAfterCleanup = false;
  let rootExistsAfterCleanup = true;
  let settled:
    | {
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }
    | undefined;
  try {
    await Bun.write(
      script,
      [
        "#!/usr/bin/env bash",
        "set -u",
        validator,
        'validate_issue_ledger "$1"',
      ].join("\n"),
    );
    await Promise.all([
      Bun.write(stdoutPath, ""),
      Bun.write(stderrPath, ""),
    ]);
    process = Bun.spawn([options.shellPath ?? "bash", script, ledger], {
      detached: true,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const observedExit = process.exited;
    const outcome = await Promise.race([
      observedExit.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      Bun.sleep(options.timeoutMs ?? 10_000).then(() => ({
        kind: "timeout" as const,
      })),
    ]);
    const timedOut = outcome.kind === "timeout";
    if (timedOut) await stopOwnedProcessGroup();
    const leaderExitCode = await observedExit;
    if (processGroupAlive()) await stopOwnedProcessGroup();
    if (processGroupAlive()) {
      throw new Error("issue ledger validator process group survived cleanup");
    }
    const [stdout, stderr] = await Promise.all([
      Bun.file(stdoutPath).text(),
      Bun.file(stderrPath).text(),
    ]);
    settled = {
      exitCode: timedOut ? 124 : leaderExitCode,
      stdout,
      stderr,
      timedOut,
    };
  } finally {
    let processCleanupError: unknown;
    try {
      await stopOwnedProcessGroup();
      if (process !== undefined) await process.exited;
    } catch (error) {
      processCleanupError = error;
    }
    let rootCleanupError: unknown;
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      rootCleanupError = error;
    }
    processGroupAliveAfterCleanup = processGroupAlive();
    rootExistsAfterCleanup = await stat(root).then(
      () => true,
      () => false,
    );
    if (processGroupAliveAfterCleanup) {
      throw new Error("issue ledger validator process group survived cleanup");
    }
    if (rootCleanupError !== undefined || rootExistsAfterCleanup) {
      throw new Error("issue ledger validator root survived cleanup");
    }
    if (processCleanupError !== undefined) {
      throw processCleanupError;
    }
  }
  if (settled === undefined) {
    throw new Error("issue ledger validator harness did not settle");
  }
  return {
    ...settled,
    processGroupAliveAfterCleanup,
    rootExistsAfterCleanup,
  };
}

async function runLedgerMergeHarness(
  launcher: string,
  ledgers: { base: string; source: string; candidate: string },
  options: {
    deadlineMs?: number;
    mergeMode?: "normal" | "failure" | "terminal";
    lockEntries?: Array<{ name: string; contents?: string }>;
    symlinkLockDirectory?: boolean;
  } = {},
): Promise<{
  exitCode: number;
  stderr: string;
  source: string;
  lockExists: boolean;
  lockEntries: string[];
  temporaryFiles: string[];
}> {
  const functions = [
    extractIssueLedgerValidator(launcher),
    extractShellFunction(launcher, "issue_ledger_has_no_latest_open"),
    extractShellFunction(launcher, "issue_ledger_has_terminal_commit"),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "run_before_deadline"),
    extractShellFunction(launcher, "merge_issue_ledger"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) {
    return {
      exitCode: 99,
      stderr: "invalid harness",
      source: ledgers.source,
      lockExists: false,
      lockEntries: [],
      temporaryFiles: [],
    };
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-ledger-prefix-"));
  const sourceLedger = join(root, "issues.jsonl");
  const candidateLedger = join(root, "candidate.jsonl");
  const baseLedger = join(root, "base.jsonl");
  const script = join(root, "merge.sh");
  await Bun.write(sourceLedger, ledgers.source);
  await Bun.write(candidateLedger, ledgers.candidate);
  await Bun.write(baseLedger, ledgers.base);
  if (options.lockEntries !== undefined) {
    const lockDirectory = options.symlinkLockDirectory === true
      ? join(root, "external-lock")
      : `${sourceLedger}.lock`;
    await mkdir(lockDirectory);
    for (const entry of options.lockEntries) {
      await Bun.write(
        join(lockDirectory, entry.name),
        entry.contents ?? "",
      );
    }
    if (options.symlinkLockDirectory === true) {
      await symlink(lockDirectory, `${sourceLedger}.lock`);
    }
  }
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      ...functions,
      `ledger=${JSON.stringify(sourceLedger)}`,
      'ledger_lock="${ledger}.lock"',
      ...launcherDeadlineLines(options.deadlineMs ?? 5000),
      `launcher_deadline_at_ms=$(( $(now_ms) + ${String(options.deadlineMs ?? 5000)} ))`,
      'run_id="terminal-merge-test"',
      'pr_url="https://github.com/ASRagab/orca-ts/pull/1"',
      'monitor_path="monitor.json"',
      'branch="orca/test"',
      'worktree="/tmp/worktree"',
      'elapsed_ms=1',
      'terminal_commit_id="terminal-merge-test"',
      'terminal_commit_at="2026-07-15T00:00:00Z"',
      `terminal_report_sha256=${JSON.stringify("a".repeat(64))}`,
      `terminal_monitor_sha256=${JSON.stringify("b".repeat(64))}`,
      `terminal_candidate_sha256=${JSON.stringify("c".repeat(64))}`,
      `terminal_latest_projection_sha256=${JSON.stringify("d".repeat(64))}`,
      `merge_issue_ledger ${JSON.stringify(candidateLedger)} ${JSON.stringify(baseLedger)} ${options.mergeMode ?? "normal"}`,
    ].join("\n"),
  );

  const process = Bun.spawn(["bash", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    const lockExists = await stat(`${sourceLedger}.lock`).then(
      (value) => value.isDirectory(),
      () => false,
    );
    return {
      exitCode,
      stderr,
      source: await Bun.file(sourceLedger).text(),
      lockExists,
      lockEntries: lockExists
        ? (await readdir(`${sourceLedger}.lock`)).sort()
        : [],
      temporaryFiles: (await readdir(root)).filter(
        (name) =>
          name.startsWith("issues.jsonl.") && name !== "issues.jsonl.lock",
      ),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runFinalizerHarness(
  launcher: string,
  priorStatus: number,
  options: {
    mode?: "live" | "preflight" | "harness";
    seedPreflight?: boolean;
    seedPriorEvidence?: boolean;
    failCopies?: boolean;
    workerExitCode?: number;
    workerCompletedAtMs?: number;
    afterPreflightPublish?: "signal" | "failure";
    signalAfterLatestPublish?: boolean;
    killAfterLatestPublish?: boolean;
    terminalEvidenceMutation?:
      | "report"
      | "monitor"
      | "latest"
      | "latest-ledger-claim"
      | "latest-proof-claim"
      | "latest-projection-claim";
    signalBeforeTerminalLedgerMerge?: boolean;
    signalAtTerminalWorkerSpawnGap?: boolean;
    signalBeforeLatestPublication?: boolean;
    afterTerminalStage?: "TERM" | "INT" | "HUP" | "timeout";
    signalAfterTerminalLedgerRename?: boolean;
    signalAtPreflightRename?: boolean;
    preflightRenameSignal?: "TERM" | "INT" | "HUP";
    occupyPrivateFallbacksAtPreflightRename?: "file" | "directory";
    expireAtPreflightCommit?: boolean;
    expireAtTerminalLedgerCommit?: boolean;
    precreatePredictableTerminalStageSymlink?: boolean;
    interruptCrossParentTerminalLedgerMove?: boolean;
    launcherDeadlineAtMs?: number;
    failLatestRetraction?: boolean;
    afterLatestPackageLockMutation?: "changed" | "disappeared" | "appeared";
    terminalPackageLockRaceClaim?: "changed" | "disappeared" | "appeared";
    completeLiveEvidence?: boolean;
    reportContents?: (validReport: Record<string, unknown>) => string;
    launcherWorkDeadlineAtMs?: number;
    monitorFiles?: readonly {
      name: string;
      contents: string;
    }[];
    failPreflightRetraction?: boolean;
    packageLock?: {
      initial?: string;
      mutation:
        | "unchanged"
        | "modified"
        | "deleted"
        | "created"
        | "recreated-different"
        | "recreated-identical";
    };
    ledger?: {
      base: string;
      source: string;
      candidate: string;
    };
    shellPath?: string;
    timeoutMs?: number;
    rootTracker?: { path: string | undefined };
    hangSignalFallbackMktemp?: boolean;
    hangFinalizationDirname?: boolean;
  } = {},
): Promise<{
  exitCode: number;
  stderr: string;
  latest: Record<string, unknown> | undefined;
  preflight: Record<string, unknown> | undefined;
  preflightExists: boolean;
  claimedPreflightExists: boolean;
  packageLockExists: boolean;
  packageLockBytes: Uint8Array | undefined;
  ledger: string | undefined;
  runLedger: string | undefined;
  terminalStageFiles: string[];
  terminalStageMetadata: {
    basename: string;
    mode: number;
    isRegularFile: boolean;
    isSymbolicLink: boolean;
  }[];
  ledgerIsSymlink: boolean;
  attackerLedger: string | undefined;
  crossParentMoveInterrupted: boolean;
  timedOut: boolean;
  processGroupAliveAfterCleanup: boolean;
  rootExistsAfterCleanup: boolean;
}> {
  const root = await mkdtemp(join(tmpdir(), "orcats-finalizer-"));
  if (options.rootTracker !== undefined) options.rootTracker.path = root;
  const worktree = join(root, "worktree");
  const state = join(root, "state");
  const spawnGapMarker = join(root, "spawn-gap-marker");
  const spawnGapSignalAck = join(root, "spawn-gap-signal-ack");
  const spawnGapRelease = join(root, "spawn-gap-release");
  const terminalLedgerExpiryMarker = join(
    root,
    "terminal-ledger-expiry-marker",
  );
  const attackerLedgerPath = join(root, "attacker-ledger.jsonl");
  const crossParentMoveMarker = join(root, "cross-parent-move-interrupted");
  const launcherWorkDeadlineAtMs =
    options.launcherWorkDeadlineAtMs ??
    options.launcherDeadlineAtMs ??
    600000;
  await mkdir(join(worktree, ".orca", "monitoring"), { recursive: true });
  await mkdir(state, { recursive: true });
  const preflightPath = join(state, "preflight.json");
  const latestPath = join(state, "latest.json");
  const claimedPreflightPath = join(state, "claimed-preflight.json");
  const protectedPackageLock = join(root, "package-lock.json");
  const ledgerPath = join(state, "issues.jsonl");
  const ledgerBaseSnapshot = join(state, "issues.base.jsonl");
  if (options.packageLock?.initial !== undefined) {
    await Bun.write(protectedPackageLock, options.packageLock.initial);
  }
  if (options.seedPreflight === true) {
    await Bun.write(preflightPath, '{"status":"succeeded","exitCode":0}\n');
  }
  if (options.seedPriorEvidence === true) {
    await Bun.write(preflightPath, '{"runId":"prior-preflight","status":"succeeded","exitCode":0}\n');
    await Bun.write(latestPath, '{"runId":"prior-preflight","status":"succeeded","exitCode":0}\n');
  }
  if (options.ledger !== undefined) {
    await mkdir(join(worktree, ".orca", "improvement-loop"), {
      recursive: true,
    });
    await Bun.write(ledgerPath, options.ledger.source);
    await Bun.write(ledgerBaseSnapshot, options.ledger.base);
    await Bun.write(
      join(worktree, ".orca", "improvement-loop", "issues.jsonl"),
      options.ledger.candidate,
    );
  }
  if (options.precreatePredictableTerminalStageSymlink === true) {
    await Bun.write(attackerLedgerPath, "attacker-owned\n");
  }
  if (options.completeLiveEvidence === true) {
    const monitorFiles = options.monitorFiles ?? [
      {
        name: "monitor-run.json",
        contents: terminalMonitorFixture("monitor-run"),
      },
    ];
    for (const monitorFile of monitorFiles) {
      await Bun.write(
        join(worktree, ".orca", "monitoring", monitorFile.name),
        monitorFile.contents,
      );
    }
    await mkdir(
      join(worktree, ".orca", "improvement-loop", "runs", "run"),
      { recursive: true },
    );
    const validReport = terminalReportFixture(
      worktree,
      launcherWorkDeadlineAtMs,
    );
    await Bun.write(
      join(
        worktree,
        ".orca",
        "improvement-loop",
        "runs",
        "run",
        "report.json",
      ),
      options.reportContents?.(validReport) ??
        `${JSON.stringify(validReport)}\n`,
    );
  }
  const script = join(root, "finalizer.sh");
  const stdoutPath = join(root, "stdout.log");
  const stderrPath = join(root, "stderr.log");
  const value = (input: string): string => JSON.stringify(input);
  const runBeforeDeadline = extractShellFunction(
    launcher,
    "run_before_deadline",
  );
  let remainingLauncherMs = extractShellFunction(
    launcher,
    "remaining_launcher_ms",
  );
  if (
    remainingLauncherMs !== undefined &&
    options.signalAtTerminalWorkerSpawnGap === true
  ) {
    const childPidPublication = [
      "    controller_job_pid=$!",
      '    if [[ "$controller_capture_mode" == true ]]; then',
    ].join("\n");
    const signalStatus = [
      '    if [[ "$controller_signal_status" -eq 0 ]]; then',
      '      controller_signal_status="$status"',
      "    fi",
    ].join("\n");
    expect(remainingLauncherMs).toContain(childPidPublication);
    expect(remainingLauncherMs).toContain(signalStatus);
    remainingLauncherMs = remainingLauncherMs.replace(
      signalStatus,
      [
        '    printf %s signal > "$spawn_gap_signal_ack"',
        signalStatus,
      ].join("\n"),
    );
    remainingLauncherMs = remainingLauncherMs.replace(
      childPidPublication,
      [
        "    controller_job_pid=$!",
        '    if [[ "${!#}" == terminal-commit ]]; then',
        '      printf %s ready > "$spawn_gap_marker"',
        '      while [[ ! -f "$spawn_gap_release" ]]; do sleep 0.01; done',
        "    fi",
        '    if [[ "$controller_capture_mode" == true ]]; then',
      ].join("\n"),
    );
  }
  let mergeIssueLedger = extractShellFunction(launcher, "merge_issue_ledger");
  if (
    mergeIssueLedger !== undefined &&
    options.expireAtTerminalLedgerCommit === true
  ) {
    const terminalLedgerBinding = [
      '      echo "terminal issue ledger hash binding changed" >&2',
      "      return 65",
      "    fi",
    ].join("\n");
    expect(mergeIssueLedger).toContain(terminalLedgerBinding);
    mergeIssueLedger = mergeIssueLedger.replace(
      terminalLedgerBinding,
      [
        terminalLedgerBinding,
        '    printf %s expired > "$terminal_ledger_expiry_marker"',
      ].join("\n"),
    );
  }
  const terminalLedgerRecovery = extractShellFunction(
    launcher,
    "validate_terminal_ledger_recovery",
  );
  const functions = [
    extractShellFunction(launcher, "sha256_file"),
    extractShellFunction(launcher, "compute_latest_projection_sha256"),
    extractShellFunction(launcher, "select_terminal_monitor"),
    extractShellFunction(launcher, "validate_terminal_report"),
    extractShellFunction(launcher, "compute_terminal_ledger_proof"),
    extractShellFunction(launcher, "create_terminal_ledger_stage"),
    extractShellFunction(
      launcher,
      "validate_terminal_ledger_publication_paths",
    ),
    extractIssueLedgerValidator(launcher),
    extractShellFunction(launcher, "issue_ledger_has_no_latest_open"),
    extractShellFunction(launcher, "issue_ledger_has_terminal_commit"),
    terminalLedgerRecovery,
    remainingLauncherMs,
    runBeforeDeadline,
    extractShellFunction(launcher, "run_before_deadline_with_reserve"),
    extractShellFunction(launcher, "capture_command_output"),
    extractShellFunction(launcher, "capture_before_deadline"),
    extractShellFunction(launcher, "validate_regular_publication_file"),
    extractShellFunction(launcher, "validate_latest_publication_file"),
    extractShellFunction(launcher, "validate_preflight_publication_file"),
    extractShellFunction(launcher, "validate_failure_tombstone_file"),
    extractShellFunction(launcher, "atomic_rename_action"),
    extractShellFunction(launcher, "validate_atomic_rename_recovery"),
    extractShellFunction(launcher, "atomic_rename_before_deadline"),
    extractShellFunction(launcher, "discard_private_path_before_deadline"),
    extractShellFunction(launcher, "write_failure_tombstone"),
    extractShellFunction(launcher, "render_latest_evidence_action"),
    extractShellFunction(launcher, "quarantine_prior_evidence"),
    extractShellFunction(launcher, "snapshot_package_lock"),
    extractShellFunction(launcher, "compute_preflight_terminal_proof"),
    extractShellFunction(launcher, "assert_package_lock_unchanged"),
    extractShellFunction(launcher, "publish_preflight_attestation"),
    mergeIssueLedger,
  ];
  const extractedFinalizer = extractShellFunction(launcher, "finalize");
  const afterLatestPublish =
    options.signalAfterLatestPublish === true
      ? '      kill -TERM "$supervisor_pid"'
      : options.killAfterLatestPublish === true
        ? '      kill -KILL "$supervisor_pid"'
        : undefined;
  const latestPublication = [
    "    atomic_rename_before_deadline \\",
    '      "$latest_tmp" "$latest" validate_latest_publication_file \\',
    '      "$run_id" "$final_status" || commit_status=$?',
  ].join("\n");
  const preflightPublication = [
    "    atomic_rename_before_deadline \\",
    '      "$preflight_stage" "$preflight_path" \\',
    '      validate_preflight_publication_file "$run_id" || \\',
    "      preflight_commit_status=$?",
  ].join("\n");
  let finalizer =
    extractedFinalizer === undefined || afterLatestPublish === undefined
      ? extractedFinalizer
      : extractedFinalizer.replace(
          latestPublication,
          [
            latestPublication,
            '    if [[ "$commit_status" -eq 0 ]]; then',
            afterLatestPublish,
            "    fi",
          ].join("\n"),
        );
  if (
    finalizer !== undefined &&
    options.signalBeforeLatestPublication === true
  ) {
    expect(finalizer).toContain(latestPublication);
    finalizer = finalizer.replace(
      latestPublication,
      ['    kill -TERM "$supervisor_pid"', latestPublication].join("\n"),
    );
  }
  if (finalizer !== undefined && options.expireAtPreflightCommit === true) {
    expect(finalizer).toContain(preflightPublication);
    finalizer = finalizer.replace(
      preflightPublication,
      `    launcher_deadline_at_ms=99\n${preflightPublication}`,
    );
  }
  if (
    finalizer !== undefined &&
    options.afterLatestPackageLockMutation !== undefined
  ) {
    const mutation =
      options.afterLatestPackageLockMutation === "changed"
        ? '      printf %s terminal-change > "$protected_package_lock"'
        : options.afterLatestPackageLockMutation === "disappeared"
          ? '      rm -f "$protected_package_lock"'
          : '      printf %s terminal-appearance > "$protected_package_lock"';
    finalizer = finalizer.replace(
      '    if ! run_before_deadline mv "$latest_tmp" "$latest"; then',
      [
        '    if run_before_deadline mv "$latest_tmp" "$latest"; then',
        mutation,
        "    else",
      ].join("\n"),
    );
  }
  if (
    finalizer !== undefined &&
    options.terminalPackageLockRaceClaim !== undefined
  ) {
    const terminalCheck = finalizer.lastIndexOf(
      "    if ! assert_package_lock_unchanged; then",
    );
    expect(terminalCheck).toBeGreaterThan(-1);
    const mutation =
      options.terminalPackageLockRaceClaim === "changed"
        ? '    printf %s terminal-change > "$protected_package_lock"'
        : options.terminalPackageLockRaceClaim === "disappeared"
          ? '    command rm -f "$protected_package_lock"'
          : '    printf %s terminal-appearance > "$protected_package_lock"';
    finalizer =
      finalizer.slice(0, terminalCheck) +
      [
        '    if [[ -f "$preflight_path" ]]; then',
        '      mv "$preflight_path" "$claimed_preflight_path" || true',
        "    fi",
        mutation,
        "",
      ].join("\n") +
      finalizer.slice(terminalCheck);
  }
  expect(functions.every((value) => value !== undefined)).toBe(true);
  expect(finalizer).toBeDefined();
  if (functions.some((value) => value === undefined) || finalizer === undefined) {
    return {
      exitCode: 99,
      stderr: "invalid harness",
      latest: undefined,
      preflight: undefined,
      preflightExists: false,
      claimedPreflightExists: false,
      packageLockExists: false,
      packageLockBytes: undefined,
      ledger: undefined,
      runLedger: undefined,
      terminalStageFiles: [],
      terminalStageMetadata: [],
      ledgerIsSymlink: false,
      attackerLedger: undefined,
      crossParentMoveInterrupted: false,
      timedOut: false,
      processGroupAliveAfterCleanup: false,
      rootExistsAfterCleanup: false,
    };
  }

  if (
    finalizer !== undefined &&
    options.terminalEvidenceMutation !== undefined
  ) {
    const latestMutation = (() => {
      switch (options.terminalEvidenceMutation) {
        case "latest":
          return '.branch = "mutated-after-stage"';
        case "latest-ledger-claim":
          return `.ledgerSha256 = "${"0".repeat(64)}"`;
        case "latest-proof-claim":
          return `.terminalProof = "${"0".repeat(64)}"`;
        case "latest-projection-claim":
          return `.latestProjectionSha256 = "${"0".repeat(64)}"`;
        default:
          return undefined;
      }
    })();
    const mutation = options.terminalEvidenceMutation === "report"
      ? '      printf "\\n" >> "$report_path"'
      : options.terminalEvidenceMutation === "monitor"
        ? '      printf "\\n" >> "$monitor_path"'
        : [
            `      jq '${latestMutation}' "$latest" > "\${latest}.mutated"`,
            '      command mv "${latest}.mutated" "$latest"',
          ].join("\n");
    const postLatestCommit = [
      latestPublication,
      '    if [[ "$launcher_signal_status" -ne 0 ]]; then',
      '      handle_finalize_signal "$launcher_signal_status"',
      "    fi",
      '    if [[ "$commit_status" -ne 0 ]]; then',
    ].join("\n");
    expect(finalizer).toContain(postLatestCommit);
    finalizer = finalizer.replace(
      postLatestCommit,
      [
        latestPublication,
        '    if [[ "$launcher_signal_status" -ne 0 ]]; then',
        '      handle_finalize_signal "$launcher_signal_status"',
        "    fi",
        '    if [[ "$commit_status" -eq 0 ]]; then',
        mutation,
        "    fi",
        '    if [[ "$commit_status" -ne 0 ]]; then',
      ].join("\n"),
    );
  }
  if (finalizer !== undefined && options.afterTerminalStage !== undefined) {
    const boundary = [
      '  if [[ "$mode" == live && "$final_status" -eq 0 ]]; then',
      "    if ! prepare_terminal_ledger_evidence; then",
      '      record_finalize_failure "prepare terminal issue ledger"',
      "    fi",
      "  fi",
    ].join("\n");
    expect(finalizer).toContain(boundary);
    finalizer = finalizer.replace(
      boundary,
      [
        boundary,
        options.afterTerminalStage === "timeout"
          ? "  launcher_deadline_at_ms=99"
          : `  kill -${options.afterTerminalStage} "$supervisor_pid"`,
      ].join("\n"),
    );
  }
  if (
    finalizer !== undefined &&
    options.signalBeforeTerminalLedgerMerge === true
  ) {
    const legacyTerminalCommitMerge = [
      '      run_before_deadline merge_issue_ledger \\',
      '        "$candidate_ledger" "$ledger_base_snapshot" terminal-commit || \\',
      "        terminal_ledger_status=$?",
    ].join("\n");
    const reservedTerminalCommitMerge = [
      '      run_before_deadline_with_reserve "$canonical_recovery_reserve_ms" \\',
      '        merge_issue_ledger "$candidate_ledger" "$ledger_base_snapshot" \\',
      "        terminal-commit || terminal_ledger_status=$?",
    ].join("\n");
    const terminalCommitMerge = finalizer.includes(reservedTerminalCommitMerge)
      ? reservedTerminalCommitMerge
      : legacyTerminalCommitMerge;
    expect(finalizer).toContain(terminalCommitMerge);
    finalizer = finalizer.replace(
      terminalCommitMerge,
      [
        '      kill -TERM "$supervisor_pid"',
        terminalCommitMerge,
      ].join("\n"),
    );
  }
  const packageLockMutation = (() => {
    switch (options.packageLock?.mutation) {
      case undefined:
      case "unchanged":
        return ":";
      case "modified":
        return 'printf %s modified-lock > "$protected_package_lock"';
      case "deleted":
        return 'rm -f "$protected_package_lock"';
      case "created":
        return 'printf %s created-lock > "$protected_package_lock"';
      case "recreated-different":
        return 'rm -f "$protected_package_lock"; printf %s recreated-lock > "$protected_package_lock"';
      case "recreated-identical":
        return `rm -f "$protected_package_lock"; printf %s ${JSON.stringify(options.packageLock.initial ?? "")} > "$protected_package_lock"`;
    }
  })();
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      ...(options.expireAtTerminalLedgerCommit === true
        ? [
            "now_ms() {",
            '  if [[ -f "$terminal_ledger_expiry_marker" ]]; then',
            `    echo ${
              launcher.includes(
                'if [[ "$remaining_ms" -lt 0 ]]; then\n      return 124\n    fi\n    if ! mv "$terminal_ledger_stage" "$ledger"; then',
              ) ? 9100 : 9600
            }`,
            "  else",
            "    echo 100",
            "  fi",
            "}",
          ]
        : ["now_ms() { echo 100; }"]),
      "ps() {",
      '  if [[ "${1:-}" == eww ]]; then return 0; fi',
      '  command ps "$@"',
      "}",
      ...(options.hangSignalFallbackMktemp === true
        ? [
            "mktemp() {",
            '  if [[ "${1:-}" == -d ]]; then while :; do :; done; fi',
            '  command mktemp "$@"',
            "}",
          ]
        : []),
      ...(options.hangFinalizationDirname === true
        ? ["dirname() { while :; do :; done; }"]
        : []),
      options.failCopies === false ? ":" : 'cp() { return 23; }',
      ...(options.failPreflightRetraction === true
        ? [
            "rm() {",
            '  target="${!#}"',
            '  if [[ "$target" == "$preflight_path" ]]; then return 77; fi',
            '  command rm "$@"',
            "}",
          ]
        : []),
      ...(options.signalAtPreflightRename === true ||
      options.failLatestRetraction === true ||
      options.signalAfterTerminalLedgerRename === true ||
      options.interruptCrossParentTerminalLedgerMove === true
        ? [
            "mv() {",
            '  source="${@: -2:1}"',
            '  target="${!#}"',
            ...(options.failLatestRetraction === true
              ? [
                  '  if [[ "$source" == "$latest" && "$target" == "$latest_tmp" ]]; then return 78; fi',
                ]
              : []),
            ...(options.interruptCrossParentTerminalLedgerMove === true
              ? [
                  '  if [[ "$source" == "$terminal_ledger_stage" && "$target" == "$ledger" && "${source%/*}" != "${target%/*}" ]]; then',
                  '    dd if="$source" of="$target" bs=1 count=1 2>/dev/null || return $?',
                  '    printf %s interrupted > "$cross_parent_move_marker"',
                  '    kill -TERM "$supervisor_pid"',
                  "    return 143",
                  "  fi",
                ]
              : []),
            '  (command mv "$@") || return $?',
            ...(options.signalAtPreflightRename === true
              ? [
                  '  if [[ "$target" == "$preflight_path" ]]; then',
                  ...(options.occupyPrivateFallbacksAtPreflightRename === "file"
                    ? [
                        '    printf %s occupied > "$preflight_stage"',
                        '    printf %s occupied > "$latest_tmp"',
                      ]
                    : options.occupyPrivateFallbacksAtPreflightRename === "directory"
                      ? [
                          '    mkdir "$preflight_stage"',
                          '    mkdir "$latest_tmp"',
                          '    printf %s occupied > "$preflight_stage/entry"',
                          '    printf %s occupied > "$latest_tmp/entry"',
                        ]
                    : []),
                  `    kill -${options.preflightRenameSignal ?? "TERM"} "$supervisor_pid"`,
                  "  fi",
                ]
              : []),
            ...(options.signalAfterTerminalLedgerRename === true
              ? [
                  '  if [[ "$source" == "$terminal_ledger_stage" && "$target" == "$ledger" ]]; then',
                  '    echo terminal-ledger-rename-signal >&2',
                  '    kill -TERM "$supervisor_pid"',
                  "  fi",
                ]
              : []),
            "  return 0",
            "}",
          ]
        : []),
      ...functions,
      ...(options.afterPreflightPublish === undefined
        ? []
        : [
            "publish_preflight_attestation() {",
            '  printf \'{"status":"succeeded","exitCode":0}\\n\' > "$1"',
            options.afterPreflightPublish === "signal"
              ? '  kill -TERM "$supervisor_pid"; sleep 30'
              : "  return 55",
            "}",
          ]),
      'supervisor_pid="$$"',
      `spawn_gap_marker=${value(spawnGapMarker)}`,
      `spawn_gap_signal_ack=${value(spawnGapSignalAck)}`,
      `spawn_gap_release=${value(spawnGapRelease)}`,
      `terminal_ledger_expiry_marker=${value(terminalLedgerExpiryMarker)}`,
      `cross_parent_move_marker=${value(crossParentMoveMarker)}`,
      `run_id=${value("run")}`,
      `branch=${value("branch")}`,
      `worktree=${value(worktree)}`,
      `run_dir=${value(join(root, "run"))}`,
      `latest=${value(join(state, "latest.json"))}`,
      `latest_quarantine=${value(join(state, "latest.json.superseded"))}`,
      `launcher_log=${value(join(root, "launcher.log"))}`,
      `ledger=${value(ledgerPath)}`,
      `ledger_lock=${value(join(state, "issues.jsonl.lock"))}`,
      `ledger_base_snapshot=${value(
        options.ledger === undefined ? "" : ledgerBaseSnapshot,
      )}`,
      `preflight_path=${value(preflightPath)}`,
      `preflight_quarantine=${value(`${preflightPath}.superseded`)}`,
      `claimed_preflight_path=${value(claimedPreflightPath)}`,
      'started_at_ms="1"',
      "canonical_recovery_reserve_ms=1000",
      ...launcherDeadlineLines(600000),
      `launcher_absolute_deadline_at_ms=${String(options.launcherDeadlineAtMs ?? 600000)}`,
      `launcher_work_deadline_at_ms=${String(launcherWorkDeadlineAtMs)}`,
      'launcher_deadline_at_ms="$launcher_work_deadline_at_ms"',
      'monitor_path=""',
      'report_path=""',
      'pr_url=""',
      "elapsed_ms=0",
      'runtime_path="runtime"',
      'runtime_head="head"',
      'runtime_sha256="sha"',
      'runtime_version="version"',
      'base_sha="base"',
      'artifact_digest="digest"',
      'origin_fetch_url="https://github.com/ASRagab/orca-ts.git"',
      'origin_push_url="git@github.com:ASRagab/orca-ts.git"',
      'repository="ASRagab/orca-ts"',
      'preflight_artifact_digest=""',
      'preflight_base_sha=""',
      `preflight_worker_exit_code=${value(
        options.workerExitCode === undefined
          ? ""
          : String(options.workerExitCode),
      )}`,
      `preflight_worker_completed_at_ms=${value(
        options.workerCompletedAtMs === undefined
          ? ""
          : String(options.workerCompletedAtMs),
      )}`,
      "launcher_finalization_ready=true",
      "launcher_signal_status=0",
      `protected_package_lock=${value(protectedPackageLock)}`,
      "package_lock_existed_before=false",
      'package_lock_sha256_before=""',
      'package_lock_sha256_after=""',
      'complexity="simple"',
      `mode=${value(options.mode ?? "live")}`,
      'phase="live"',
      ...(options.precreatePredictableTerminalStageSymlink === true
        ? [
            'command mkdir -p "$run_dir"',
            `command ln -s ${value(attackerLedgerPath)} "$run_dir/issues.jsonl.terminal.$$"`,
          ]
        : []),
      options.seedPriorEvidence === true
        ? "quarantine_prior_evidence || exit $?"
        : ":",
      "snapshot_package_lock || exit $?",
      packageLockMutation,
      options.seedPreflight === true ? 'rm -f "$preflight_path"' : ":",
      finalizer,
      `(exit ${String(priorStatus)})`,
      "finalize",
    ].join("\n"),
  );
  let harnessProcess: ReturnType<typeof Bun.spawn> | undefined;
  let observedExit: Promise<number> | undefined;
  const processGroupAlive = (): boolean => {
    if (harnessProcess === undefined) return false;
    try {
      globalThis.process.kill(-harnessProcess.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitForProcessGroupExit = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!processGroupAlive()) return true;
      await Bun.sleep(10);
    }
    return !processGroupAlive();
  };
  const stopOwnedProcessGroup = async (): Promise<void> => {
    if (harnessProcess !== undefined && processGroupAlive()) {
      try {
        globalThis.process.kill(-harnessProcess.pid, "SIGTERM");
      } catch {}
      if (!await waitForProcessGroupExit()) {
        try {
          globalThis.process.kill(-harnessProcess.pid, "SIGKILL");
        } catch {}
        await waitForProcessGroupExit();
      }
    }
    if (processGroupAlive()) {
      throw new Error("finalizer harness process group survived cleanup");
    }
  };
  try {
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 40_000
    ) {
      throw new Error("finalizer harness timeout must be 1..40000ms");
    }
    await Promise.all([
      Bun.write(stdoutPath, ""),
      Bun.write(stderrPath, ""),
    ]);
    harnessProcess = Bun.spawn([options.shellPath ?? "bash", script], {
      detached: true,
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    observedExit = harnessProcess.exited;
    if (options.signalAtTerminalWorkerSpawnGap === true) {
      const waitForFile = async (path: string): Promise<void> => {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          if (await Bun.file(path).exists()) return;
          await Bun.sleep(10);
        }
        throw new Error(`timed out waiting for harness file: ${path}`);
      };
      await waitForFile(spawnGapMarker);
      harnessProcess.kill("SIGTERM");
      await waitForFile(spawnGapSignalAck);
      await Bun.write(spawnGapRelease, "release\n");
    }
    const outcome = await Promise.race([
      observedExit.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
    ]);
    const timedOut = outcome.kind === "timeout";
    if (timedOut) await stopOwnedProcessGroup();
    const leaderExitCode = await observedExit;
    if (processGroupAlive()) await stopOwnedProcessGroup();
    if (processGroupAlive()) {
      throw new Error("finalizer harness process group survived cleanup");
    }
    const [, stderr] = await Promise.all([
      Bun.file(stdoutPath).text(),
      Bun.file(stderrPath).text(),
    ]);
    const latest = await Bun.file(latestPath).exists()
      ? await Bun.file(latestPath).json()
      : undefined;
    const preflight = await Bun.file(preflightPath).exists()
      ? await Bun.file(preflightPath).json()
      : undefined;
    const packageLockExists = await Bun.file(protectedPackageLock).exists();
    const terminalStageDirectory = dirname(ledgerPath);
    const terminalStageFiles = (await readdir(terminalStageDirectory))
      .filter((entry) =>
        /^\.issues\.jsonl\.terminal\.[A-Za-z0-9]{6}$/.test(entry),
      )
      .sort();
    const terminalStageMetadata = await Promise.all(
      terminalStageFiles.map(async (basename) => {
        const value = await lstat(join(terminalStageDirectory, basename));
        return {
          basename,
          mode: value.mode & 0o777,
          isRegularFile: value.isFile(),
          isSymbolicLink: value.isSymbolicLink(),
        };
      }),
    );
    return {
      exitCode: timedOut ? 124 : leaderExitCode,
      stderr,
      latest,
      preflight,
      preflightExists: preflight !== undefined,
      claimedPreflightExists: await Bun.file(claimedPreflightPath).exists(),
      packageLockExists,
      packageLockBytes: packageLockExists
        ? new Uint8Array(await Bun.file(protectedPackageLock).arrayBuffer())
        : undefined,
      ledger: await Bun.file(ledgerPath).exists()
        ? await Bun.file(ledgerPath).text()
        : undefined,
      runLedger: await Bun.file(join(root, "run", "issues.jsonl")).exists()
        ? await Bun.file(join(root, "run", "issues.jsonl")).text()
        : undefined,
      terminalStageFiles,
      terminalStageMetadata,
      ledgerIsSymlink: await lstat(ledgerPath).then(
        (value) => value.isSymbolicLink(),
        () => false,
      ),
      attackerLedger: await Bun.file(attackerLedgerPath).exists()
        ? await Bun.file(attackerLedgerPath).text()
        : undefined,
      crossParentMoveInterrupted: await Bun.file(
        crossParentMoveMarker,
      ).exists(),
      timedOut,
      processGroupAliveAfterCleanup: false,
      rootExistsAfterCleanup: false,
    };
  } finally {
    let processCleanupError: unknown;
    try {
      await stopOwnedProcessGroup();
      if (observedExit !== undefined) await observedExit;
    } catch (error) {
      processCleanupError = error;
    }
    let rootCleanupError: unknown;
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      rootCleanupError = error;
    }
    const processGroupAliveAfterCleanup = processGroupAlive();
    const rootExistsAfterCleanup = await stat(root).then(
      () => true,
      () => false,
    );
    if (processGroupAliveAfterCleanup) {
      throw new Error("finalizer harness process group survived cleanup");
    }
    if (rootCleanupError !== undefined || rootExistsAfterCleanup) {
      throw new Error("finalizer harness root survived cleanup");
    }
    if (processCleanupError !== undefined) throw processCleanupError;
  }
}

function terminalMonitorFixture(runId: string): string {
  return `${JSON.stringify({
    runId,
    startedAt: "2026-07-15T00:00:00.000Z",
    backend: "codex",
    stages: [],
    outcomes: [
      {
        reason: "completed",
        file: "terminal monitor fixture",
        verdict: "clean",
        durationMs: 1,
        smellsRemoved: [],
        changedPaths: [],
        validation: [],
        usage: { input: 1, output: 1 },
      },
    ],
    failures: [],
    summary: {
      pass: 1,
      fail: 0,
      skip: 0,
      preconditionSkip: 0,
      durationMs: 1,
    },
    progress: [],
  })}\n`;
}

function terminalReportFixture(
  worktree: string,
  workerDeadlineAtMs: number,
): Record<string, unknown> {
  const headSha = "a".repeat(40);
  const prUrl = "https://github.com/ASRagab/orca-ts/pull/1";
  const remoteChecksCommand = {
    command: `gh pr checks ${prUrl} --json name,workflow,bucket`,
    status: "passed",
    stdout: "[]",
    stderr: "",
    exitCode: 0,
    durationMs: 1,
  };
  const mergeRequestCommand = {
    ...remoteChecksCommand,
    command: `gh pr merge ${prUrl} --squash --match-head-commit ${headSha}`,
  };
  const mergeConfirmationCommand = {
    ...remoteChecksCommand,
    command: `gh pr view ${prUrl} --json url,baseRefName,headRefName,headRefOid,isDraft,state`,
  };
  return {
    runId: "run",
    monitorRunId: "monitor-run",
    profile: "simple",
    startedAtMs: 1,
    workerDeadlineAtMs,
    finishedAtMs: 2,
    elapsedMs: 1,
    backend: "codex",
    stage: "merge",
    baseSha: "base",
    worktree,
    branch: "branch",
    artifactDigest: "digest",
    preflightPath: "preflight.json",
    preflightRunId: "preflight-run",
    preflightArtifactDigest: "digest",
    appliedSystemPrompts: {},
    rejectedCandidates: [],
    validation: [
      remoteChecksCommand,
      mergeRequestCommand,
      mergeConfirmationCommand,
    ],
    prUrl,
    matchedHeadSha: headSha,
    repository: "ASRagab/orca-ts",
    originFetchUrl: "https://github.com/ASRagab/orca-ts.git",
    originPushUrl: "git@github.com:ASRagab/orca-ts.git",
    mergeProof: {
      checkedAt: "2026-07-17T00:00:01.000Z",
      url: prUrl,
      baseRefName: "main",
      headRefName: "branch",
      headRefOid: headSha,
      isDraft: false,
      state: "MERGED",
      command: mergeConfirmationCommand,
    },
    remoteChecks: {
      checkedAt: "2026-07-17T00:00:00.000Z",
      headSha,
      state: "passed",
      command: remoteChecksCommand,
      checks: [{ name: "Verify", workflow: "CI", bucket: "pass" }],
    },
    merged: true,
    sla: "passed",
    stopReason: "completed",
    usage: { input: 1, output: 1 },
  };
}

function terminalReportContents(
  report: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
  omitted: readonly string[] = [],
): string {
  const contents = structuredClone(report);
  Object.assign(contents, overrides);
  for (const key of omitted) delete contents[key];
  return `${JSON.stringify(contents)}\n`;
}

function composedDeadlineOwnershipIssues(
  launcher: string,
  runtime: string,
): string[] {
  const issues: string[] = [];
  const compact = (source: string): string =>
    source.replace(/\s+/g, " ").trim();
  const runLiveWorkflow = extractShellFunction(launcher, "run_live_workflow");
  const workerDeadlineExport =
    '  ORCA_IMPROVEMENT_WORKER_DEADLINE_AT_MS="$launcher_work_deadline_at_ms" \\';
  if (!runLiveWorkflow?.split("\n").includes(workerDeadlineExport)) {
    issues.push("launcher must export its work cutoff to the runtime");
  }

  const validateTerminalReport = compact(
    extractShellFunction(launcher, "validate_terminal_report") ?? "",
  );
  const finalizer = compact(extractShellFunction(launcher, "finalize") ?? "");
  if (
    !validateTerminalReport.includes('local worker_deadline_at_ms="$3"') ||
    !validateTerminalReport.includes(
      '--argjson workerDeadlineAtMs "$worker_deadline_at_ms"',
    ) ||
    !validateTerminalReport.includes(
      ".workerDeadlineAtMs == $workerDeadlineAtMs",
    ) ||
    !validateTerminalReport.includes(
      ".finishedAtMs <= $workerDeadlineAtMs",
    ) ||
    !finalizer.includes(
      '"$report_path" "$monitor_path" "$launcher_work_deadline_at_ms";',
    )
  ) {
    issues.push("launcher must validate the exact worker deadline before commit");
  }

  const compactRuntime = compact(runtime);
  if (
    !compactRuntime.includes(
      "const RUNTIME_FINALIZATION_RESERVE_MS = 60_000;",
    )
  ) {
    issues.push("runtime finalization reserve must remain exactly 60000 ms");
  }
  const workerDeadlineDeclaration = compactRuntime.indexOf(
    'const workerDeadlineAtMs = parseWorkerDeadlineAtMs( requiredEnvironment("ORCA_IMPROVEMENT_WORKER_DEADLINE_AT_MS"), startedAtMs, limits.deadlineMs, );',
  );
  const monitorDeclaration = compactRuntime.indexOf(
    "const monitor = new WorkflowMonitor(",
  );
  if (
    workerDeadlineDeclaration < 0 ||
    monitorDeclaration <= workerDeadlineDeclaration ||
    compactRuntime.includes(
      "let workerDeadlineAtMs = startedAtMs + limits.deadlineMs;",
    )
  ) {
    issues.push("runtime must bind the worker deadline before fallible setup");
  }
  if (
    !compactRuntime.includes(
      "const runtimeDeadlineMs = (): number => workerDeadlineAtMs - startedAtMs;",
    ) ||
    !compactRuntime.includes(
      "const workDeadlineMs = (): number => runtimeDeadlineMs() - RUNTIME_FINALIZATION_RESERVE_MS;",
    ) ||
    !compactRuntime.includes(
      "stageBudgetMs( startedAtMs, workDeadlineMs(), Date.now(), workDeadlineMs(), )",
    ) ||
    !compactRuntime.includes("Date.now() >= startedAtMs + workDeadlineMs()")
  ) {
    issues.push("runtime active work must stop before its finalization reserve");
  }
  if (
    !compactRuntime.includes(
      "remainingMs: () => stageBudgetMs( startedAtMs, runtimeDeadlineMs(), Date.now(), runtimeDeadlineMs(), ),",
    ) ||
    !compactRuntime.includes("report.elapsedMs <= runtimeDeadlineMs()")
  ) {
    issues.push("runtime finalization and SLA must use the worker cutoff");
  }

  const reportStart = compactRuntime.indexOf("const report: RunReport = {");
  const reportEnd = compactRuntime.indexOf("};", reportStart);
  const reportInitializer = compactRuntime.slice(reportStart, reportEnd);
  const parserStart = compactRuntime.indexOf(
    "function parseWorkerDeadlineAtMs(",
  );
  const parserEnd = compactRuntime.indexOf(
    "function requiredEnvironment(",
    parserStart,
  );
  const workerDeadlineParser = compactRuntime.slice(parserStart, parserEnd);
  if (
    !compactRuntime.includes("workerDeadlineAtMs: number;") ||
    !reportInitializer.includes("workerDeadlineAtMs,") ||
    !workerDeadlineParser.includes("!Number.isSafeInteger(parsed)") ||
    !workerDeadlineParser.includes("parsed <= startedAtMs") ||
    !workerDeadlineParser.includes("parsed > startedAtMs + deadlineMs") ||
    !workerDeadlineParser.includes("return parsed;")
  ) {
    issues.push("runtime report must parse and bind the exact worker deadline");
  }
  return issues;
}

async function runPriorEvidenceInvalidationHarness(
  launcher: string,
  outcome: "rename-failure" | "signal",
): Promise<{
  exitCode: number;
  preflightExists: boolean;
  latestExists: boolean;
  stderr: string;
}> {
  const invalidator = extractShellFunction(
    launcher,
    "quarantine_prior_evidence",
  );
  const functions = [
    extractShellFunction(launcher, "sha256_file"),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "run_before_deadline"),
    extractShellFunction(launcher, "run_before_deadline_with_reserve"),
    extractShellFunction(launcher, "capture_command_output"),
    extractShellFunction(launcher, "capture_before_deadline"),
    extractShellFunction(launcher, "validate_regular_publication_file"),
    extractShellFunction(launcher, "atomic_rename_action"),
    extractShellFunction(launcher, "validate_atomic_rename_recovery"),
    extractShellFunction(launcher, "atomic_rename_before_deadline"),
    invalidator,
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) {
    return {
      exitCode: 99,
      preflightExists: true,
      latestExists: true,
      stderr: "missing extracted function",
    };
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-prior-evidence-"));
  const preflightPath = join(root, "preflight.json");
  const latestPath = join(root, "latest.json");
  const signalMarker = join(root, "signal-sent");
  const script = join(root, "invalidate.sh");
  await Bun.write(preflightPath, '{"status":"succeeded","exitCode":0}\n');
  await Bun.write(latestPath, '{"status":"succeeded","exitCode":0}\n');
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      "ps() {",
      '  if [[ "${1:-}" == eww ]]; then return 0; fi',
      '  command ps "$@"',
      "}",
      `preflight_path=${JSON.stringify(preflightPath)}`,
      `preflight_quarantine=${JSON.stringify(`${preflightPath}.quarantine`)}`,
      `latest=${JSON.stringify(latestPath)}`,
      `latest_quarantine=${JSON.stringify(`${latestPath}.quarantine`)}`,
      'mode="preflight"',
      'supervisor_pid="$$"',
      "canonical_recovery_reserve_ms=1000",
      "launcher_signal_status=0",
      "terminal_commit_signal_status=0",
      "launcher_deadline_ms=8000",
      'started_at_ms="$(now_ms)"',
      'launcher_deadline_at_ms=$(( started_at_ms + launcher_deadline_ms ))',
      'controller_started_seconds="$SECONDS"',
      "mv() {",
      '  source="${@: -2:1}"',
      '  target="${!#}"',
      ...(outcome === "rename-failure"
        ? [
            '  if [[ "$source" == "$preflight_path" && "$target" == "$preflight_quarantine" ]]; then',
            "    return 77",
            "  fi",
          ]
        : []),
      '  command mv "$@" || return $?',
      ...(outcome === "signal"
        ? [
            `  if [[ "$source" == "$preflight_path" && ! -e ${JSON.stringify(signalMarker)} ]]; then`,
            `    : > ${JSON.stringify(signalMarker)}`,
            '    kill -TERM "$supervisor_pid"',
            "  fi",
          ]
        : []),
      "}",
      ...functions as string[],
      "handle_signal() {",
      "  quarantine_prior_evidence || true",
      "  exit 143",
      "}",
      "trap 'handle_signal' TERM",
      "quarantine_prior_evidence",
      'status="$?"',
      'if [[ "$launcher_signal_status" -ne 0 ]]; then handle_signal; fi',
      'exit "$status"',
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    return {
      exitCode,
      preflightExists: await Bun.file(preflightPath).exists(),
      latestExists: await Bun.file(latestPath).exists(),
      stderr,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("finalizer harness tests declare explicit bounded timeouts", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const inspection = inspectFinalizerHarnessTimeouts(source);
  expect(inspection.testCount).toBe(42);
  expect(inspection.callCount).toBe(78);
  expect(inspection.expandedRunCount).toBe(95);
  expect(inspection.longTimeoutTestCount).toBe(1);
  expect(inspection.longTimeoutScenarioCount).toBe(6);
  expect(inspection.extendedInnerTimeoutTestCount).toBe(1);
  expect(inspection.extendedInnerTimeoutScenarioCount).toBe(27);
  expect(inspection.issues).toEqual([]);

  const aliasNeedle =
    "  const failed = await runFinalizerHarness(launcher, 42, {";
  const aliasIndex = source.lastIndexOf(aliasNeedle);
  expect(aliasIndex).toBeGreaterThan(-1);
  const aliasReplacement = [
    "  const invokeFinalizer = runFinalizerHarness;",
    "  const failed = await invokeFinalizer(launcher, 42, {",
  ].join("\n");
  const aliasMutation =
    source.slice(0, aliasIndex) +
    aliasReplacement +
    source.slice(aliasIndex + aliasNeedle.length);
  expect(aliasMutation).not.toBe(source);
  expect(inspectFinalizerHarnessTimeouts(aliasMutation).issues).toContain(
    "runFinalizerHarness must not be aliased or referenced indirectly",
  );

  const ordinaryTitle =
    "successful terminal publication rejects ambiguous monitor evidence";
  const exceptionTitle =
    "terminal commit rejects bound evidence mutation after private staging";
  const ordinaryStart = source.indexOf(`test("${ordinaryTitle}"`);
  const ordinaryEnd = source.indexOf("\ntest(", ordinaryStart + 1);
  expect(ordinaryStart).toBeGreaterThan(-1);
  expect(ordinaryEnd).toBeGreaterThan(ordinaryStart);
  const ordinaryBlock = source.slice(ordinaryStart, ordinaryEnd);
  const duplicateBlock = ordinaryBlock
    .replace(ordinaryTitle, exceptionTitle)
    .replace(/\}, 15_000\);\s*$/, "}, 45_000);");
  expect(duplicateBlock).not.toBe(ordinaryBlock);
  const duplicateExceptionMutation =
    source.slice(0, ordinaryStart) +
    duplicateBlock +
    source.slice(ordinaryEnd);
  expect(
    inspectFinalizerHarnessTimeouts(duplicateExceptionMutation).issues,
  ).toContain("exactly one six-mutation family may use its 45-second timeout");

  const exceptionStart = source.indexOf(`test("${exceptionTitle}"`);
  const exceptionEnd = source.indexOf("\ntest(", exceptionStart + 1);
  expect(exceptionStart).toBeGreaterThan(-1);
  expect(exceptionEnd).toBeGreaterThan(exceptionStart);
  const exceptionBlock = source.slice(exceptionStart, exceptionEnd);
  const reducedExceptionBlock = exceptionBlock.replace(
    '    "latest-projection-claim",\n',
    "",
  );
  expect(reducedExceptionBlock).not.toBe(exceptionBlock);
  const reducedScenarioMutation =
    source.slice(0, exceptionStart) +
    reducedExceptionBlock +
    source.slice(exceptionEnd);
  expect(inspectFinalizerHarnessTimeouts(reducedScenarioMutation).issues).toContain(
    "45-second finalizer harness test must cover exactly six scenarios",
  );

  const skippedExceptionBlock = exceptionBlock.replace(
    '  ] as const) {\n    const result = await runFinalizerHarness',
    [
      '  ] as const) {',
      '    if (mutation === "latest-projection-claim") continue;',
      "    const result = await runFinalizerHarness",
    ].join("\n"),
  );
  expect(skippedExceptionBlock).not.toBe(exceptionBlock);
  const skippedScenarioMutation =
    source.slice(0, exceptionStart) +
    skippedExceptionBlock +
    source.slice(exceptionEnd);
  expect(inspectFinalizerHarnessTimeouts(skippedScenarioMutation).issues).toContain(
    "45-second finalizer harness test must invoke every scenario unconditionally",
  );

  for (const replacement of ['    "monitor",\n', "    ...[],\n"]) {
    const weakenedExceptionBlock = exceptionBlock.replace(
      '    "report",\n',
      replacement,
    );
    expect(weakenedExceptionBlock, replacement).not.toBe(exceptionBlock);
    const weakenedScenarioMutation =
      source.slice(0, exceptionStart) +
      weakenedExceptionBlock +
      source.slice(exceptionEnd);
    expect(
      inspectFinalizerHarnessTimeouts(weakenedScenarioMutation).issues,
      replacement,
    ).toContain(
      "45-second finalizer harness test must enumerate the exact six mutation scenarios",
    );
  }
});

test("finalizer harness inner timeouts preserve outer cleanup reserve", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const defaultInnerTimeoutMs = Number(
    source
      .match(/const timeoutMs = options\.timeoutMs \?\? ([\d_]+);/)?.[1]
      ?.replaceAll("_", ""),
  );
  expect(defaultInnerTimeoutMs).toBe(10_000);

  const title =
    "successful terminal publication rejects an unbound workflow report";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const outerTimeoutMs = Number(
    block
      .match(/\}, ([\d_]+)\);\s*$/)?.[1]
      ?.replaceAll("_", ""),
  );
  const innerTimeoutsMs = [...block.matchAll(/timeoutMs: ([\d_]+),/g)]
    .map((match) => Number(match[1]!.replaceAll("_", "")));
  expect(outerTimeoutMs).toBe(45_000);
  expect(innerTimeoutsMs).toHaveLength(27);
  for (const innerTimeoutMs of innerTimeoutsMs) {
    expect(innerTimeoutMs).toBe(30_000);
    expect(innerTimeoutMs + 3_000).toBeLessThanOrEqual(outerTimeoutMs);
  }

  const insufficientOuterBlock = block.replace(
    /\}, 45_000\);\s*$/,
    "}, 30_000);",
  );
  expect(insufficientOuterBlock).not.toBe(block);
  const insufficientOuterMutation =
    source.slice(0, start) + insufficientOuterBlock + source.slice(end);
  expect(
    inspectFinalizerHarnessTimeouts(insufficientOuterMutation).issues,
  ).toContain(
    `${title}: inner timeout must leave at least 3000ms cleanup reserve before outer timeout`,
  );

  const missingExplicitBlock = block.replace(
    "      timeoutMs: 30_000,\n",
    "",
  );
  expect(missingExplicitBlock).not.toBe(block);
  const missingExplicitMutation =
    source.slice(0, start) + missingExplicitBlock + source.slice(end);
  expect(
    inspectFinalizerHarnessTimeouts(missingExplicitMutation).issues,
  ).toContain(
    `${title}: every harness call requires explicit 30000ms inner timeout`,
  );
});

test("finalizer harness timeout policy rejects an unbound loop scenario", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const needle = "      terminalEvidenceMutation: mutation,\n";
  const index = source.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  const mutation =
    source.slice(0, index) +
    '      terminalEvidenceMutation: "report",\n' +
    source.slice(index + needle.length);
  expect(mutation).not.toBe(source);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    "terminal commit rejects bound evidence mutation after private staging: finalizer harness loop must bind its scenario to the harness call",
  );
});

test("finalizer harness timeout policy rejects a non-selecting loop binding", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const needle = "      terminalEvidenceMutation: mutation,\n";
  const index = source.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  const mutation =
    source.slice(0, index) +
    '      terminalEvidenceMutation: (mutation, "report"),\n' +
    source.slice(index + needle.length);
  expect(mutation).not.toBe(source);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    "45-second finalizer harness test must bind each mutation directly to terminalEvidenceMutation",
  );
});

test("finalizer harness timeout policy rejects a skipped ordinary scenario", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "preflight supervisor discards private staging after signal or failure";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const needle =
    '  ] as const) {\n    const result = await runFinalizerHarness';
  const weakenedBlock = block.replace(
    needle,
    [
      "  ] as const) {",
      '    if (outcome === "signal") continue;',
      "    const result = await runFinalizerHarness",
    ].join("\n"),
  );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must invoke every scenario unconditionally`,
  );
});

test("finalizer harness timeout policy rejects a pre-loop early return", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "preflight supervisor discards private staging after signal or failure";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const loopStart = "  for (const { outcome, status } of [";
  const weakenedBlock = block.replace(
    loopStart,
    `  if (Date.now() > 0) return;\n${loopStart}`,
  );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must invoke every scenario unconditionally`,
  );
});

test("finalizer harness timeout policy rejects a post-call early return", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "preflight supervisor discards private staging after signal or failure";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const needle =
    "    });\n    expect(result.exitCode, outcome).toBe(status);";
  const weakenedBlock = block.replace(
    needle,
    "    });\n    return;\n    expect(result.exitCode, outcome).toBe(status);",
  );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must invoke every scenario unconditionally`,
  );
});

test("finalizer harness timeout policy rejects post-call callback weakening", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "preflight supervisor discards private staging after signal or failure";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const tail = [
    "    });",
    "    expect(result.exitCode, outcome).toBe(status);",
    "    expect(result.preflightExists).toBe(false);",
    "    expect(result.preflight, outcome).toBeUndefined();",
  ].join("\n");
  const mutationIssues = ([
    [
      "continue",
      [
        "    });",
        '    if (outcome === "signal") continue;',
        "    expect(result.exitCode, outcome).toBe(status);",
        "    expect(result.preflightExists).toBe(false);",
        "    expect(result.preflight, outcome).toBeUndefined();",
      ].join("\n"),
    ],
    [
      "swallowing catch",
      [
        "    });",
        "    try {",
        "      expect(result.exitCode, outcome).toBe(status);",
        "      expect(result.preflightExists).toBe(false);",
        "      expect(result.preflight, outcome).toBeUndefined();",
        "    } catch {}",
      ].join("\n"),
    ],
  ] as const).map(([label, weakenedTail]) => {
    const weakenedBlock = block.replace(tail, weakenedTail);
    expect(weakenedBlock, label).not.toBe(block);
    const mutation =
      source.slice(0, start) + weakenedBlock + source.slice(end);
    return [label, inspectFinalizerHarnessTimeouts(mutation).issues] as const;
  });
  expect(mutationIssues).toEqual([
    [
      "continue",
      [`${title}: finalizer harness callback must preserve exact source`],
    ],
    [
      "swallowing catch",
      [`${title}: finalizer harness callback must preserve exact source`],
    ],
  ]);
});

test("finalizer harness timeout policy rejects a trailing scenario override", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const needle = "      terminalEvidenceMutation: mutation,\n";
  const index = source.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  const mutation =
    source.slice(0, index) +
    needle +
    '      ...{ terminalEvidenceMutation: "report" },\n' +
    source.slice(index + needle.length);
  expect(mutation).not.toBe(source);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    "45-second finalizer harness test must not spread or override harness options",
  );
});

test("finalizer harness timeout policy rejects a mutable named scenario source", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "preflight supervisor discards private staging after signal or failure";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const inlineLoop = [
    "  for (const { outcome, status } of [",
    '    { outcome: "signal", status: 143 },',
    '    { outcome: "failure", status: 74 },',
    "  ] as const) {",
  ].join("\n");
  const namedLoop = [
    "  const scenarios = [",
    '    { outcome: "signal", status: 143 },',
    '    { outcome: "failure", status: 74 },',
    "  ] as const;",
    "  scenarios.length = 0;",
    "  for (const { outcome, status } of scenarios) {",
  ].join("\n");
  const weakenedBlock = block.replace(inlineLoop, namedLoop);
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must use an inline literal scenario array`,
  );
});

test("finalizer harness timeout policy rejects a non-selecting ordinary binding", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "successful terminal publication validates monitor identity and outcome";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const weakenedBlock = block
    .replace(
      "runFinalizerHarness(launcher, 0, {",
      "runFinalizerHarness(launcher, monitor.name.length - monitor.name.length, {",
    )
    .replace(
      "      monitorFiles: [monitor],",
      [
        "      monitorFiles: [",
        "        {",
        '          name: "mismatched-run.json",',
        '          contents: terminalMonitorFixture("different-run"),',
        "        },",
        "      ],",
      ].join("\n"),
    );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must bind its scenario to the harness call`,
  );
});

test("finalizer harness timeout policy rejects pre-call scenario reassignment", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "terminal commit rejects bound evidence mutation after private staging";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const weakenedBlock = block
    .replace("for (const mutation of [", "for (let mutation of [")
    .replace(
      "runFinalizerHarness(launcher, 0, {",
      'runFinalizerHarness((mutation = "report", launcher), 0, {',
    );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop binding must be const`,
  );
});

test("finalizer harness timeout policy rejects a computed option override", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "terminal commit rejects bound evidence mutation after private staging";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const needle = "      terminalEvidenceMutation: mutation,\n";
  const weakenedBlock = block.replace(
    needle,
    needle + '      ["terminalEvidence" + "Mutation"]: "report",\n',
  );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must bind its scenario to the harness call`,
  );
});

test("finalizer harness timeout policy rejects an irrelevant option binding", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "successful terminal publication validates monitor identity and outcome";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const weakenedBlock = block
    .replace(
      "      completeLiveEvidence: true,",
      [
        "      completeLiveEvidence: true,",
        "      workerCompletedAtMs: monitor.name.length,",
      ].join("\n"),
    )
    .replace(
      "      monitorFiles: [monitor],",
      [
        "      monitorFiles: [",
        "        {",
        '          name: "mismatched-run.json",',
        '          contents: terminalMonitorFixture("different-run"),',
        "        },",
        "      ],",
      ].join("\n"),
    );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must bind its scenario to the harness call`,
  );
});

test("finalizer harness timeout policy rejects spread scenario elements", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "preflight supervisor discards private staging after signal or failure";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const weakenedBlock = block.replace(
    '    { outcome: "signal", status: 143 },',
    "    ...[],",
  );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must enumerate literal scenarios without spreads`,
  );
});

test("finalizer harness timeout policy rejects duplicate scenario literals", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "preflight supervisor discards private staging after signal or failure";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const weakenedBlock = block.replace(
    '    { outcome: "signal", status: 143 },',
    '    { outcome: "failure", status: 74 },',
  );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must preserve exact scenario literals`,
  );
});

test("finalizer harness timeout policy rejects a swallowing try wrapper", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "preflight supervisor discards private staging after signal or failure";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const loopStart = "  for (const { outcome, status } of [";
  const loopEnd = "  }\n}, 15_000);";
  const weakenedBlock = block
    .replace(loopStart, `  try {\n${loopStart}`)
    .replace(loopEnd, "  }\n  } catch {}\n}, 15_000);")
    .replace(
      "runFinalizerHarness(launcher, 0, {",
      'runFinalizerHarness(launcher, (() => { throw new Error("skip"); })(), {',
    );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must invoke every scenario unconditionally`,
  );
});

test("finalizer harness timeout policy rejects effectful option evaluation", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "successful terminal publication validates monitor identity and outcome";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const weakenedBlock = block.replace(
    "      completeLiveEvidence: true,",
    [
      "      completeLiveEvidence: (",
      "        eval(",
      "          'monitor.name = \"mismatched-run.json\"; monitor.contents = terminalMonitorFixture(\"different-run\")',",
      "        ),",
      "        true",
      "      ),",
    ].join("\n"),
  );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    `${title}: finalizer harness loop must bind its scenario to the harness call`,
  );
});

test("finalizer harness timeout policy rejects an effectful pre-loop option alias", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "successful terminal publication validates monitor identity and outcome";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const loopStart = "  for (const monitor of [";
  const weakenedBlock = block
    .replace(
      loopStart,
      [
        "  const completeLiveEvidence = (() => {",
        '    throw new Error("skip");',
        "  })();",
        loopStart,
      ].join("\n"),
    )
    .replace(
      "      completeLiveEvidence: true,",
      "      completeLiveEvidence: completeLiveEvidence,",
    );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toEqual([
    `${title}: finalizer harness callback must preserve exact source`,
  ]);
});

test("finalizer harness timeout policy rejects a nested fake harness", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "preflight supervisor discards private staging after signal or failure";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const needle = '  ).text();\n';
  const weakenedBlock = block.replace(
    needle,
    [
      needle.trimEnd(),
      "  async function runFinalizerHarness(",
      "    _launcher: string,",
      "    _status: number,",
      '    options: { afterPreflightPublish?: "signal" | "failure" },',
      "  ) {",
      "    const exitCode =",
      '      options.afterPreflightPublish === "signal" ? 143 : 74;',
      "    return { exitCode, preflightExists: false, latest: { exitCode } };",
      "  }",
    ].join("\n"),
  );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    "runFinalizerHarness must have exactly one top-level function declaration",
  );
});

test("finalizer harness timeout policy rejects monitor fixture reassignment", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const title =
    "successful terminal publication validates monitor identity and outcome";
  const start = source.indexOf(`test("${title}"`);
  const end = source.indexOf("\ntest(", start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = source.slice(start, end);
  const loopStart = "  for (const monitor of [";
  const loopEnd = "  }\n}, 15_000);";
  const weakenedBlock = block
    .replace(
      loopStart,
      [
        "  const originalTerminalMonitorFixture = terminalMonitorFixture;",
        "  terminalMonitorFixture = () =>",
        '    originalTerminalMonitorFixture("different-run");',
        "  try {",
        loopStart,
      ].join("\n"),
    )
    .replace(
      loopEnd,
      [
        "  }",
        "  } finally {",
        "    terminalMonitorFixture = originalTerminalMonitorFixture;",
        "  }",
        "}, 15_000);",
      ].join("\n"),
    );
  expect(weakenedBlock).not.toBe(block);
  const mutation =
    source.slice(0, start) + weakenedBlock + source.slice(end);
  expect(inspectFinalizerHarnessTimeouts(mutation).issues).toContain(
    "terminalMonitorFixture must have exactly one top-level declaration and direct calls only",
  );
});

test("default config proves skill and prompt directives", async () => {
  const config = WorkflowConfigSchema.parse(
    await Bun.file(".orca/workflows/codebase-improvement.config.json").json(),
  );
  expect(config.stages.reproduce.skill).toBe("tdd");
  expect(config.stages.implement.skill).toBe("tdd");
  expect(config.stages.review.prompt).toContain("concrete correctness");
});

test("launcher exposes isolated strict-baseline modes", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.sh").text();
  for (const required of [
    "--preflight-only",
    "--complexity=simple",
    "worktree add",
    "origin/main",
    "--baseline=strict",
  ]) {
    expect(source).toContain(required);
  }
  for (const forbidden of ["worktree remove", "branch -D", "reset --hard", "clean -fd"]) {
    expect(source).not.toContain(forbidden);
  }
});

test("finalizer harness terminal stage scan propagates inspection failure", async () => {
  const inspect = (candidate: string): string[] => {
    const sourceFile = ts.createSourceFile(
      "codebase-improvement-artifacts.test.ts",
      candidate,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declarations: ts.VariableDeclaration[] = [];
    const collect = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "terminalStageFiles"
      ) {
        declarations.push(node);
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
    if (declarations.length !== 1) {
      return ["terminal stage scan must have one exact result binding"];
    }

    const initializer = declarations[0]?.initializer;
    if (initializer === undefined) {
      return ["terminal stage scan must propagate readdir rejection"];
    }
    let readdirCallCount = 0;
    let directlyAwaited = false;
    let recoversRejection = false;
    const inspectInitializer = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "readdir"
      ) {
        readdirCallCount += 1;
        directlyAwaited =
          ts.isAwaitExpression(node.parent) && node.parent.expression === node;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "catch" ||
          (node.expression.name.text === "then" && node.arguments.length > 1))
      ) {
        recoversRejection = true;
      }
      ts.forEachChild(node, inspectInitializer);
    };
    inspectInitializer(initializer);
    return readdirCallCount === 1 && directlyAwaited && !recoversRejection
      ? []
      : ["terminal stage scan must propagate readdir rejection"];
  };

  const source = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  expect(inspect(source)).toEqual([]);

  const directScan = "(await readdir(terminalStageDirectory))";
  const failOpenMutation = source.replace(
    directScan,
    "(await readdir(terminalStageDirectory).catch(() => []))",
  );
  expect(failOpenMutation).not.toBe(source);
  expect(inspect(failOpenMutation)).toEqual([
    "terminal stage scan must propagate readdir rejection",
  ]);
});

test("issue ledger validator harness removes its exact root when spawn fails", async () => {
  const prefix = "orcats-ledger-validator-";
  const validatorRoots = async (): Promise<string[]> =>
    (await readdir(tmpdir()))
      .filter((name) => name.startsWith(prefix))
      .sort();
  const before = await validatorRoots();
  const beforeSet = new Set(before);

  try {
    await expect(
      runIssueLedgerValidatorHarness(
        "validate_issue_ledger() { :; }",
        ".orca/improvement-loop/issues.jsonl",
        { shellPath: "/etc/hosts", timeoutMs: 100 },
      ),
    ).rejects.toThrow();
    expect(await validatorRoots()).toEqual(before);
  } finally {
    const leaked = (await validatorRoots()).filter(
      (name) => !beforeSet.has(name),
    );
    await Promise.all(
      leaked.map((name) =>
        rm(join(tmpdir(), name), { recursive: true, force: true }),
      ),
    );
  }
}, 10_000);

test("issue ledger validator harness stops a slow descendant on timeout", async () => {
  const validator = [
    "validate_issue_ledger() {",
    "  sleep 3 &",
    "  sleep 1",
    "}",
  ].join("\n");
  const startedAt = Date.now();
  const result = await runIssueLedgerValidatorHarness(
    validator,
    ".orca/improvement-loop/issues.jsonl",
    { shellPath: "/bin/bash", timeoutMs: 100 },
  );
  const elapsedMs = Date.now() - startedAt;

  expect(result.exitCode).toBe(124);
  expect(result.timedOut).toBe(true);
  expect(elapsedMs).toBeLessThan(2_000);
  expect(result.processGroupAliveAfterCleanup).toBe(false);
  expect(result.rootExistsAfterCleanup).toBe(false);
}, 10_000);

test("finalizer harness removes its exact root when spawn fails", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const rootTracker: { path: string | undefined } = { path: undefined };

  try {
    await expect(
      runFinalizerHarness(launcher, 42, {
        failCopies: false,
        shellPath: "/etc/hosts",
        timeoutMs: 100,
        rootTracker,
      }),
    ).rejects.toThrow();
    expect(rootTracker.path).toBeDefined();
    if (rootTracker.path !== undefined) {
      expect(await stat(rootTracker.path).then(
        () => true,
        () => false,
      )).toBe(false);
    }
  } finally {
    if (rootTracker.path !== undefined) {
      await rm(rootTracker.path, { recursive: true, force: true });
    }
  }
}, 15_000);

test("finalizer harness stops its owned process group on timeout", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const rootTracker: { path: string | undefined } = { path: undefined };
  const startedAt = Date.now();

  try {
    const result = await runFinalizerHarness(launcher, 42, {
      failCopies: false,
      shellPath: "/bin/bash",
      timeoutMs: 1,
      rootTracker,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result).toMatchObject({
      exitCode: 124,
      timedOut: true,
      processGroupAliveAfterCleanup: false,
      rootExistsAfterCleanup: false,
    });
    expect(elapsedMs).toBeLessThan(2_000);
    expect(rootTracker.path).toBeDefined();
    if (rootTracker.path !== undefined) {
      expect(await stat(rootTracker.path).then(
        () => true,
        () => false,
      )).toBe(false);
    }
  } finally {
    if (rootTracker.path !== undefined) {
      await rm(rootTracker.path, { recursive: true, force: true });
    }
  }
}, 15_000);

test("launcher rejects an invalid source ledger without rewriting it", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const validator = extractIssueLedgerValidator(launcher);
  expect(validator).toBeDefined();
  if (validator === undefined) return;
  const harnessOptions = { shellPath: "/bin/bash" } as const;

  const sourceLedger = await Bun.file(
    ".orca/improvement-loop/issues.jsonl",
  ).text();
  const sourceLines = sourceLedger.trimEnd().split("\n");
  expect(sourceLines.length).toBeGreaterThan(1);
  const alteredFirstSeed = [
    sourceLines[0]!.replace(
      '"id":"feature-implementation-timeout"',
      '"id":"altered-feature-implementation-timeout"',
    ),
    ...sourceLines.slice(1),
  ].join("\n") + "\n";
  expect(alteredFirstSeed).not.toBe(sourceLedger);
  const appendedRecord = JSON.stringify({
    id: "validator-harness-append",
    runId: "validator-harness",
    at: "2026-07-14T00:00:00.000Z",
    classification: "gate",
    stage: "launcher-preflight",
    elapsedMs: 0,
    evidence: "valid append-only ledger fixture",
    status: "open",
  });

  const root = await mkdtemp(join(tmpdir(), "orcats-ledger-cases-"));
  try {
    const missing = join(root, "missing.jsonl");
    expect(
      (await runIssueLedgerValidatorHarness(
        validator,
        missing,
        harnessOptions,
      )).exitCode,
    ).toBe(65);
    expect(await Bun.file(missing).exists()).toBe(false);

    const invalidCases = [
      { name: "whitespace-only", bytes: " \t\n" },
      {
        name: "empty-object-record",
        bytes: `${sourceLines[0]}\n{}\n`,
      },
      {
        name: "invalid-status-record",
        bytes: `${sourceLines[0]}\n${JSON.stringify({
          ...JSON.parse(appendedRecord),
          status: "done",
        })}\n`,
      },
      {
        name: "blank-id-record",
        bytes: `${sourceLines[0]}\n${JSON.stringify({
          ...JSON.parse(appendedRecord),
          id: "",
        })}\n`,
      },
      ...[
        "id",
        "runId",
        "at",
        "classification",
        "stage",
        "evidence",
      ].map((field) => ({
        name: `whitespace-${field}-record`,
        bytes: `${sourceLines[0]}\n${JSON.stringify({
          ...JSON.parse(appendedRecord),
          [field]: " \t ",
        })}\n`,
      })),
      {
        name: "negative-elapsed-record",
        bytes: `${sourceLines[0]}\n${JSON.stringify({
          ...JSON.parse(appendedRecord),
          elapsedMs: -1,
        })}\n`,
      },
      {
        name: "null-optional-context-record",
        bytes: `${sourceLines[0]}\n${JSON.stringify({
          ...JSON.parse(appendedRecord),
          backend: null,
        })}\n`,
      },
      {
        name: "scalar-record",
        bytes: `${sourceLines[0]}\n42\n`,
      },
      {
        name: "array-record",
        bytes: `${sourceLines[0]}\n[]\n`,
      },
      {
        name: "malformed-multivalue-line",
        bytes: `${sourceLines[0]}\n${appendedRecord} ${appendedRecord}\n`,
      },
      { name: "altered-first-seed", bytes: alteredFirstSeed },
    ];
    for (const invalid of invalidCases) {
      const path = join(root, `${invalid.name}.jsonl`);
      await Bun.write(path, invalid.bytes);
      const before = await Bun.file(path).arrayBuffer();
      expect(
        (await runIssueLedgerValidatorHarness(
          validator,
          path,
          harnessOptions,
        )).exitCode,
      ).toBe(65);
      expect(await Bun.file(path).arrayBuffer()).toEqual(before);
    }

    const valid = join(root, "valid-append-only.jsonl");
    await Bun.write(valid, `${sourceLedger}${appendedRecord}\n`);
    const before = await Bun.file(valid).arrayBuffer();
    expect(
      (await runIssueLedgerValidatorHarness(
        validator,
        valid,
        harnessOptions,
      )).exitCode,
    ).toBe(0);
    expect(await Bun.file(valid).arrayBuffer()).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("launcher validates the source ledger before side effects", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const main = extractShellFunction(launcher, "main");
  expect(main).toBeDefined();
  if (main === undefined) return;
  const calls = [
    ...main.matchAll(
      /^  run_before_deadline validate_issue_ledger "\$ledger"\s*$/gm,
    ),
  ];
  expect(calls).toHaveLength(1);
  const callIndex = calls[0]?.index ?? -1;
  const argumentParse = main.match(
    /  for arg in "\$@"; do[\s\S]*?\n  done/,
  )?.[0];
  expect(argumentParse).toBeDefined();
  const argumentParseEnd =
    argumentParse === undefined
      ? -1
      : main.indexOf(argumentParse) + argumentParse.length;
  const loggingIndex = main.indexOf('exec > "$launcher_log" 2>&1');
  const runDirectoryIndex = main.indexOf(
    'run_before_deadline mkdir -p "$run_dir"',
  );
  expect(loggingIndex).toBeGreaterThan(-1);
  expect(runDirectoryIndex).toBeGreaterThan(-1);
  expect(callIndex).toBeGreaterThan(argumentParseEnd);
  expect(callIndex).toBeLessThan(runDirectoryIndex);
  expect(callIndex).toBeLessThan(loggingIndex);

  const trapIndex = launcher.indexOf("trap finalize EXIT");
  const mainInvocation = launcher.indexOf('main "$@"', trapIndex);
  expect(trapIndex).toBeGreaterThan(-1);
  expect(mainInvocation).toBeGreaterThan(trapIndex);

  for (const later of [
    "phase=runtime-build",
    "run_before_deadline build_runtime",
    'run_before_deadline git -C "$source_root" fetch origin main',
    'run_before_deadline git -C "$source_root" worktree add',
    'if [[ "$mode" == preflight ]]',
    "run_before_deadline run_live_workflow",
  ]) {
    const laterIndex = main.indexOf(later, callIndex);
    expect(laterIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeLessThan(laterIndex);
  }
});

test("invalid ledger publishes truthful failure evidence before runtime work", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const root = await mkdtemp(join(tmpdir(), "orcats-invalid-launcher-"));
  const workflows = join(root, ".orca", "workflows");
  const state = join(root, ".orca", "improvement-loop");
  await mkdir(workflows, { recursive: true });
  await mkdir(state, { recursive: true });
  const launcherPath = join(workflows, "codebase-improvement.sh");
  const ledgerPath = join(state, "issues.jsonl");
  const invalidLedger = "{}\n";
  await Bun.write(launcherPath, launcher);
  await Bun.write(ledgerPath, invalidLedger);
  const initialized = Bun.spawnSync(["git", "init", "-q", root]);
  expect(initialized.exitCode).toBe(0);

  try {
    const process = Bun.spawn(
      ["bash", launcherPath, "--preflight-only"],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(65);
    expect(stderr).toContain("invalid issue ledger");
    expect(await Bun.file(ledgerPath).text()).toBe(invalidLedger);
    const latestPath = join(state, "latest.json");
    expect(await Bun.file(latestPath).exists()).toBe(true);
    const latest = await Bun.file(latestPath).json();
    expect(latest.exitCode).toBe(65);
    expect(latest.mode).toBe("preflight");
    expect(latest.phase).toBe("setup");
    expect(latest.runtimePath).toBe("");
    expect(latest.runtimeHead).toBe("");
    expect(latest.baseSha).toBe("");
    expect(latest.artifactDigest).toBe("");
    expect(await Bun.file(join(state, "preflight.json")).exists()).toBe(false);
    const runsExist = await stat(join(state, "runs")).then(
      () => true,
      () => false,
    );
    expect(runsExist).toBe(true);
    const worktreeExists = await stat(latest.worktree).then(
      () => true,
      () => false,
    );
    expect(worktreeExists).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("locked audit artifact set includes the append-only issue ledger", async () => {
  const correction = await Bun.file(
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
  ).text();
  const expected = [
    ".orca/improvement-loop/issues.jsonl",
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
    ".orca/workflows/codebase-improvement-contract.test.ts",
    ".orca/workflows/codebase-improvement-lib.test.ts",
    ".orca/workflows/codebase-improvement-lib.ts",
    ".orca/workflows/codebase-improvement-runtime.test.ts",
    ".orca/workflows/codebase-improvement-runtime.ts",
    ".orca/workflows/codebase-improvement.config.json",
    ".orca/workflows/codebase-improvement.run.md",
    ".orca/workflows/codebase-improvement.sh",
    ".orca/workflows/codebase-improvement.ts",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  for (const path of expected) {
    expect(await Bun.file(path).exists()).toBe(true);
    expect(correction).toContain(`\`${path}\``);
  }
  expect(new Set(expected).size).toBe(14);
  expect([...expected].sort()).toEqual(expected);
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  expect(extractShellArray(launcher, "locked_artifacts")).toEqual(expected);
});

test("launcher copies the locked set by mode and rejects copy-time drift", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const copy = extractShellFunction(launcher, "copy_locked_artifacts");
  const verify = extractShellFunction(launcher, "verify_locked_artifact_copy");
  const main = extractShellFunction(launcher, "main");
  expect(copy).toBeDefined();
  expect(verify).toBeDefined();
  expect(main).toBeDefined();
  if (copy === undefined || verify === undefined || main === undefined) return;
  expect(copy).toContain('if [[ "$mode" == live && "$path" == docs/* ]]');
  expect(copy).toContain('"${locked_artifacts[@]}"');
  expect(verify).toContain('compute_artifact_digest "$source_root"');
  expect(verify).toContain('"$artifact_digest"');
  expect(verify).toContain('sha256_file "$worktree/$path"');
  expect(main.indexOf("run_before_deadline verify_locked_artifact_copy")).toBeLessThan(
    main.indexOf("phase=preflight"),
  );
  expect(main.indexOf("run_before_deadline verify_locked_artifact_copy")).toBeLessThan(
    main.indexOf("phase=live"),
  );

  const locked = extractShellArray(launcher, "locked_artifacts");
  const digest = extractShellFunction(launcher, "compute_artifact_digest");
  expect(locked).toBeDefined();
  expect(digest).toBeDefined();
  if (locked === undefined || digest === undefined) return;
  const root = await mkdtemp(join(tmpdir(), "orcats-locked-copy-"));
  const sourceRoot = join(root, "source");
  const preflightRoot = join(root, "preflight");
  const liveRoot = join(root, "live");
  const driftRoot = join(root, "drift");
  for (const path of locked) {
    await mkdir(join(sourceRoot, path, ".."), { recursive: true });
    await Bun.write(join(sourceRoot, path), `${path}\n`);
  }
  const array = launcher.match(/^locked_artifacts=\([\s\S]*?^\)$/m)?.[0];
  expect(array).toBeDefined();
  if (array === undefined) return;
  const script = join(root, "copy.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "sha256_file() { shasum -a 256 \"$1\" | awk '{print $1}'; }",
      array,
      digest,
      copy,
      verify,
      `source_root=${JSON.stringify(sourceRoot)}`,
      'artifact_digest=$(compute_artifact_digest "$source_root")',
      "mode=preflight",
      `worktree=${JSON.stringify(preflightRoot)}`,
      "copy_locked_artifacts",
      "verify_locked_artifact_copy",
      "mode=live",
      `worktree=${JSON.stringify(liveRoot)}`,
      "copy_locked_artifacts",
      "verify_locked_artifact_copy",
      'artifact_digest=$(compute_artifact_digest "$source_root")',
      `printf 'drift\\n' >> ${JSON.stringify(join(sourceRoot, locked[0]!))}`,
      "mode=preflight",
      `worktree=${JSON.stringify(driftRoot)}`,
      "copy_locked_artifacts",
      "verify_locked_artifact_copy",
    ].join("\n"),
  );
  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(66);
    expect(stderr).toContain("locked artifacts changed after digest capture");
    for (const path of locked) {
      expect(await Bun.file(join(preflightRoot, path)).exists()).toBe(true);
      expect(await Bun.file(join(liveRoot, path)).exists()).toBe(
        !path.startsWith("docs/"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight attestation binds the exact live artifact digest", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const main = extractShellFunction(launcher, "main");
  expect(main).toBeDefined();
  if (main === undefined) return;
  for (const required of [
    "compute_artifact_digest",
    ".orca/improvement-loop/issues.jsonl",
    "preflight.json",
    "artifactDigest",
    "preflightArtifactDigest",
    "baseSha",
    "preflightBaseSha",
    "preflight runtime SHA-256 does not match live runtime",
    "preflight origin/main SHA does not match live origin/main",
    "ORCA_IMPROVEMENT_ARTIFACT_DIGEST",
    "ORCA_IMPROVEMENT_PREFLIGHT_PATH",
  ]) {
    expect(launcher).toContain(required);
  }
  for (const required of [
    "quarantine_prior_evidence",
    'status:"succeeded"',
    'exitCode:0',
    "publish_preflight_attestation",
  ]) {
    expect(launcher).toContain(required);
  }
  const publish = extractShellFunction(
    launcher,
    "publish_preflight_attestation",
  );
  expect(publish).toBeDefined();
  if (publish === undefined) return;
  const preflightWrite = publish.indexOf('> "$preflight_tmp"');
  const preflightMove = publish.indexOf(
    'mv "$preflight_tmp" "$publish_path"',
  );
  const finalizeSource = extractShellFunction(launcher, "finalize");
  expect(finalizeSource).toBeDefined();
  if (finalizeSource === undefined) return;
  const commitSource = extractNestedShellFunction(
    finalizeSource,
    "commit_terminal_evidence",
  );
  expect(commitSource).toBeDefined();
  if (commitSource === undefined) return;
  const preflightStage = finalizeSource.indexOf(
    'run_before_deadline publish_preflight_attestation "$preflight_stage"',
  );
  const terminalCheck = finalizeSource.lastIndexOf(
    "assert_package_lock_unchanged",
  );
  const terminalCommit = finalizeSource.indexOf("    commit_terminal_evidence");
  const latestCommit = commitSource.indexOf("validate_latest_publication_file");
  const preflightCommit = commitSource.indexOf(
    "validate_preflight_publication_file",
  );
  expect(preflightWrite).toBeGreaterThan(-1);
  expect(preflightMove).toBeGreaterThan(preflightWrite);
  expect(main).toContain("run_before_deadline run_live_workflow");
  expect(preflightStage).toBeGreaterThan(-1);
  expect(terminalCheck).toBeGreaterThan(preflightStage);
  expect(terminalCommit).toBeGreaterThan(terminalCheck);
  expect(latestCommit).toBeGreaterThan(-1);
  expect(preflightCommit).toBeGreaterThan(latestCommit);
  expect(launcher).toContain(
    "preflight attestation is not fresh terminal success",
  );
});

test("launcher bounds every blocking phase with one process-group deadline", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const controller = extractShellFunction(launcher, "controller_run_until");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const main = extractShellFunction(launcher, "main");
  expect(controller).toBeDefined();
  expect(bounded).toBeDefined();
  expect(main).toBeDefined();
  if (controller === undefined || bounded === undefined || main === undefined) return;
  const signalChild = extractNestedShellFunction(
    controller,
    "controller_signal_child",
  );
  expect(signalChild).toBeDefined();
  expect(controller).toContain("set -m");
  expect(controller).toContain(
    [
      "      controller_wait_seconds=$(( stop_second - SECONDS ))",
      '      if [[ "$controller_wait_seconds" -gt 1 ]]; then',
      "        controller_wait_seconds=1",
      "      fi",
    ].join("\n"),
  );
  expect(signalChild).toContain(
    'kill "-$signal" -- "-$controller_child_pid"',
  );
  expect(controller).toContain("controller_signal_child TERM");
  expect(controller).toContain("controller_signal_child KILL");
  expect(controller).toContain(
    [
      "        broker_capture_value=$(",
      "          trap - TERM INT HUP",
      "          unset controller_capture_draining controller_capture_name \\",
    ].join("\n"),
  );
  expect(controller).toContain(
    [
      '        if [[ "$broker_signal_status" -ne 0 ]]; then',
      '          broker_command_status="$broker_signal_status"',
      "        fi",
    ].join("\n"),
  );
  expect(controller).toContain(
    [
      "        printf '%s%s:%s\\0' \\",
      '          "$controller_payload_prefix" "${#broker_capture_value}" \\',
      '          "$broker_capture_value"',
    ].join("\n"),
  );
  expect(bounded).toContain(
    'controller_run_until "$command_active_term_second"',
  );
  expect(bounded).toContain("terminate_command_owner_pids");
  for (const invocation of [
    "run_before_deadline validate_issue_ledger",
    "run_before_deadline build_runtime",
    "run_before_deadline git -C \"$source_root\" fetch origin main",
    "run_before_deadline git -C \"$source_root\" worktree add",
    "run_before_deadline copy_locked_artifacts",
    "run_before_deadline bun install --frozen-lockfile",
    "run_before_deadline run_preflight_gates",
    "run_before_deadline run_live_workflow",
  ]) {
    expect(main).toContain(invocation);
  }
});

test("launcher captures bounded output only from the main shell", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  expect(boundedCaptureContractIssues(launcher)).toEqual([]);

  const mutation = launcher.replace(
    'capture_before_deadline runtime_head git -C "$source_root" rev-parse HEAD',
    'runtime_head=$(run_before_deadline git -C "$source_root" rev-parse HEAD)',
  );
  expect(mutation).not.toBe(launcher);
  expect(boundedCaptureContractIssues(mutation)).toContain(
    "bounded commands must never run inside command substitution",
  );

  const controllerMutation = launcher.replace(
    [
      "  controller_deadline_cutoffs term_second kill_second || return $?",
      '  controller_run_until "$term_second" "$kill_second" \\',
      '    --capture capture_value "$@" || capture_status=$?',
    ].join("\n"),
    '  capture_value=$(controller_run_before_deadline "$@") || capture_status=$?',
  );
  expect(controllerMutation).not.toBe(launcher);
  expect(boundedCaptureContractIssues(controllerMutation)).toContain(
    "controller capture must not run inside command substitution",
  );

  const successfulRecordFallback = [
    "            controller_capture_payload_seen=true",
    "          else",
    "            return 125",
    "          fi",
  ].join("\n");
  const nonemptyOnlyFallback = [
    "            controller_capture_payload_seen=true",
    '          elif [[ -n "$controller_line" ]]; then',
    "            return 125",
    "          fi",
  ].join("\n");
  const emptyFrameMutation = launcher.replace(
    successfulRecordFallback,
    nonemptyOnlyFallback,
  );
  expect(emptyFrameMutation).not.toBe(launcher);
  expect(boundedCaptureContractIssues(emptyFrameMutation)).toContain(
    "captured broker must reject every untyped successful record",
  );
});

test("controller startup captures preserve signal precedence without command substitution", async () => {
  for (const scenario of ["now-ms", "startup-git"] as const) {
    const result = await runControllerCaptureStartupSignalScenario(scenario);
    expect(result, scenario).toEqual({
      controllerResidue: [],
      elapsedAfterSignalMs: expect.any(Number),
      entered: true,
      exitCode: 143,
      processResidue: [],
      timedOut: false,
    });
    expect(result.elapsedAfterSignalMs, scenario).toBeLessThan(1_500);
  }
}, 12_000);

test("concurrent canonical publishers commit exactly one authoritative preflight pair", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runConcurrentCanonicalPublicationHarness(launcher);

  expect(result).toEqual({
    readyCountBeforeWinnerRelease: 1,
    statuses: [0, 73],
    statusByPublisher: { A: 0, B: 73 },
    canonicalRunIds: {
      latest: "publisher-a",
      preflight: "publisher-a",
    },
    pairValid: true,
    stages: {
      A: { latest: false, preflight: false },
      B: { latest: true, preflight: true },
    },
    locks: { latest: false, preflight: false },
    liveGroups: [],
  });
  expect(result.statuses).toEqual([0, 73]);
  expect(result.readyCountBeforeWinnerRelease).toBe(1);
  expect(result.canonicalRunIds.latest).toBe(result.canonicalRunIds.preflight);
  expect(result.pairValid).toBe(true);
  expect(result.stages.A).toEqual({ latest: false, preflight: false });
  expect(result.stages.B).toEqual({ latest: true, preflight: true });
  expect(result.locks).toEqual({ latest: false, preflight: false });
  expect(result.liveGroups).toEqual([]);
}, 10_000);

test("publication lock signals release proven ownership and permit a fresh publisher", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  for (const [signal, status] of [
    ["TERM", 143],
    ["INT", 130],
    ["HUP", 129],
  ] as const) {
    const result = await runPublicationLockLifecycleHarness(launcher, signal);
    expect(result, signal).toEqual({
      firstStatus: status,
      freshStatus: 0,
      lockAtBarrier: true,
      ownersAtBarrier: 1,
      lockAfterFirst: false,
      ownersAfterFirst: 0,
      destinationBytes:
        '{"exitCode":0,"runId":"fresh","status":"succeeded"}\n',
      stages: { first: true, fresh: false },
      calls: {
        firstValidator: true,
        firstMove: true,
        freshValidator: true,
        freshMove: true,
      },
      liveGroups: [],
    });
  }
}, 15_000);

test("SIGKILL leaves the publication lock fail closed", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runPublicationLockLifecycleHarness(launcher, "KILL");
  expect(result).toEqual({
    firstStatus: 137,
    freshStatus: 73,
    lockAtBarrier: true,
    ownersAtBarrier: 1,
    lockAfterFirst: true,
    ownersAfterFirst: 1,
    destinationBytes: undefined,
    stages: { first: true, fresh: true },
    calls: {
      firstValidator: true,
      firstMove: true,
      freshValidator: false,
      freshMove: false,
    },
    liveGroups: [],
  });
}, 10_000);

test("publication cleanup failures preserve committed bytes and winner status", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  for (const [scenario, ownersAfterFirst] of [
    ["owner-cleanup-failure", 1],
    ["directory-cleanup-failure", 0],
  ] as const) {
    const result = await runPublicationLockLifecycleHarness(launcher, scenario);
    expect(result, scenario).toEqual({
      firstStatus: 0,
      freshStatus: 73,
      lockAtBarrier: true,
      ownersAtBarrier: 1,
      lockAfterFirst: true,
      ownersAfterFirst,
      destinationBytes:
        '{"exitCode":0,"runId":"first","status":"succeeded"}\n',
      stages: { first: false, fresh: true },
      calls: {
        firstValidator: true,
        firstMove: true,
        freshValidator: false,
        freshMove: false,
      },
      liveGroups: [],
    });
  }
}, 15_000);

test("pre-existing publication lock objects fail closed before validation", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const results = await Promise.all(
    (["directory", "file", "symlink"] as const).map((kind) =>
      runPreexistingPublicationLockHarness(launcher, kind)
    ),
  );
  expect(results).toEqual([
    {
      kind: "directory",
      status: 73,
      stageExists: true,
      destinationExists: false,
      validatorCalled: false,
      moveCalled: false,
      lockIsDirectory: true,
      lockIsFile: false,
      lockIsSymlink: false,
      groupAlive: false,
    },
    {
      kind: "file",
      status: 73,
      stageExists: true,
      destinationExists: false,
      validatorCalled: false,
      moveCalled: false,
      lockIsDirectory: false,
      lockIsFile: true,
      lockIsSymlink: false,
      groupAlive: false,
    },
    {
      kind: "symlink",
      status: 73,
      stageExists: true,
      destinationExists: false,
      validatorCalled: false,
      moveCalled: false,
      lockIsDirectory: false,
      lockIsFile: false,
      lockIsSymlink: true,
      groupAlive: false,
    },
  ]);
  expect(
    await runPreexistingPublicationLockHarness(launcher, "directory", false),
  ).toEqual({
    kind: "directory",
    status: 73,
    stageExists: false,
    destinationExists: false,
    validatorCalled: false,
    moveCalled: false,
    lockIsDirectory: true,
    lockIsFile: false,
    lockIsSymlink: false,
    groupAlive: false,
  });
}, 10_000);

test("canonical publication source contract supervises every commit point", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  expect(canonicalPublicationContractIssues(launcher)).toEqual([]);

  const mutations = [
    {
      name: "missing recovery reserve",
      source: launcher.replace(
        "canonical_recovery_reserve_ms=1000",
        "canonical_recovery_reserve_ms=0",
      ),
      issue: "publication worker must reserve and restore exactly 1000 ms",
    },
    {
      name: "composed recovery allowance omitted",
      source: launcher.replace(
        "  total_reserve_ms=$(( reserve_ms + outer_controller_reserve_ms ))",
        '  total_reserve_ms="$outer_controller_reserve_ms"',
      ),
      issue:
        "publication recovery reserve must compose inner cleanup and outer controller budget",
    },
    {
      name: "outer recovery TERM grace omitted",
      source: launcher.replace(
        [
          "  local controller_term_grace_seconds=1",
          "  local command_cleanup_reserve_seconds=2",
          "  local outer_controller_reserve_ms=0",
        ].join("\n"),
        [
          "  local controller_term_grace_seconds=0",
          "  local command_cleanup_reserve_seconds=2",
          "  local outer_controller_reserve_ms=0",
        ].join("\n"),
      ),
      issue:
        "publication recovery reserve must compose inner cleanup and outer controller budget",
    },
    {
      name: "outer recovery cleanup omitted",
      source: launcher.replace(
        [
          "  local controller_term_grace_seconds=1",
          "  local command_cleanup_reserve_seconds=2",
          "  local outer_controller_reserve_ms=0",
        ].join("\n"),
        [
          "  local controller_term_grace_seconds=1",
          "  local command_cleanup_reserve_seconds=0",
          "  local outer_controller_reserve_ms=0",
        ].join("\n"),
      ),
      issue:
        "publication recovery reserve must compose inner cleanup and outer controller budget",
    },
    {
      name: "inner command TERM grace omitted",
      source: launcher.replace(
        [
          "  local controller_term_grace_seconds=1",
          "  local command_cleanup_reserve_seconds=2",
          '  local command_term_second=""',
        ].join("\n"),
        [
          "  local controller_term_grace_seconds=0",
          "  local command_cleanup_reserve_seconds=2",
          '  local command_term_second=""',
        ].join("\n"),
      ),
      issue:
        "publication recovery reserve must compose inner cleanup and outer controller budget",
    },
    {
      name: "inner command cleanup omitted",
      source: launcher.replace(
        [
          "  local controller_term_grace_seconds=1",
          "  local command_cleanup_reserve_seconds=2",
          '  local command_term_second=""',
        ].join("\n"),
        [
          "  local controller_term_grace_seconds=1",
          "  local command_cleanup_reserve_seconds=0",
          '  local command_term_second=""',
        ].join("\n"),
      ),
      issue:
        "publication recovery reserve must compose inner cleanup and outer controller budget",
    },
    {
      name: "fallible work after rename",
      source: launcher.replace(
        '    mv -- "$source_path" "$destination_path" || move_status=$?\n  fi\n  publication_release_lock "$move_status" || :',
        '    mv -- "$source_path" "$destination_path" || move_status=$?\n    false\n  fi\n  publication_release_lock "$move_status" || :',
      ),
      issue:
        "rename action must validate under lock immediately before its final mv",
    },
    {
      name: "source hash gate removed",
      source: launcher.replace(
        '  if [[ "$move_status" -eq 0 && \\\n    "$current_sha256" != "$expected_sha256" ]]; then\n    move_status=65\n  fi',
        "  :",
      ),
      issue: "rename action must reject bytes changed after digest capture",
    },
    {
      name: "exact-zero final action accepted",
      source: launcher.replace(
        '  if [[ "$move_status" -eq 0 && "$remaining_ms" -le 0 ]]; then\n    move_status=124\n  fi',
        '  if [[ "$move_status" -eq 0 && "$remaining_ms" -lt 0 ]]; then\n    move_status=124\n  fi',
      ),
      issue: "rename action must reject exact-zero remainder before mv",
    },
    {
      name: "destination lock acquisition removed",
      source: launcher.replace(
        '  if ! mkdir "$publication_lock" 2>/dev/null; then\n    return 73\n  fi\n  publication_lock_owned=true',
        "  publication_lock_owned=true",
      ),
      issue: "rename action must acquire one destination-keyed exclusive lock",
    },
    {
      name: "publication lock keyed by source",
      source: launcher.replace(
        'local publication_lock="${destination_path}.publication-lock"',
        'local publication_lock="${source_path}.publication-lock"',
      ),
      issue: "rename action must acquire one destination-keyed exclusive lock",
    },
    {
      name: "publication lock released before final destination check",
      source: launcher.replace(
        '  if [[ "$move_status" -eq 0 && \\\n    ( -e "$destination_path" || -L "$destination_path" ) ]]; then',
        '  publication_release_lock "$move_status" || :\n  if [[ "$move_status" -eq 0 && \\\n    ( -e "$destination_path" || -L "$destination_path" ) ]]; then',
      ),
      issue:
        "publication lock must remain owned through final destination check and mv",
    },
    {
      name: "publication cleanup replaces move status",
      source: launcher.replace(
        '    return "$caller_status"',
        '    return "$cleanup_status"',
      ),
      issue: "publication cleanup must preserve authoritative move status",
    },
    {
      name: "publication lock inspects stale owner PID",
      source: launcher.replace(
        "  publication_lock_owned=true",
        '  publication_lock_owned=true\n  kill -0 "$stale_owner_pid" || true',
      ),
      issue: "publication lock must never inspect or reclaim stale owners",
    },
    {
      name: "both paths accepted during recovery",
      source: launcher.replace(
        '  if [[ -e "$source_path" || -L "$source_path" ]]; then\n    return 1\n  fi',
        "  :",
      ),
      issue: "rename recovery must prove exclusive exact destination bytes",
    },
    {
      name: "non-timeout recovery accepted",
      source: launcher.replace(
        '  if [[ "$rename_status" -ne 124 ]]; then\n    return "$rename_status"\n  fi',
        "  :",
      ),
      issue: "rename recovery must accept only status 124 ambiguity",
    },
    {
      name: "recovery error precedes signal status",
      source: launcher.replace(
        '  if [[ "${launcher_signal_status:-0}" -ne 0 ]]; then',
        '  if [[ "$recovery_status" -ne 0 ]]; then\n    return "$recovery_status"\n  fi\n  if [[ "${launcher_signal_status:-0}" -ne 0 ]]; then',
      ),
      issue: "rename recovery must preserve supervised signal status",
    },
    {
      name: "terminal ledger merge bypasses recovery reserve",
      source: launcher.replace(
        [
          '      run_before_deadline_with_reserve "$canonical_recovery_reserve_ms" \\',
          '        merge_issue_ledger "$candidate_ledger" "$ledger_base_snapshot" \\',
          "        terminal-commit || terminal_ledger_status=$?",
        ].join("\n"),
        '      run_before_deadline merge_issue_ledger "$candidate_ledger" "$ledger_base_snapshot" terminal-commit || terminal_ledger_status=$?',
      ),
      issue: "terminal ledger merge must reserve recovery time",
    },
    {
      name: "terminal ledger recovery bypasses supervision",
      source: launcher.replace(
        "        run_before_deadline validate_terminal_ledger_recovery \\",
        "        validate_terminal_ledger_recovery \\",
      ),
      issue: "terminal ledger recovery must be deadline-supervised exactly once",
    },
    ...(["file", "record", "sha"] as const).map((read) => ({
      name: `terminal ledger recovery splits ${read} read into parent shell`,
      source: launcher.replace(
        "        run_before_deadline validate_terminal_ledger_recovery \\",
        [
          read === "file"
            ? '        [[ -f "$ledger" ]] || true'
            : read === "record"
              ? '        issue_ledger_has_terminal_commit "$ledger" || true'
              : '        sha256_file "$ledger" >/dev/null || true',
          "        run_before_deadline validate_terminal_ledger_recovery \\",
        ].join("\n"),
      ),
      issue: "terminal ledger recovery reads must stay inside one supervised action",
    })),
    {
      name: "terminal ledger recovery runs more than once",
      source: launcher.replace(
        "        run_before_deadline validate_terminal_ledger_recovery \\",
        [
          '        run_before_deadline validate_terminal_ledger_recovery "$ledger" || true',
          "        run_before_deadline validate_terminal_ledger_recovery \\",
        ].join("\n"),
      ),
      issue: "terminal ledger recovery must be deadline-supervised exactly once",
    },
    {
      name: "signal fallback file cleanup bypasses deadline",
      source: launcher.replace(
        'discard_private_path_before_deadline "$signal_preflight_fallback"',
        'rm -f -- "$signal_preflight_fallback"',
      ),
      issue: "finalizer private cleanup must be deadline-supervised",
    },
    {
      name: "signal fallback allocation invokes unbounded mktemp",
      source: launcher.replace(
        'local signal_latest_fallback="${latest}.signal.${run_id}"',
        'local signal_latest_fallback="$(mktemp -d "${latest}.signal.${run_id}.XXXXXX")/latest.json"',
      ),
      issue: "finalizer private cleanup must be deadline-supervised",
    },
    {
      name: "ledger snapshot cleanup bypasses deadline",
      source: launcher.replace(
        'discard_private_path_before_deadline \\\n        "$ledger_base_snapshot" 2>/dev/null || true',
        'rm -f "$ledger_base_snapshot" 2>/dev/null || true',
      ),
      issue: "finalizer private cleanup must be deadline-supervised",
    },
    {
      name: "latest schema validation removed",
      source: launcher.replace(
        '      "$latest_tmp" "$latest" validate_latest_publication_file \\',
        '      "$latest_tmp" "$latest" validate_regular_publication_file \\',
      ),
      issue: "latest commit must use supervised atomic publication",
    },
    {
      name: "capture redirects in supervisor shell",
      source: launcher.replace(
        'run_before_deadline --capture capture_value "$@"',
        'capture_value=$("$@")',
      ),
      issue: "capture redirection must execute inside supervised worker",
    },
    {
      name: "render redirects in supervisor shell",
      source: launcher.replace(
        "run_before_deadline render_latest_evidence_action",
        'run_before_deadline jq -n > "$latest_tmp"',
      ),
      issue: "latest render redirection must execute inside supervised worker",
    },
  ] as const;
  for (const mutation of mutations) {
    expect(mutation.source, mutation.name).not.toBe(launcher);
    expect(
      canonicalPublicationContractIssues(mutation.source),
      mutation.name,
    ).toContain(mutation.issue);
  }
});

test("terminal recovery signal adjudication mutations preserve commit-point semantics", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const issue =
    "terminal recovery signal adjudication must preserve commit-point semantics";
  const mutations = [
    {
      name: "launcher signal reinserted as recovery pre-gate",
      source: launcher.replace(
        '        "$terminal_commit_signal_status" -eq 0 ]]; then',
        [
          '        "$terminal_commit_signal_status" -eq 0 && \\',
          '        "$launcher_signal_status" -eq 0 ]]; then',
        ].join("\n"),
      ),
    },
    {
      name: "launcher signal reinserted as recovery overwrite",
      source: launcher.replace(
        '        elif [[ "$terminal_ledger_recovery_status" -eq 0 ]]; then',
        [
          '        elif [[ "$launcher_signal_status" -ne 0 ]]; then',
          '          terminal_ledger_status="$launcher_signal_status"',
          '        elif [[ "$terminal_ledger_recovery_status" -eq 0 ]]; then',
        ].join("\n"),
      ),
    },
    {
      name: "merge status clears without exact validator success",
      source: launcher.replace(
        '        elif [[ "$terminal_ledger_recovery_status" -eq 0 ]]; then',
        "        elif true; then",
      ),
    },
    {
      name: "terminal commit signal recovery pre-gate removed",
      source: launcher.replace(
        [
          '      if [[ "$terminal_ledger_status" -ne 0 && \\',
          '        "$terminal_commit_signal_status" -eq 0 ]]; then',
        ].join("\n"),
        [
          '      if [[ "$terminal_ledger_status" -ne 0 && \\',
          "        0 -eq 0 ]]; then",
        ].join("\n"),
      ),
    },
  ] as const;

  for (const mutation of mutations) {
    expect(mutation.source, mutation.name).not.toBe(launcher);
    expect(
      canonicalPublicationContractIssues(mutation.source),
      mutation.name,
    ).toContain(issue);
  }
});

test("publication lock behavior mutations restore clobbering or false failure", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const concurrencyMutations = [
    {
      name: "non-exclusive acquisition",
      source: launcher.replace(
        '  if ! mkdir "$publication_lock" 2>/dev/null; then\n    return 73\n  fi\n  publication_lock_owned=true',
        '  mkdir -p "$publication_lock"\n  publication_lock_owned=true',
      ),
    },
    {
      name: "source-keyed lock",
      source: launcher.replace(
        'local publication_lock="${destination_path}.publication-lock"',
        'local publication_lock="${source_path}.publication-lock"',
      ),
    },
    {
      name: "early release",
      source: launcher.replace(
        '  if [[ "$move_status" -eq 0 && \\\n    ( -e "$destination_path" || -L "$destination_path" ) ]]; then',
        '  publication_release_lock "$move_status" || :\n  if [[ "$move_status" -eq 0 && \\\n    ( -e "$destination_path" || -L "$destination_path" ) ]]; then',
      ),
    },
  ] as const;
  for (const mutation of concurrencyMutations) {
    expect(mutation.source, mutation.name).not.toBe(launcher);
    expect(
      await runConcurrentCanonicalPublicationHarness(mutation.source),
      mutation.name,
    ).toEqual({
      readyCountBeforeWinnerRelease: 2,
      statuses: [0, 0],
      statusByPublisher: { A: 0, B: 0 },
      canonicalRunIds: {
        latest: "publisher-b",
        preflight: "publisher-a",
      },
      pairValid: false,
      stages: {
        A: { latest: false, preflight: false },
        B: { latest: false, preflight: false },
      },
      locks: { latest: false, preflight: false },
      liveGroups: [],
    });
  }

  const cleanupMutation = launcher.replace(
    '    return "$caller_status"',
    '    return "$cleanup_status"',
  ).replace(
    '  publication_release_lock "$move_status" || :\n  trap - EXIT TERM INT HUP\n  return "$move_status"',
    '  publication_release_lock "$move_status" || move_status=$?\n  trap - EXIT TERM INT HUP\n  return "$move_status"',
  );
  expect(cleanupMutation).not.toBe(launcher);
  expect(
    await runPublicationLockLifecycleHarness(
      cleanupMutation,
      "owner-cleanup-failure",
    ),
  ).toEqual({
    firstStatus: 1,
    freshStatus: 73,
    lockAtBarrier: true,
    ownersAtBarrier: 1,
    lockAfterFirst: true,
    ownersAfterFirst: 1,
    destinationBytes:
      '{"exitCode":0,"runId":"first","status":"succeeded"}\n',
    stages: { first: false, fresh: true },
    calls: {
      firstValidator: true,
      firstMove: true,
      freshValidator: false,
      freshMove: false,
    },
    liveGroups: [],
  });
}, 20_000);

test("canonical publication recovers only an exact timeout-after-rename", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const expected = '{"runId":"run","status":"succeeded","exitCode":0}\n';
  const success = await runAtomicPublicationHarness(launcher, "success");
  expect(success.exitCode).toBe(0);
  expect(success.sourceExists).toBe(false);
  expect(success.destinationBytes).toBe(expected);
  expect(success.deadlineRestored).toBe(true);

  const before = await runAtomicPublicationHarness(
    launcher,
    "timeout-before-rename",
  );
  expect(before.exitCode).toBe(124);
  expect(before.sourceExists).toBe(true);
  expect(before.destinationExists).toBe(false);
  expect(before.deadlineRestored).toBe(true);

  const after = await runAtomicPublicationHarness(
    launcher,
    "forced-timeout-after-rename",
  );
  expect(after.exitCode).toBe(0);
  expect(after.sourceExists).toBe(false);
  expect(after.destinationBytes).toBe(expected);
  expect(after.deadlineRestored).toBe(true);

  const failedAfter = await runAtomicPublicationHarness(
    launcher,
    "failure-after-rename",
  );
  expect(failedAfter.exitCode).toBe(7);
  expect(failedAfter.sourceExists).toBe(false);
  expect(failedAfter.destinationBytes).toBe(expected);
  expect(failedAfter.deadlineRestored).toBe(true);

  const occupied = await runAtomicPublicationHarness(
    launcher,
    "occupied-destination",
  );
  expect(occupied.exitCode).toBe(73);
  expect(occupied.sourceExists).toBe(true);
  expect(occupied.destinationExists).toBe(true);

  const symlinked = await runAtomicPublicationHarness(
    launcher,
    "symlink-destination",
  );
  expect(symlinked.exitCode).toBe(73);
  expect(symlinked.sourceExists).toBe(true);
  expect(symlinked.destinationIsSymlink).toBe(true);

  const wrong = await runAtomicPublicationHarness(
    launcher,
    "wrong-destination-bytes",
  );
  expect(wrong.exitCode).toBe(7);
  expect(wrong.sourceExists).toBe(false);
  expect(wrong.destinationBytes).toBe("wrong");
}, 15_000);

test("canonical recovery with 3,999 ms remaining fails closed", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const expected = '{"runId":"run","status":"succeeded","exitCode":0}\n';
  const result = await runAtomicPublicationHarness(
    launcher,
    "below-reserve-timeout-after-rename",
  );

  expect(result.exitCode).toBe(124);
  expect(result.sourceExists).toBe(false);
  expect(result.destinationBytes).toBe(expected);
  expect(result.deadlineRestored).toBe(true);
  expect(result.processGroupAliveAfterCleanup).toBe(false);
  expect(result.rootExistsAfterCleanup).toBe(false);
}, 15_000);

test("canonical recovery at exact 4,000 ms reserve fails closed", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const expected = '{"runId":"run","status":"succeeded","exitCode":0}\n';
  const result = await runAtomicPublicationHarness(
    launcher,
    "at-reserve-timeout-after-rename",
  );

  expect(result.exitCode).toBe(124);
  expect(result.sourceExists).toBe(false);
  expect(result.destinationBytes).toBe(expected);
  expect(result.deadlineRestored).toBe(true);
  expect(result.processGroupAliveAfterCleanup).toBe(false);
  expect(result.rootExistsAfterCleanup).toBe(false);
}, 15_000);

test("atomic action rejects exact-zero immediately before its final move", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const expected = '{"runId":"run","status":"succeeded","exitCode":0}\n';
  const safe = await runAtomicActionCutoffHarness(launcher);
  expect(safe.exitCode).toBe(124);
  expect(safe.validatorCompleted).toBe(true);
  expect(safe.sourceExists).toBe(true);
  expect(safe.destinationExists).toBe(false);

  const zeroAccepted = launcher.replace(
    '  if [[ "$move_status" -eq 0 && "$remaining_ms" -le 0 ]]; then\n    move_status=124\n  fi',
    '  if [[ "$move_status" -eq 0 && "$remaining_ms" -lt 0 ]]; then\n    move_status=124\n  fi',
  );
  expect(zeroAccepted).not.toBe(launcher);
  const unsafe = await runAtomicActionCutoffHarness(zeroAccepted);
  expect(unsafe.exitCode).toBe(0);
  expect(unsafe.validatorCompleted).toBe(true);
  expect(unsafe.sourceExists).toBe(false);
  expect(unsafe.destinationExists).toBe(true);
  expect(unsafe.destinationBytes).toBe(expected);
});

test("canonical callers enforce route status schema hash and cutoff", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const routes = [
    {
      route: "prior-quarantine",
      mismatchStatus: 1,
      cutoffStatus: 1,
      expected: { route: "prior-quarantine" },
    },
    {
      route: "current-quarantine",
      mismatchStatus: 1,
      cutoffStatus: 1,
      expected: { route: "current-quarantine" },
    },
    {
      route: "failure-tombstone",
      mismatchStatus: 1,
      cutoffStatus: 1,
      expected: { runId: "run", status: "failed", exitCode: 74 },
    },
    {
      route: "latest-commit",
      mismatchStatus: 65,
      cutoffStatus: 124,
      expected: { runId: "run", exitCode: 0 },
    },
    {
      route: "preflight-commit",
      mismatchStatus: 65,
      cutoffStatus: 124,
      expected: { runId: "run", status: "succeeded", exitCode: 0 },
    },
  ] as const;

  for (const route of routes) {
    const success = await runCanonicalRouteHarness(
      launcher,
      route.route,
      "success",
    );
    expect(success.exitCode, `${route.route}:success:${success.stderr}`).toBe(0);
    expect(success.sourceExists, `${route.route}:success`).toBe(false);
    expect(success.destinationExists, `${route.route}:success`).toBe(true);
    expect(
      JSON.parse(success.destinationBytes ?? "null"),
      `${route.route}:schema`,
    ).toEqual(route.expected);

    const mismatch = await runCanonicalRouteHarness(
      launcher,
      route.route,
      "source-hash-mismatch",
    );
    expect(
      mismatch.exitCode,
      `${route.route}:mismatch:${mismatch.stderr}`,
    ).toBe(route.mismatchStatus);
    expect(mismatch.destinationExists, `${route.route}:mismatch`).toBe(false);
    expect(mismatch.sourceExists, `${route.route}:mismatch`).toBe(
      route.route !== "failure-tombstone",
    );

    const cutoff = await runCanonicalRouteHarness(
      launcher,
      route.route,
      "exact-zero",
    );
    expect(cutoff.exitCode, `${route.route}:cutoff:${cutoff.stderr}`).toBe(
      route.cutoffStatus,
    );
    expect(cutoff.sourceExists, `${route.route}:cutoff`).toBe(true);
    expect(cutoff.destinationExists, `${route.route}:cutoff`).toBe(false);
  }

  const withoutHashGate = launcher.replace(
    '  if [[ "$move_status" -eq 0 && \\\n    "$current_sha256" != "$expected_sha256" ]]; then\n    move_status=65\n  fi',
    "  :",
  );
  expect(withoutHashGate).not.toBe(launcher);
  for (const route of routes) {
    const unsafe = await runCanonicalRouteHarness(
      withoutHashGate,
      route.route,
      "source-hash-mismatch",
    );
    expect(unsafe.exitCode, `${route.route}:hash-mutant:${unsafe.stderr}`).toBe(0);
    expect(unsafe.sourceExists, `${route.route}:hash-mutant`).toBe(false);
    expect(unsafe.destinationExists, `${route.route}:hash-mutant`).toBe(true);
    expect(
      JSON.parse(unsafe.destinationBytes ?? "null"),
      `${route.route}:hash-mutant-schema`,
    ).toEqual(route.expected);
  }

  const routeMutations = [
    {
      route: "prior-quarantine",
      source: launcher.replace(
        '      "$stable_path" "$quarantine_path" validate_regular_publication_file || \\\n      rename_status=$?',
        '      "$stable_path" "$quarantine_path" validate_regular_publication_file || \\\n      rename_status=0',
      ),
    },
    {
      route: "current-quarantine",
      source: launcher.replace(
        '    if ! atomic_rename_before_deadline \\\n      "$latest" "$latest_tmp" validate_regular_publication_file;',
        '    if atomic_rename_before_deadline \\\n      "$latest" "$latest_tmp" validate_regular_publication_file;',
      ),
    },
    {
      route: "failure-tombstone",
      source: launcher.replace(
        '    if ! atomic_rename_before_deadline \\\n      "$tombstone" "$latest" validate_failure_tombstone_file \\\n      "$run_id" "$status";',
        '    if atomic_rename_before_deadline \\\n      "$tombstone" "$latest" validate_failure_tombstone_file \\\n      "$run_id" "$status";',
      ),
    },
    {
      route: "latest-commit",
      source: launcher.replace(
        '      "$run_id" "$final_status" || commit_status=$?',
        '      "$run_id" "$final_status" || commit_status=0',
      ),
    },
    {
      route: "preflight-commit",
      source: launcher.replace(
        '      preflight_commit_status=$?',
        '      preflight_commit_status=0',
      ),
    },
  ] as const;
  for (const mutation of routeMutations) {
    expect(mutation.source, mutation.route).not.toBe(launcher);
    const unsafe = await runCanonicalRouteHarness(
      mutation.source,
      mutation.route,
      "source-hash-mismatch",
    );
    expect(unsafe.exitCode, `${mutation.route}:route-mutant:${unsafe.stderr}`).toBe(0);
    expect(unsafe.sourceExists, `${mutation.route}:route-mutant`).toBe(true);
    expect(unsafe.destinationExists, `${mutation.route}:route-mutant`).toBe(false);
  }
}, 30_000);

test("canonical publication TERM INT and HUP never mutate after cutoff", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  for (const { signal, status } of [
    { signal: "SIGTERM", status: 143 },
    { signal: "SIGINT", status: 130 },
    { signal: "SIGHUP", status: 129 },
  ] as const) {
    const result = await runAtomicPublicationHarness(
      launcher,
      "success",
      signal,
      "before-rename",
      0,
      "/bin/bash",
    );
    expect(result.exitCode, signal).toBe(status);
    expect(result.sourceExists, signal).toBe(true);
    expect(result.destinationExists, signal).toBe(false);
    expect(result.deadlineRestored, signal).toBe(true);
  }
}, 15_000);

test("canonical recovery propagates TERM INT and HUP after rename", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const expected = '{"runId":"run","status":"succeeded","exitCode":0}\n';
  for (const { signal, status } of [
    { signal: "SIGTERM", status: 143 },
    { signal: "SIGINT", status: 130 },
    { signal: "SIGHUP", status: 129 },
  ] as const) {
    const result = await runAtomicPublicationHarness(
      launcher,
      "forced-timeout-after-rename",
      signal,
      "during-recovery",
      0,
      "/bin/bash",
    );
    expect(result.exitCode, signal).toBe(status);
    expect(result.childExitedBeforeMarker, signal).toBe(false);
    expect(result.sourceExists, signal).toBe(false);
    expect(result.destinationBytes, signal).toBe(expected);
    expect(result.deadlineRestored, signal).toBe(true);
  }
}, 15_000);

test("during-recovery signals precede delayed controller observation", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const expected = '{"runId":"run","status":"succeeded","exitCode":0}\n';
  for (const { signal, status } of [
    { signal: "SIGTERM", status: 143 },
    { signal: "SIGINT", status: 130 },
    { signal: "SIGHUP", status: 129 },
  ] as const) {
    const result = await runAtomicPublicationHarness(
      launcher,
      "forced-timeout-after-rename",
      signal,
      "during-recovery",
      0,
      "/bin/bash",
      false,
      1_500,
    );
    expect(result.exitCode, signal).toBe(status);
    expect(result.childExitedBeforeMarker, signal).toBe(false);
    expect(result.destinationBytes, signal).toBe(expected);
    expect(result.deadlineRestored, signal).toBe(true);
    expect(result.processGroupAliveAfterCleanup, signal).toBe(false);
    expect(result.rootExistsAfterCleanup, signal).toBe(false);
  }
}, 15_000);

test("post-recovery signal latch outranks every recovery result", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const expected = '{"runId":"run","status":"succeeded","exitCode":0}\n';
  for (const { signal, status } of [
    { signal: "SIGTERM", status: 143 },
    { signal: "SIGINT", status: 130 },
    { signal: "SIGHUP", status: 129 },
  ] as const) {
    for (const recoveryStatus of [0, 125] as const) {
      const result = await runAtomicPublicationHarness(
        launcher,
        "forced-timeout-after-rename",
        signal,
        "after-recovery",
        recoveryStatus,
        "/bin/bash",
      );
      expect(result.exitCode, `${signal}:${String(recoveryStatus)}`).toBe(status);
      expect(result.sourceExists, signal).toBe(false);
      expect(result.destinationBytes, signal).toBe(expected);
      expect(result.deadlineRestored, signal).toBe(true);
    }
  }
}, 15_000);

test("post-recovery latch works on stock macOS Bash", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const expected = '{"runId":"run","status":"succeeded","exitCode":0}\n';
  const result = await runAtomicPublicationHarness(
    launcher,
    "forced-timeout-after-rename",
    "SIGTERM",
    "after-recovery",
    0,
    "/bin/bash",
  );

  expect(result.exitCode, result.stderr).toBe(143);
  expect(result.sourceExists).toBe(false);
  expect(result.destinationBytes).toBe(expected);
  expect(result.deadlineRestored).toBe(true);
  expect(result.processGroupAliveAfterCleanup).toBe(false);
  expect(result.rootExistsAfterCleanup).toBe(false);
}, 15_000);

test("private cleanup runs only with fresh positive remainder", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  for (const target of ["file", "directory"] as const) {
    const normal = await runPrivateCleanupHarness(launcher, target, 5_000);
    expect(normal.exitCode, `${target}:normal`).toBe(0);
    expect(normal.pathExists, `${target}:normal`).toBe(false);

    const cutoff = await runPrivateCleanupHarness(launcher, target, 0);
    expect(cutoff.exitCode, `${target}:cutoff`).toBe(0);
    expect(cutoff.pathExists, `${target}:cutoff`).toBe(true);
  }
});

test("capture and latest render blocked redirections return deadline status", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  for (const target of ["capture", "render"] as const) {
    const result = await runBlockedRedirectionHarness(launcher, target);
    expect(result.exitCode, target).toBe(124);
    expect(result.elapsedMs, target).toBeLessThan(2_000);
  }
}, 10_000);

test("preflight invalidates prior success under the active finalizer trap", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const main = extractShellFunction(launcher, "main");
  expect(main).toBeDefined();
  if (main === undefined) return;
  const validation = main.indexOf(
    'run_before_deadline validate_issue_ledger "$ledger"',
  );
  const invalidation = main.indexOf("\n  quarantine_prior_evidence\n");
  const trap = launcher.indexOf("trap finalize EXIT");
  const mainInvocation = launcher.indexOf('main "$@"', trap);
  expect(validation).toBeGreaterThan(-1);
  expect(invalidation).toBeGreaterThan(validation);
  expect(trap).toBeGreaterThan(-1);
  expect(mainInvocation).toBeGreaterThan(trap);

  for (const outcome of ["rename-failure", "signal"] as const) {
    const invalidated = await runPriorEvidenceInvalidationHarness(
      launcher,
      outcome,
    );
    expect(invalidated.exitCode, `${outcome}:${invalidated.stderr}`).toBe(
      outcome === "signal" ? 143 : 1,
    );
    expect(invalidated.preflightExists, outcome).toBe(
      outcome === "rename-failure",
    );
    expect(invalidated.latestExists, `${outcome}:${invalidated.stderr}`).toBe(
      false,
    );
  }

  const failed = await runFinalizerHarness(launcher, 42, {
    mode: "preflight",
    seedPreflight: true,
    failPreflightRetraction: true,
  });
  expect(failed.exitCode).toBe(42);
  expect(failed.preflightExists).toBe(false);
  expect(failed.latest?.exitCode).toBe(42);
  expect(failed.stderr).not.toContain("command not found");
}, 15_000);

test("preflight attestation requires an observed zero worker exit", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const missingProof = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    failCopies: false,
  });
  expect(missingProof.exitCode).toBe(74);
  expect(missingProof.preflightExists).toBe(false);
  expect(missingProof.stderr).toContain(
    "finalize failed: missing successful preflight worker proof",
  );

  const failedWorker = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    failCopies: false,
    workerExitCode: 9,
    workerCompletedAtMs: 50,
  });
  expect(failedWorker.exitCode).toBe(74);
  expect(failedWorker.preflightExists).toBe(false);
}, 15_000);

test("preflight authority requires both schema-valid paired records", () => {
  const preflightCore = {
    runId: "run",
    runtimeHead: "head",
    runtimeSha256: "a".repeat(64),
    baseSha: "b".repeat(40),
    artifactDigest: "c".repeat(64),
    originFetchUrl: "https://github.com/ASRagab/orca-ts.git",
    originPushUrl: "git@github.com:ASRagab/orca-ts.git",
    repository: "ASRagab/orca-ts",
    checkedAt: "2026-07-17T00:00:00Z",
    status: "succeeded",
    exitCode: 0,
    elapsedMs: 50,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    supervisorStatus: "terminal",
    checkedAtMs: 100,
    expiresAtMs: 600_100,
  };
  const preflight = {
    ...preflightCore,
    terminalProof: sha256Text(`${stableJson(preflightCore)}\n`),
  };
  const latest = {
    runId: "run",
    mode: "preflight",
    exitCode: 0,
    runtimeHead: "head",
    runtimeSha256: "a".repeat(64),
    preflightArtifactDigest: "c".repeat(64),
    preflightBaseSha: "b".repeat(40),
    preflightPath: "/state/preflight.json",
  };

  expect(hasAuthoritativePreflightPair(latest, preflight)).toBe(true);
  expect(hasAuthoritativePreflightPair(undefined, preflight)).toBe(false);
  expect(hasAuthoritativePreflightPair(latest, undefined)).toBe(false);
  expect(
    hasAuthoritativePreflightPair(
      { ...latest, runId: "other" },
      preflight,
    ),
  ).toBe(false);
  expect(
    hasAuthoritativePreflightPair(latest, { ...preflight, extra: true }),
  ).toBe(false);
  expect(
    hasAuthoritativePreflightPair(latest, {
      ...preflight,
      terminalProof: "0".repeat(64),
    }),
  ).toBe(false);
});

test("preflight supervisor discards private staging after signal or failure", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  for (const { outcome, status } of [
    { outcome: "signal", status: 143 },
    { outcome: "failure", status: 74 },
  ] as const) {
    const result = await runFinalizerHarness(launcher, 0, {
      mode: "preflight",
      failCopies: false,
      workerExitCode: 0,
      workerCompletedAtMs: 50,
      afterPreflightPublish: outcome,
    });
    expect(result.exitCode, outcome).toBe(status);
    expect(result.preflightExists).toBe(false);
    expect(result.preflight, outcome).toBeUndefined();
    if (outcome === "signal") {
      expect(result.latest, outcome).toBeUndefined();
    } else {
      expect(result.latest, outcome).toEqual({
        runId: "run",
        branch: "branch",
        worktree: expect.any(String),
        profile: "simple",
        mode: "preflight",
        phase: "live",
        launcherLog: expect.any(String),
        monitor: "",
        report: "",
        ledger: expect.any(String),
        prUrl: "",
        runtimePath: "runtime",
        runtimeHead: "head",
        runtimeSha256: "sha",
        runtimeVersion: "version",
        baseSha: "base",
        artifactDigest: "digest",
        preflightPath: expect.any(String),
        preflightArtifactDigest: "digest",
        preflightBaseSha: "base",
        protectedPackageLock: expect.any(String),
        packageLockSha256Before: "",
        packageLockSha256After: "",
        terminalCommitId: expect.stringMatching(/^run\.[0-9]+$/),
        ledgerSha256: "",
        candidateLedgerSha256: "",
        reportSha256: "",
        monitorSha256: "",
        terminalProof: "",
        elapsedMs: 99,
        exitCode: 74,
      });
    }
    expect(
      hasAuthoritativePreflightPair(result.latest, result.preflight),
      outcome,
    ).toBe(false);
  }
}, 15_000);

test("signal after latest publication cannot precede the preflight commit", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    signalAfterLatestPublish: true,
  });
  expect(result.exitCode).toBe(143);
  expect(result.preflightExists).toBe(false);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("SIGKILL after latest publication leaves live success unauthoritative", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    killAfterLatestPublish: true,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.exitCode).toBe(137);
  expect(result.latest?.exitCode).toBe(0);
  expect(result.ledger).toBe(`${seed}\n`);
  expect(result.latest?.ledgerSha256).not.toBe(
    createHash("sha256").update(result.ledger ?? "").digest("hex"),
  );
  expect(
    result.ledger
      ?.trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .some((row) => row.terminalCommit === true),
  ).toBe(false);
  expect(hasAuthoritativeLivePair(result.latest, result.ledger)).toBe(false);
}, 15_000);

test("live signal after latest publication aborts before canonical ledger commit", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    signalAfterLatestPublish: true,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.exitCode).toBe(143);
  expect(result.ledger).toBe(`${seed}\n`);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("pending signal before terminal ledger worker cannot commit canonical success", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    signalBeforeTerminalLedgerMerge: true,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.exitCode).toBe(143);
  expect(result.ledger).toBe(`${seed}\n`);
  expect(result.latest?.exitCode).toBe(0);
  expect(result.latest?.ledgerSha256).not.toBe(
    createHash("sha256").update(result.ledger ?? "").digest("hex"),
  );
  expect(hasAuthoritativeLivePair(result.latest, result.ledger)).toBe(false);
}, 15_000);

test("signal in terminal worker spawn gap cannot commit canonical success", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    signalAtTerminalWorkerSpawnGap: true,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.exitCode).toBe(143);
  expect(result.ledger).toBe(`${seed}\n`);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("terminal commit rejects bound evidence mutation after private staging", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;

  for (const mutation of [
    "report",
    "monitor",
    "latest",
    "latest-ledger-claim",
    "latest-proof-claim",
    "latest-projection-claim",
  ] as const) {
    const result = await runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      terminalEvidenceMutation: mutation,
      ledger: {
        base: `${seed}\n`,
        source: `${seed}\n`,
        candidate: `${seed}\n`,
      },
    });

    expect(result.exitCode, mutation).toBe(74);
    expect(result.ledger, mutation).toBe(`${seed}\n`);
    expect(result.latest?.exitCode, mutation).toBe(74);
    expect(result.terminalStageFiles, mutation).toEqual([]);
    expect(result.terminalStageMetadata, mutation).toEqual([]);
  }
}, 45_000);

test("signals or timeout after terminal staging leave no success stage", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;

  for (const scenario of [
    { boundary: "TERM", exitCode: 143 },
    { boundary: "INT", exitCode: 130 },
    { boundary: "HUP", exitCode: 129 },
    { boundary: "timeout", exitCode: 74 },
  ] as const) {
    const result = await runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      afterTerminalStage: scenario.boundary,
      ledger: {
        base: `${seed}\n`,
        source: `${seed}\n`,
        candidate: `${seed}\n`,
      },
    });

    expect(result.exitCode, scenario.boundary).toBe(scenario.exitCode);
    expect(result.ledger, scenario.boundary).toBe(`${seed}\n`);
    expect(result.runLedger, scenario.boundary).toBe(`${seed}\n`);
    if (scenario.boundary === "timeout") {
      expect(result.terminalStageFiles, scenario.boundary).toHaveLength(1);
      expect(result.terminalStageFiles[0], scenario.boundary).toMatch(
        /^\.issues\.jsonl\.terminal\.[A-Za-z0-9]{6}$/,
      );
      expect(result.terminalStageMetadata, scenario.boundary).toEqual([
        {
          basename: result.terminalStageFiles[0],
          mode: 0o600,
          isRegularFile: true,
          isSymbolicLink: false,
        },
      ]);
    } else {
      expect(result.terminalStageFiles, scenario.boundary).toEqual([]);
      expect(result.terminalStageMetadata, scenario.boundary).toEqual([]);
    }
    expect(
      result.runLedger
        ?.trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .some((row) => row.terminalCommit === true),
      scenario.boundary,
    ).toBe(false);
  }
}, 15_000);

test("finalizer signal cleanup removes terminal stage before invalidation", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const finalizer = extractShellFunction(launcher, "finalize");
  expect(finalizer).toBeDefined();
  if (finalizer === undefined) return;
  const handler = finalizer.match(
    /  handle_finalize_signal\(\) \{[\s\S]*?\n  \}/,
  )?.[0];
  expect(handler).toBeDefined();
  if (handler === undefined) return;
  const stageCleanup = handler.indexOf("discard_terminal_ledger_stage || true");
  const invalidation = handler.indexOf("quarantine_prior_evidence");
  expect(stageCleanup).toBeGreaterThan(-1);
  expect(invalidation).toBeGreaterThan(stageCleanup);
});

test("deadline expiry at the preflight commit leaves latest unauthoritative", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    expireAtPreflightCommit: true,
  });
  expect(result.exitCode).toBe(74);
  expect(result.preflightExists).toBe(false);
  expect(result.preflight).toBeUndefined();
  expect(result.latest).toMatchObject({
    runId: "run",
    mode: "preflight",
    exitCode: 0,
  });
  expect(hasAuthoritativePreflightPair(result.latest, result.preflight)).toBe(
    false,
  );
}, 15_000);

test("signal before first publication cannot commit preflight success", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    signalBeforeLatestPublication: true,
  });
  expect(result.exitCode).toBe(143);
  expect(result.preflightExists).toBe(false);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("signal delivered inside the preflight rename cannot claim commit", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    signalAtPreflightRename: true,
  });
  expect(result.exitCode).toBe(143);
  expect(result.preflightExists).toBe(false);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("signal after preflight publication retracts success with occupied prior quarantines", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    seedPriorEvidence: true,
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    signalAtPreflightRename: true,
  });
  expect(result.exitCode).toBe(143);
  expect(result.preflightExists).toBe(false);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("TERM retracts success when every quarantine path is occupied", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    seedPriorEvidence: true,
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    signalAtPreflightRename: true,
    preflightRenameSignal: "TERM",
    occupyPrivateFallbacksAtPreflightRename: "file",
  });
  expect(result.exitCode).toBe(143);
  expect(result.preflightExists).toBe(false);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("INT retracts success when every quarantine path is occupied", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    seedPriorEvidence: true,
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    signalAtPreflightRename: true,
    preflightRenameSignal: "INT",
    occupyPrivateFallbacksAtPreflightRename: "file",
  });
  expect(result.exitCode).toBe(130);
  expect(result.preflightExists).toBe(false);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("HUP retracts success when every quarantine path is occupied", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    seedPriorEvidence: true,
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    signalAtPreflightRename: true,
    preflightRenameSignal: "HUP",
    occupyPrivateFallbacksAtPreflightRename: "file",
  });
  expect(result.exitCode).toBe(129);
  expect(result.preflightExists).toBe(false);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("signal reallocates quarantine around occupied private directories", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    seedPriorEvidence: true,
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    signalAtPreflightRename: true,
    occupyPrivateFallbacksAtPreflightRename: "directory",
  });
  expect(result.exitCode).toBe(143);
  expect(result.preflightExists).toBe(false);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("actual finalizer signal fallback cannot hang in mktemp", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    seedPriorEvidence: true,
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    signalAtPreflightRename: true,
    occupyPrivateFallbacksAtPreflightRename: "directory",
    hangSignalFallbackMktemp: true,
    timeoutMs: 2_750,
  });
  expect({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  }).toEqual({
    exitCode: 143,
    timedOut: false,
  });
}, 15_000);

test("actual finalizer directory setup cannot hang in dirname", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 42, {
    failCopies: false,
    hangFinalizationDirname: true,
    timeoutMs: 2_750,
  });
  expect({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  }).toEqual({
    exitCode: 42,
    timedOut: false,
  });
}, 15_000);

test("failed latest retraction leaves retained success unauthoritative", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    expireAtPreflightCommit: true,
    failLatestRetraction: true,
  });
  expect(result.exitCode).toBe(74);
  expect(result.preflightExists).toBe(false);
  expect(result.preflight).toBeUndefined();
  expect(result.latest).toMatchObject({
    runId: "run",
    mode: "preflight",
    exitCode: 0,
  });
  expect(hasAuthoritativePreflightPair(result.latest, result.preflight)).toBe(
    false,
  );
}, 15_000);

test("live launch atomically claims one preflight and rejects concurrent replay", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const claim = extractShellFunction(
    launcher,
    "claim_preflight_attestation",
  );
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  expect(claim).toBeDefined();
  if (remaining === undefined || bounded === undefined || claim === undefined) {
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-preflight-claim-"));
  const stable = join(root, "preflight.json");
  await Bun.write(stable, '{"status":"succeeded","exitCode":0}\n');
  const scripts = ["first", "second"].map((name) => {
    const script = join(root, `${name}.sh`);
    const claimed = join(root, "claims", `${name}.json`);
    return { script, claimed };
  });
  for (const { script, claimed } of scripts) {
    await Bun.write(
      script,
      [
        "#!/usr/bin/env bash",
        "set -u",
        "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
        remaining,
        bounded,
        claim,
        "launcher_signal_status=0",
        ...launcherDeadlineLines(5000),
        'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
        `preflight_path=${JSON.stringify(stable)}`,
        `claim_preflight_attestation ${JSON.stringify(stable)} ${JSON.stringify(claimed)}`,
      ].join("\n"),
    );
  }

  try {
    const processes = scripts.map(({ script }) =>
      Bun.spawn(["bash", script], { stdout: "pipe", stderr: "pipe" }),
    );
    const statuses = await Promise.all(processes.map((process) => process.exited));
    expect([...statuses].sort((left, right) => left - right)).toEqual([0, 66]);
    expect(await Bun.file(stable).exists()).toBe(false);
    const claimedCount = (
      await Promise.all(
        scripts.map(({ claimed }) => Bun.file(claimed).exists()),
      )
    ).filter(Boolean).length;
    expect(claimedCount).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live accepts only fresh preflight with matching latest evidence", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const functions = [
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "run_before_deadline"),
    extractShellFunction(launcher, "capture_command_output"),
    extractShellFunction(launcher, "capture_before_deadline"),
    extractShellFunction(launcher, "compute_preflight_terminal_proof"),
    extractShellFunction(launcher, "publish_preflight_attestation"),
    extractShellFunction(launcher, "validate_claimed_preflight_attestation"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-preflight-terminal-"));
  const cases = [
    { name: "valid", nowMs: 101, mutation: ":", status: 0 },
    { name: "stale", nowMs: 600_101, mutation: ":", status: 66 },
    {
      name: "nonterminal",
      nowMs: 101,
      mutation:
        'jq \'.supervisorStatus="running"\' "$preflight_path" > "${preflight_path}.mutated" && mv "${preflight_path}.mutated" "$preflight_path"',
      status: 66,
    },
    {
      name: "identity-mismatch",
      nowMs: 101,
      mutation: 'origin_push_url="git@github.com:other/repository.git"',
      status: 66,
    },
    {
      name: "superseded",
      nowMs: 101,
      mutation:
        'jq \'.exitCode=74\' "$latest_quarantine" > "${latest_quarantine}.mutated" && mv "${latest_quarantine}.mutated" "$latest_quarantine"',
      status: 66,
    },
  ] as const;

  try {
    for (const scenario of cases) {
      const preflightPath = join(root, `${scenario.name}.json`);
      const latestQuarantine = join(root, `${scenario.name}.latest.json`);
      const script = join(root, `${scenario.name}.sh`);
      await Bun.write(
        script,
        [
          "#!/usr/bin/env bash",
          "set -u",
          'now_ms() { printf \'%s\\n\' "$NOW_MS"; }',
          ...functions,
          "launcher_signal_status=0",
          ...launcherDeadlineLines(1000000),
          "launcher_deadline_at_ms=1000000",
          "preflight_validity_ms=600000",
          'run_id="preflight-run"',
          'runtime_head="head"',
          'runtime_sha256="runtime-sha"',
          'base_sha="base"',
          'artifact_digest="digest"',
          'origin_fetch_url="https://github.com/ASRagab/orca-ts.git"',
          'origin_push_url="git@github.com:ASRagab/orca-ts.git"',
          'repository="ASRagab/orca-ts"',
          'elapsed_ms="99"',
          'preflight_worker_exit_code="0"',
          'preflight_worker_completed_at_ms="50"',
          `preflight_path=${JSON.stringify(preflightPath)}`,
          `latest_quarantine=${JSON.stringify(latestQuarantine)}`,
          "NOW_MS=100",
          "publish_preflight_attestation",
          'jq \'{runId,runtimeHead,runtimeSha256,baseSha,artifactDigest,exitCode,mode:"preflight",preflightArtifactDigest:.artifactDigest,preflightBaseSha:.baseSha}\' "$preflight_path" > "$latest_quarantine"',
          scenario.mutation,
          'run_id="live-run"',
          `NOW_MS=${String(scenario.nowMs)}`,
          'validate_claimed_preflight_attestation "$preflight_path"',
        ].join("\n"),
      );
      const process = Bun.spawn(["bash", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await process.exited).toBe(scenario.status);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("launcher captures and exports one immutable GitHub delivery identity", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const functions = [
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "run_before_deadline"),
    extractShellFunction(launcher, "capture_command_output"),
    extractShellFunction(launcher, "capture_before_deadline"),
    extractShellFunction(launcher, "github_repository_from_url"),
    extractShellFunction(launcher, "lowercase_github_repository"),
    extractShellFunction(launcher, "capture_delivery_identity"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-delivery-identity-"));
  const cases = [
    {
      name: "valid",
      fetchUrl: "https://github.com/ASRagab/orca-ts.git",
      pushUrl: "git@github.com:ASRagab/orca-ts.git",
      status: 0,
      output:
        "https://github.com/ASRagab/orca-ts.git\n" +
        "git@github.com:ASRagab/orca-ts.git\n" +
        "ASRagab/orca-ts\n",
    },
    {
      name: "unsupported",
      fetchUrl: "file:///tmp/orca-ts",
      pushUrl: "git@github.com:ASRagab/orca-ts.git",
      status: 66,
      output: "",
    },
    {
      name: "mismatch",
      fetchUrl: "https://github.com/ASRagab/orca-ts.git",
      pushUrl: "git@github.com:other/orca-ts.git",
      status: 66,
      output: "",
    },
  ] as const;

  try {
    for (const scenario of cases) {
      const script = join(root, `${scenario.name}.sh`);
      await Bun.write(
        script,
        [
          "#!/usr/bin/env bash",
          "set -u",
          "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
          ...functions,
          "launcher_signal_status=0",
          ...launcherDeadlineLines(5000),
          'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
          'source_root="/source"',
          `FETCH_URL=${JSON.stringify(scenario.fetchUrl)}`,
          `PUSH_URL=${JSON.stringify(scenario.pushUrl)}`,
          "git() {",
          '  if [[ "$*" == *"remote get-url --push origin"* ]]; then',
          '    printf \'%s\\n\' "$PUSH_URL"',
          "  else",
          '    printf \'%s\\n\' "$FETCH_URL"',
          "  fi",
          "}",
          'origin_fetch_url=""',
          'origin_push_url=""',
          'repository=""',
          "capture_delivery_identity || exit $?",
          'printf \'%s\\n%s\\n%s\\n\' "$origin_fetch_url" "$origin_push_url" "$repository"',
        ].join("\n"),
      );
      const process = Bun.spawn(["bash", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stdout] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ]);
      expect(status).toBe(scenario.status);
      expect(stdout).toBe(scenario.output);
    }

    for (const required of [
      "originFetchUrl",
      "originPushUrl",
      "repository",
      'ORCA_IMPROVEMENT_ORIGIN_FETCH_URL="$origin_fetch_url"',
      'ORCA_IMPROVEMENT_ORIGIN_PUSH_URL="$origin_push_url"',
      'ORCA_IMPROVEMENT_REPOSITORY="$repository"',
    ]) {
      expect(launcher).toContain(required);
    }
    const main = extractShellFunction(launcher, "main");
    expect(main).toBeDefined();
    if (main === undefined) return;
    const capture = main.indexOf("\n  capture_delivery_identity\n");
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(
      main.indexOf('git -C "$source_root" worktree add'),
    );
    expect(capture).toBeLessThan(
      main.indexOf("run_before_deadline run_live_workflow"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery identity lowercasing stays inside the launcher deadline", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const requiredFunctions = [
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "run_before_deadline"),
    extractShellFunction(launcher, "capture_command_output"),
    extractShellFunction(launcher, "capture_before_deadline"),
    extractShellFunction(launcher, "github_repository_from_url"),
    extractShellFunction(launcher, "capture_delivery_identity"),
  ];
  expect(requiredFunctions.every((value) => value !== undefined)).toBe(true);
  if (requiredFunctions.some((value) => value === undefined)) return;
  const lowercase = extractShellFunction(
    launcher,
    "lowercase_github_repository",
  );

  const root = await mkdtemp(join(tmpdir(), "orcats-delivery-deadline-"));
  const bin = join(root, "bin");
  const script = join(root, "harness.sh");
  const trPath = join(bin, "tr");
  const enteredMarker = join(root, "tr-entered");
  await mkdir(bin);
  await Bun.write(
    trPath,
    [
      "#!/bin/bash",
      "printf entered > \"$TR_ENTERED_MARKER\"",
      "trap '' TERM",
      "while :; do :; done",
    ].join("\n"),
  );
  await chmod(trPath, 0o755);
  await Bun.write(
    script,
    [
      "#!/bin/bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      ...requiredFunctions,
      ...(lowercase === undefined ? [] : [lowercase]),
      "launcher_signal_status=0",
      "terminal_commit_signal_status=0",
      ...launcherDeadlineLines(5_000),
      'launcher_deadline_at_ms=$(( $(now_ms) + launcher_deadline_ms ))',
      'source_root="/source"',
      'FETCH_URL="https://github.com/ASRagab/orca-ts.git"',
      'PUSH_URL="git@github.com:ASRagab/orca-ts.git"',
      "git() {",
      '  if [[ "$*" == *"remote get-url --push origin"* ]]; then',
      '    printf \'%s\\n\' "$PUSH_URL"',
      "  else",
      '    printf \'%s\\n\' "$FETCH_URL"',
      "  fi",
      "}",
      'origin_fetch_url=""',
      'origin_push_url=""',
      'repository=""',
      "set +e",
      "capture_delivery_identity",
      'status="$?"',
      "set -e",
      'exit "$status"',
    ].join("\n"),
  );

  const startedAt = Date.now();
  const harness = Bun.spawn(["/bin/bash", script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMPDIR: root,
      TR_ENTERED_MARKER: enteredMarker,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const trackedPids = new Set<number>();
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  const safety = new Promise<number>((resolveSafety) => {
    safetyTimer = setTimeout(() => {
      void (async () => {
        await terminateOwnedHarness(harness.pid, script, trackedPids);
        resolveSafety(255);
      })();
    }, 6_000);
  });

  try {
    const exitCode = await Promise.race([harness.exited, safety]);
    expect(await Bun.file(enteredMarker).exists()).toBe(true);
    expect(exitCode).toBe(124);
    expect(Date.now() - startedAt).toBeLessThan(6_000);
  } finally {
    if (safetyTimer !== undefined) clearTimeout(safetyTimer);
    const processResidue = await terminateOwnedHarness(
      harness.pid,
      script,
      trackedPids,
    );
    const controllerResidue = (await readdir(root))
      .filter((name) => /^orcats-(command|controller)-/.test(name))
      .sort();
    try {
      expect(processResidue).toEqual([]);
      expect(controllerResidue).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 30_000);

test("launcher proves primary package-lock bytes and final simple SLA", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  for (const required of [
    "protected_package_lock",
    "package_lock_sha256_before",
    "package_lock_sha256_after",
    "assert_package_lock_unchanged",
    "packageLockSha256Before",
    "packageLockSha256After",
    "launcher_deadline_ms=600000",
    'elapsed_ms" -gt "$launcher_deadline_ms"',
  ]) {
    expect(launcher).toContain(required);
  }
  expect(launcher.indexOf("assert_package_lock_unchanged")).toBeLessThan(
    launcher.indexOf('exit "$final_status"'),
  );
});

test("finalization enforces the package-lock existence and SHA contract", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const commonDirResult = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"]);
  expect(commonDirResult.exitCode).toBe(0);
  const commonDir = new TextDecoder().decode(commonDirResult.stdout).trim();
  const primaryPackageLock = resolve(commonDir, "..", "package-lock.json");
  const primaryExistedBefore = await Bun.file(primaryPackageLock).exists();
  const primaryBytesBefore = primaryExistedBefore
    ? new Uint8Array(await Bun.file(primaryPackageLock).arrayBuffer())
    : undefined;
  try {
    for (const scenario of [
    {
      name: "existing unchanged",
      initial: "initial-lock",
      mutation: "unchanged",
      exitCode: 0,
      error: undefined,
      final: "initial-lock",
    },
    {
      name: "existing modified",
      initial: "initial-lock",
      mutation: "modified",
      exitCode: 74,
      error: "protected package-lock changed",
      final: "modified-lock",
    },
    {
      name: "existing deleted",
      initial: "initial-lock",
      mutation: "deleted",
      exitCode: 74,
      error: "protected package-lock disappeared",
      final: undefined,
    },
    {
      name: "initially absent then created",
      initial: undefined,
      mutation: "created",
      exitCode: 74,
      error: "protected package-lock appeared",
      final: "created-lock",
    },
    {
      name: "existing deleted then recreated with different bytes",
      initial: "initial-lock",
      mutation: "recreated-different",
      exitCode: 74,
      error: "protected package-lock changed",
      final: "recreated-lock",
    },
    {
      name: "existing deleted then recreated with identical bytes",
      initial: "initial-lock",
      mutation: "recreated-identical",
      exitCode: 0,
      error: undefined,
      final: "initial-lock",
    },
    ] as const) {
      const result = await runFinalizerHarness(launcher, 0, {
        mode: "harness",
        failCopies: false,
        packageLock: {
          initial: scenario.initial,
          mutation: scenario.mutation,
        },
      });
      expect(result.exitCode, scenario.name).toBe(scenario.exitCode);
      expect(result.latest?.exitCode, scenario.name).toBe(scenario.exitCode);
      if (scenario.error === undefined) {
        expect(result.stderr, scenario.name).not.toContain(
          "protected package-lock",
        );
      } else {
        expect(result.stderr, scenario.name).toContain(scenario.error);
        expect(result.stderr, scenario.name).toContain(
          "finalize failed: preserve primary package-lock",
        );
      }
      expect(result.packageLockExists, scenario.name).toBe(
        scenario.final !== undefined,
      );
      expect(result.packageLockBytes, scenario.name).toEqual(
        scenario.final === undefined
          ? undefined
          : new TextEncoder().encode(scenario.final),
      );
    }
  } finally {
    expect(await Bun.file(primaryPackageLock).exists()).toBe(
      primaryExistedBefore,
    );
    if (primaryBytesBefore !== undefined) {
      expect(
        new Uint8Array(await Bun.file(primaryPackageLock).arrayBuffer()),
      ).toEqual(primaryBytesBefore);
    }
  }
}, 15_000);

test("terminal package-lock drift blocks success publication", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  expect(terminalPackageLockContractIssues(launcher)).toEqual([]);

  const terminalCall = launcher.lastIndexOf("assert_package_lock_unchanged");
  expect(terminalCall).toBeGreaterThan(-1);
  const removedTerminalCheck =
    launcher.slice(0, terminalCall) +
    "true" +
    launcher.slice(terminalCall + "assert_package_lock_unchanged".length);
  expect(terminalPackageLockContractIssues(removedTerminalCheck)).not.toEqual(
    [],
  );
  const preflightStage = removedTerminalCheck.indexOf(
    'run_before_deadline publish_preflight_attestation "$preflight_stage"',
  );
  expect(preflightStage).toBeGreaterThan(-1);
  const reorderedTerminalCheck =
    removedTerminalCheck.slice(0, preflightStage) +
    "if ! assert_package_lock_unchanged; then :; fi\n    " +
    removedTerminalCheck.slice(preflightStage);
  expect(terminalPackageLockContractIssues(reorderedTerminalCheck)).not.toEqual(
    [],
  );

  for (const scenario of [
    {
      mutation: "changed",
      initial: "initial-lock",
      diagnostic: "protected package-lock changed",
    },
    {
      mutation: "disappeared",
      initial: "initial-lock",
      diagnostic: "protected package-lock disappeared",
    },
    {
      mutation: "appeared",
      initial: undefined,
      diagnostic: "protected package-lock appeared",
    },
  ] as const) {
    const result = await runFinalizerHarness(launcher, 0, {
      mode: "preflight",
      failCopies: false,
      workerExitCode: 0,
      workerCompletedAtMs: 50,
      packageLock: {
        initial: scenario.initial,
        mutation: "unchanged",
      },
      terminalPackageLockRaceClaim: scenario.mutation,
    });
    expect(result.exitCode, scenario.mutation).toBe(74);
    expect(result.stderr, scenario.mutation).toContain(scenario.diagnostic);
    expect(result.stderr, scenario.mutation).toContain(
      "finalize failed: preserve primary package-lock at terminal commit",
    );
    expect(result.preflightExists, scenario.mutation).toBe(false);
    expect(result.claimedPreflightExists, scenario.mutation).toBe(false);
    expect(result.latest?.exitCode, scenario.mutation).toBe(74);
    expect(result.latest?.exitCode, scenario.mutation).not.toBe(0);
    if (scenario.mutation === "disappeared") {
      expect(result.latest?.packageLockSha256After).toBe("");
    }
  }
}, 15_000);

test("terminal package-lock drift is unclaimable even if retraction fails", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    packageLock: {
      initial: "initial-lock",
      mutation: "unchanged",
    },
    terminalPackageLockRaceClaim: "changed",
    failPreflightRetraction: true,
  });
  expect(result.exitCode).toBe(74);
  expect(result.preflightExists).toBe(false);
  expect(result.claimedPreflightExists).toBe(false);
  expect(result.latest?.exitCode).toBe(74);
}, 15_000);

test("launcher merges isolated ledgers under an atomic lock", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const main = extractShellFunction(launcher, "main");
  expect(main).toBeDefined();
  if (main === undefined) return;
  for (const required of [
    "merge_issue_ledger",
    "ledger_lock",
    "ledger_base_snapshot",
    'mkdir "$ledger_lock"',
    'mv "$ledger_merge_tmp" "$ledger"',
    'validate_issue_ledger "$ledger_merge_tmp"',
    'run_before_deadline cp "$ledger" "$ledger_base_snapshot"',
    '"$candidate_ledger" "$ledger_base_snapshot"',
  ]) {
    expect(launcher).toContain(required);
  }
  expect(launcher).not.toContain(
    'cp "$worktree/.orca/improvement-loop/issues.jsonl" "$ledger"',
  );
  const validation = main.indexOf(
    'run_before_deadline validate_issue_ledger "$ledger"',
  );
  const snapshot = main.indexOf(
    'run_before_deadline cp "$ledger" "$ledger_base_snapshot"',
  );
  const digest = main.indexOf(
    'capture_before_deadline artifact_digest compute_artifact_digest "$source_root"',
  );
  expect(validation).toBeGreaterThan(-1);
  expect(snapshot).toBeGreaterThan(validation);
  expect(digest).toBeGreaterThan(snapshot);
});

test("ledger lock ownership uses exact verified markers without path replacement", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  expect(ledgerLockContractIssues(launcher)).toEqual([]);

  for (const mutation of [
    launcher.replace(
      'rmdir "$ledger_lock" 2>/dev/null || true',
      'mv "$ledger_lock" "${ledger_lock}.stale" 2>/dev/null || true',
    ),
    launcher.replace(
      'rmdir "$ledger_lock" 2>/dev/null || true',
      'rm -rf "$ledger_lock"',
    ),
    launcher.replace(
      'rm -- "$ledger_lock_owner_marker"',
      'rm -f "$ledger_lock"/*',
    ),
    launcher.replace(
      "if ! verify_owned_ledger_lock; then",
      "if false; then",
    ),
  ]) {
    expect(mutation).not.toBe(launcher);
    expect(ledgerLockContractIssues(mutation)).not.toEqual([]);
  }
});

test("terminal ledger merge rejects a concurrent source append", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const functions = [
    extractIssueLedgerValidator(launcher),
    extractShellFunction(launcher, "issue_ledger_has_no_latest_open"),
    extractShellFunction(launcher, "issue_ledger_has_terminal_commit"),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "run_before_deadline"),
    extractShellFunction(launcher, "merge_issue_ledger"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-ledger-merge-"));
  const sourceLedger = join(root, "issues.jsonl");
  const candidateLedger = join(root, "candidate.jsonl");
  const baseLedger = join(root, "base.jsonl");
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const row = (id: string, evidence: string): string =>
    JSON.stringify({
      id,
      runId: "atomic-merge-test",
      at: "2026-07-14T16:00:00.000Z",
      classification: "gate",
      stage: "test",
      elapsedMs: 0,
      evidence,
      status: "open",
    });
  const sourceOnly = row("concurrent-source", "source append");
  const candidateOnly = row("isolated-candidate", "candidate append");
  await Bun.write(baseLedger, `${seed}\n`);
  await Bun.write(sourceLedger, `${seed}\n`);
  await Bun.write(candidateLedger, `${seed}\n${candidateOnly}\n`);
  const ledgerLock = `${sourceLedger}.lock`;
  await mkdir(ledgerLock);
  const owner = Bun.spawn(["sleep", "30"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const ownerMarker = join(ledgerLock, `owner.${owner.pid}.1`);
  await Bun.write(ownerMarker, "");
  const script = join(root, "merge.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { echo 1; }",
      ...functions,
      `ledger=${JSON.stringify(sourceLedger)}`,
      'ledger_lock="${ledger}.lock"',
      ...launcherDeadlineLines(100000),
      "launcher_deadline_at_ms=100000",
      'run_id="terminal-merge-test"',
      'pr_url="https://github.com/ASRagab/orca-ts/pull/1"',
      'monitor_path="monitor.json"',
      'branch="orca/test"',
      'worktree="/tmp/worktree"',
      `merge_issue_ledger ${JSON.stringify(candidateLedger)} ${JSON.stringify(baseLedger)} terminal`,
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(100);
    await Bun.write(sourceLedger, `${seed}\n${sourceOnly}\n`);
    await rm(ownerMarker);
    await rmdir(ledgerLock);
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(stderr).toContain("concurrent source issue ledger append");
    expect(exitCode).toBe(65);
    expect(await Bun.file(sourceLedger).text()).toBe(
      `${seed}\n${sourceOnly}\n`,
    );
    expect(await Bun.file(`${sourceLedger}.lock`).exists()).toBe(false);
  } finally {
    owner.kill();
    await owner.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal ledger merge resolves every open ID only at final commit", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const secondOpen = JSON.stringify({
    ...JSON.parse(seed),
    id: "second-open-issue",
    runId: "second-open-run",
    at: "2026-07-15T00:00:00.000Z",
    evidence: "Second open issue must close at terminal commit",
  });
  const result = await runLedgerMergeHarness(
    launcher,
    {
      base: `${seed}\n${secondOpen}\n`,
      source: `${seed}\n${secondOpen}\n`,
      candidate: `${seed}\n${secondOpen}\n`,
    },
    { mergeMode: "terminal" },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const rows = result.source.trim().split("\n").map((line) => JSON.parse(line));
  expect(rows).toHaveLength(5);
  expect(rows[0]).toEqual(JSON.parse(seed));
  expect(rows[1]).toEqual(JSON.parse(secondOpen));
  const latestById = new Map<string, Record<string, unknown>>();
  for (const row of rows) latestById.set(String(row.id), row);
  for (const id of ["feature-implementation-timeout", "second-open-issue"]) {
    expect(latestById.get(id)).toMatchObject({
      id,
      status: "resolved",
      provingRunId: "terminal-merge-test",
      prUrl: "https://github.com/ASRagab/orca-ts/pull/1",
      backend: "codex",
      worktree: "/tmp/worktree",
      branch: "orca/test",
      monitorPath: "monitor.json",
    });
  }
  expect(rows[4]).toMatchObject({
    id: "terminal-commit-terminal-merge-test",
    terminalCommit: true,
    terminalCommitId: "terminal-merge-test",
  });
});

test("terminal ledger merge supersedes candidate-authored base resolution", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const provisionalResolution = JSON.stringify({
    ...JSON.parse(seed),
    at: "2026-07-15T21:00:00.000Z",
    evidence: "Candidate tried to resolve the historical issue",
    status: "resolved",
    provingRunId: "candidate-authored-resolution",
    prUrl: "https://github.com/ASRagab/orca-ts/pull/1",
  });
  const result = await runLedgerMergeHarness(
    launcher,
    {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n${provisionalResolution}\n`,
    },
    { mergeMode: "terminal" },
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const rows = result.source.trim().split("\n").map((line) => JSON.parse(line));
  expect(rows).toHaveLength(3);
  expect(rows[1]).toMatchObject({
    id: "feature-implementation-timeout",
    status: "resolved",
    provingRunId: "terminal-merge-test",
    evidence:
      "Resolved by committed pull request https://github.com/ASRagab/orca-ts/pull/1",
  });
  expect(rows.some((row) =>
    row.evidence === "Candidate tried to resolve the historical issue"
  )).toBe(false);
});

test("workflow never resolves issues before launcher terminal commit", async () => {
  const workflow = await Bun.file(
    ".orca/workflows/codebase-improvement.ts",
  ).text();
  expect(workflow).not.toContain("resolveAllOpenIssuesForProvingRun");
});

test("launcher failure cannot commit candidate issue resolutions", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const original = JSON.parse(seed) as Record<string, unknown>;
  const resolved = JSON.stringify({
    ...original,
    at: "2026-07-15T00:00:00.000Z",
    evidence: "Resolved by a candidate proof that later failed",
    status: "resolved",
    provingRunId: "failed-candidate",
    prUrl: "https://github.com/ASRagab/orca-ts/pull/1",
    backend: "codex",
    worktree: "/tmp/candidate",
    branch: "orca/candidate",
    monitorPath: ".orca/monitoring/candidate.json",
  });
  const failure = JSON.stringify({
    id: "failed-candidate-finalization",
    runId: "failed-candidate",
    at: "2026-07-15T00:00:01.000Z",
    classification: "environment",
    stage: "finalize",
    elapsedMs: 1,
    evidence: "Candidate finalization failed",
    status: "open",
  });
  const transientOpen = JSON.stringify({
    id: "candidate-transient",
    runId: "failed-candidate",
    at: "2026-07-15T00:00:00.000Z",
    classification: "gate",
    stage: "verify",
    elapsedMs: 0,
    evidence: "Candidate-local failure opened",
    status: "open",
  });
  const transientResolved = JSON.stringify({
    id: "candidate-transient",
    runId: "failed-candidate",
    at: "2026-07-15T00:00:00.500Z",
    classification: "gate",
    stage: "verify",
    elapsedMs: 1,
    evidence: "Candidate-local failure resolved before finalization",
    status: "resolved",
  });
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n${resolved}\n${transientOpen}\n${transientResolved}\n${failure}\n`,
    },
  });

  expect(result.stderr).not.toContain("command not found");
  expect(result.exitCode).not.toBe(0);
  expect(result.ledger).toBe(`${seed}\n${failure}\n`);
  const rows = result.ledger?.trim().split("\n").map((line) => JSON.parse(line)) ?? [];
  const latestById = new Map<string, Record<string, unknown>>();
  for (const row of rows) latestById.set(String(row.id), row);
  expect(latestById.get(String(original.id))).toMatchObject({ status: "open" });
  expect(latestById.get("failed-candidate-finalization")).toMatchObject({
    status: "open",
    evidence: "Candidate finalization failed",
  });
  expect(rows.some((row) => row.status === "resolved")).toBe(false);
  expect(latestById.has("candidate-transient")).toBe(false);
}, 15_000);

test("successful terminal publication rejects ambiguous monitor evidence", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    monitorFiles: [
      {
        name: "current-run.json",
        contents: terminalMonitorFixture("current-run"),
      },
      {
        name: "stale-run.json",
        contents: terminalMonitorFixture("stale-run"),
      },
    ],
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.exitCode).toBe(74);
  expect(result.stderr).toContain("locate terminal monitor evidence");
  expect(result.latest?.exitCode).toBe(74);
  expect(result.ledger).toBe(`${seed}\n`);
}, 15_000);

test("successful terminal publication validates monitor identity and outcome", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  for (const monitor of [
    {
      name: "mismatched-run.json",
      contents: terminalMonitorFixture("different-run"),
    },
    {
      name: "failed-run.json",
      contents: terminalMonitorFixture("failed-run")
        .replace('"outcomes":[', '"outcomes":[')
        .replace('"failures":[]', '"failures":[{"category":"gate"}]')
        .replace('"pass":1,"fail":0', '"pass":1,"fail":1'),
    },
  ] as const) {
    const result = await runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      monitorFiles: [monitor],
      ledger: {
        base: `${seed}\n`,
        source: `${seed}\n`,
        candidate: `${seed}\n`,
      },
    });

    expect(result.exitCode, monitor.name).toBe(74);
    expect(result.stderr, monitor.name).toContain(
      "locate terminal monitor evidence",
    );
    expect(result.ledger, monitor.name).toBe(`${seed}\n`);
  }
}, 15_000);

test("terminal report accepts failed merge response only with exact MERGED confirmation", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const ledger = {
    base: `${seed}\n`,
    source: `${seed}\n`,
    candidate: `${seed}\n`,
  };
  const failedMergeReport = (
    report: Record<string, unknown>,
    proofOverrides: Record<string, unknown> = {},
    extraFailedValidationCommands: readonly string[] = [],
  ): string => {
    const mergeCommand = `gh pr merge ${String(report.prUrl)} --squash --match-head-commit ${String(report.matchedHeadSha)}`;
    const validation = report.validation as Array<Record<string, unknown>>;
    const mergeProof = report.mergeProof as Record<string, unknown>;
    return terminalReportContents(report, {
      validation: validation.map((entry) =>
        entry.command === mergeCommand ||
        extraFailedValidationCommands.includes(String(entry.command))
          ? {
              ...entry,
              status: "failed",
              stderr: "response lost",
              exitCode: null,
            }
          : entry,
      ),
      mergeProof: { ...mergeProof, ...proofOverrides },
    });
  };

  const [
    accepted,
    wrongUrl,
    wrongHeadSha,
    wrongBase,
    draft,
    wrongCommand,
    openState,
    failedValidationConfirmation,
    failedProofConfirmation,
  ] = await Promise.all([
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      reportContents: (report) => failedMergeReport(report),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      reportContents: (report) =>
        failedMergeReport(report, {
          url: "https://github.com/ASRagab/orca-ts/pull/99",
        }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      reportContents: (report) =>
        failedMergeReport(report, { headRefOid: "b".repeat(40) }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      reportContents: (report) =>
        failedMergeReport(report, { baseRefName: "release" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      reportContents: (report) => failedMergeReport(report, { isDraft: true }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      reportContents: (report) => {
        const mergeProof = report.mergeProof as Record<string, unknown>;
        const confirmation = mergeProof.command as Record<string, unknown>;
        return failedMergeReport(report, {
          command: {
            ...confirmation,
            command: "gh pr view arbitrary --json state",
          },
        });
      },
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      reportContents: (report) =>
        failedMergeReport(report, { state: "OPEN" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      reportContents: (report) => {
        const mergeProof = report.mergeProof as Record<string, unknown>;
        const confirmation = mergeProof.command as Record<string, unknown>;
        return failedMergeReport(report, {}, [String(confirmation.command)]);
      },
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      reportContents: (report) => {
        const mergeProof = report.mergeProof as Record<string, unknown>;
        const confirmation = mergeProof.command as Record<string, unknown>;
        return failedMergeReport(report, {
          command: {
            ...confirmation,
            status: "failed",
            stderr: "confirmation transport failed",
            exitCode: 1,
          },
        });
      },
    }),
  ]);

  expect(accepted.stderr).not.toContain("finalize failed");
  expect(accepted.exitCode).toBe(0);
  expect(accepted.latest?.exitCode).toBe(0);
  for (const [scenario, result] of [
    ["wrong URL", wrongUrl],
    ["wrong head SHA", wrongHeadSha],
    ["wrong base", wrongBase],
    ["draft", draft],
    ["wrong command", wrongCommand],
    ["OPEN state", openState],
    ["failed validation confirmation", failedValidationConfirmation],
    ["failed proof confirmation", failedProofConfirmation],
  ] as const) {
    expect(result.exitCode, scenario).toBe(74);
    expect(result.latest?.exitCode, scenario).toBe(74);
    expect(result.ledger, scenario).toBe(`${seed}\n`);
    expect(result.stderr, scenario).toContain("validate terminal report");
  }
}, 15_000);

test("successful terminal publication rejects an unbound workflow report", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const rejectedCandidate = JSON.stringify({
    id: "rejected-terminal-report-candidate",
    runId: "run",
    at: "2026-07-17T00:00:00.000Z",
    classification: "merge",
    stage: "merge",
    elapsedMs: 1,
    evidence: "Rejected terminal report candidate must not enter the ledger",
    backend: "codex",
    worktree: "/tmp/candidate",
    branch: "branch",
    monitorPath: ".orca/monitoring/monitor-run.json",
    status: "open",
  });
  const ledger = {
    base: `${seed}\n`,
    source: `${seed}\n`,
    candidate: `${seed}\n${rejectedCandidate}\n`,
  };
  const [
    mergedFalse,
    slaFailed,
    incompleteStop,
    wrongRun,
    wrongProfile,
    wrongWorkerDeadline,
    pastWorkerDeadline,
    wrongBranch,
    wrongWorktree,
    wrongBase,
    wrongDigest,
    wrongRepository,
    wrongPrUrl,
    wrongHead,
    wrongMonitor,
    missingUsage,
    invalidUsage,
    missingRemoteChecks,
    failedRemoteCommand,
    wrongRemoteCommand,
    missingVerifyCheck,
    missingMergeRequestValidation,
    wrongMergeRequestValidation,
    missingMergeProof,
    unmergedProof,
    wrongMergeConfirmationCommand,
    draftMergeProof,
  ] = await Promise.all([
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { merged: false }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { sla: "failed" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { stopReason: "timeout" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { runId: "different-run" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { profile: "medium" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {
          workerDeadlineAtMs:
            (report.workerDeadlineAtMs as number) + 1,
        }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) => {
        const workerDeadlineAtMs = report.workerDeadlineAtMs as number;
        return terminalReportContents(report, {
          finishedAtMs: workerDeadlineAtMs + 1,
          elapsedMs: workerDeadlineAtMs,
        });
      },
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { branch: "different-branch" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { worktree: "/tmp/different-worktree" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { baseSha: "different-base" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { artifactDigest: "different-digest" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { repository: "other/repository" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {
          prUrl: "https://github.com/other/repository/pull/1",
        }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { matchedHeadSha: "b".repeat(40) }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { monitorRunId: "different-monitor" }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {}, ["usage"]),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, { usage: { input: -1, output: 0 } }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {}, ["remoteChecks"]),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {
          remoteChecks: {
            ...(report.remoteChecks as Record<string, unknown>),
            command: {
              ...((report.remoteChecks as Record<string, unknown>)
                .command as Record<string, unknown>),
              status: "failed",
            },
          },
        }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {
          remoteChecks: {
            ...(report.remoteChecks as Record<string, unknown>),
            command: {
              ...((report.remoteChecks as Record<string, unknown>)
                .command as Record<string, unknown>),
              command: "gh pr checks arbitrary --json name,workflow,bucket",
            },
          },
        }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {
          remoteChecks: {
            ...(report.remoteChecks as Record<string, unknown>),
            checks: [{ name: "Other", workflow: "CI", bucket: "pass" }],
          },
        }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {
          validation: (report.validation as Array<Record<string, unknown>>)
            .filter((entry) => !entry.command?.toString().startsWith("gh pr merge ")),
        }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {
          validation: (report.validation as Array<Record<string, unknown>>).map(
            (entry) =>
              entry.command?.toString().startsWith("gh pr merge ")
                ? { ...entry, command: "gh pr merge arbitrary --squash" }
                : entry,
          ),
        }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {}, ["mergeProof"]),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {
          mergeProof: {
            ...(report.mergeProof as Record<string, unknown>),
            state: "OPEN",
          },
        }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {
          mergeProof: {
            ...(report.mergeProof as Record<string, unknown>),
            command: {
              ...((report.mergeProof as Record<string, unknown>)
                .command as Record<string, unknown>),
              command: "gh pr view arbitrary --json state",
            },
          },
        }),
    }),
    runFinalizerHarness(launcher, 0, {
      mode: "live",
      failCopies: false,
      completeLiveEvidence: true,
      ledger,
      timeoutMs: 30_000,
      reportContents: (report) =>
        terminalReportContents(report, {
          mergeProof: {
            ...(report.mergeProof as Record<string, unknown>),
            isDraft: true,
          },
        }),
    }),
  ]);

  for (const [scenario, result] of [
    ["merged false", mergedFalse],
    ["SLA failed", slaFailed],
    ["incomplete stop", incompleteStop],
    ["wrong run", wrongRun],
    ["wrong profile", wrongProfile],
    ["wrong worker deadline", wrongWorkerDeadline],
    ["past worker deadline", pastWorkerDeadline],
    ["wrong branch", wrongBranch],
    ["wrong worktree", wrongWorktree],
    ["wrong base", wrongBase],
    ["wrong digest", wrongDigest],
    ["wrong repository", wrongRepository],
    ["wrong PR URL", wrongPrUrl],
    ["wrong head", wrongHead],
    ["wrong monitor", wrongMonitor],
    ["missing usage", missingUsage],
    ["invalid usage", invalidUsage],
    ["missing remote checks", missingRemoteChecks],
    ["failed remote command", failedRemoteCommand],
    ["wrong remote command", wrongRemoteCommand],
    ["missing Verify check", missingVerifyCheck],
    ["missing merge request validation", missingMergeRequestValidation],
    ["wrong merge request validation", wrongMergeRequestValidation],
    ["missing merge proof", missingMergeProof],
    ["unmerged proof", unmergedProof],
    ["draft merge proof", draftMergeProof],
    ["wrong merge confirmation command", wrongMergeConfirmationCommand],
  ] as const) {
    expect(result.exitCode, scenario).toBe(74);
    expect(result.latest?.exitCode, scenario).toBe(74);
    expect(result.ledger, scenario).toBe(`${seed}\n`);
    expect(result.stderr, scenario).toContain("validate terminal report");
    expect(result.stderr, scenario).not.toContain("command not found");
  }

  const finalizer = extractShellFunction(launcher, "finalize");
  expect(finalizer).toBeDefined();
  expect(finalizer?.indexOf("run_before_deadline validate_terminal_report")).toBeLessThan(
    finalizer?.indexOf("if ! prepare_terminal_ledger_evidence") ?? -1,
  );
}, 45_000);

test("workflow report binds the selected monitor run", async () => {
  const workflow = await Bun.file(
    ".orca/workflows/codebase-improvement.ts",
  ).text();
  expect(workflow).toContain("monitorRunId: string;");
  expect(workflow).toContain("monitorRunId: monitor.runId,");
});

test("launcher and runtime own disjoint finalization windows", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const runtime = await Bun.file(
    ".orca/workflows/codebase-improvement.ts",
  ).text();
  expect(composedDeadlineOwnershipIssues(launcher, runtime)).toEqual([]);

  const originalOverlap = runtime
    .replace(
      [
        "  const runtimeDeadlineMs = (): number =>",
        "    workerDeadlineAtMs - startedAtMs;",
        "  const workDeadlineMs = (): number =>",
        "    runtimeDeadlineMs() - RUNTIME_FINALIZATION_RESERVE_MS;",
      ].join("\n"),
      [
        "  const workDeadlineMs = (): number =>",
        "    limits.deadlineMs - RUNTIME_FINALIZATION_RESERVE_MS;",
      ].join("\n"),
    )
    .replace(
      [
        "        stageBudgetMs(",
        "          startedAtMs,",
        "          runtimeDeadlineMs(),",
        "          Date.now(),",
        "          runtimeDeadlineMs(),",
        "        ),",
      ].join("\n"),
      "        stageBudgetMs(startedAtMs, limits.deadlineMs, Date.now(), limits.deadlineMs),",
    )
    .replace(
      "            report.elapsedMs <= runtimeDeadlineMs() &&",
      "            report.elapsedMs <= limits.deadlineMs &&",
    );
  const mutations = [
    {
      name: "launcher exports the outer deadline",
      launcher: launcher.replace(
        '  ORCA_IMPROVEMENT_WORKER_DEADLINE_AT_MS="$launcher_work_deadline_at_ms" \\',
        '  ORCA_IMPROVEMENT_WORKER_DEADLINE_AT_MS="$launcher_absolute_deadline_at_ms" \\',
      ),
      runtime,
      issue: "launcher must export its work cutoff to the runtime",
    },
    {
      name: "launcher accepts completion after the worker cutoff",
      launcher: launcher.replace(
        "      and .finishedAtMs <= $workerDeadlineAtMs\n",
        "",
      ),
      runtime,
      issue: "launcher must validate the exact worker deadline before commit",
    },
    {
      name: "early setup fabricates the worker deadline",
      launcher,
      runtime: runtime.replace(
        [
          "  const workerDeadlineAtMs = parseWorkerDeadlineAtMs(",
          '    requiredEnvironment("ORCA_IMPROVEMENT_WORKER_DEADLINE_AT_MS"),',
          "    startedAtMs,",
          "    limits.deadlineMs,",
          "  );",
        ].join("\n"),
        "  let workerDeadlineAtMs = startedAtMs + limits.deadlineMs;",
      ),
      issue: "runtime must bind the worker deadline before fallible setup",
    },
    {
      name: "active work consumes the runtime finalization reserve",
      launcher,
      runtime: runtime.replace(
        "    runtimeDeadlineMs() - RUNTIME_FINALIZATION_RESERVE_MS;",
        "    runtimeDeadlineMs();",
      ),
      issue: "runtime active work must stop before its finalization reserve",
    },
    {
      name: "active work freezes its current-time observation",
      launcher,
      runtime: runtime.replace(
        [
          "  const workRemaining = (): number =>",
          "    stageBudgetMs(",
          "      startedAtMs,",
          "      workDeadlineMs(),",
          "      Date.now(),",
          "      workDeadlineMs(),",
          "    );",
        ].join("\n"),
        [
          "  const workRemaining = (): number =>",
          "    stageBudgetMs(",
          "      startedAtMs,",
          "      workDeadlineMs(),",
          "      startedAtMs,",
          "      workDeadlineMs(),",
          "    );",
        ].join("\n"),
      ),
      issue: "runtime active work must stop before its finalization reserve",
    },
    {
      name: "runtime finalization reserve shrinks",
      launcher,
      runtime: runtime.replace(
        "const RUNTIME_FINALIZATION_RESERVE_MS = 60_000;",
        "const RUNTIME_FINALIZATION_RESERVE_MS = 59_000;",
      ),
      issue: "runtime finalization reserve must remain exactly 60000 ms",
    },
    {
      name: "runtime finalization returns to the profile deadline",
      launcher,
      runtime: runtime.replace(
        [
          "        stageBudgetMs(",
          "          startedAtMs,",
          "          runtimeDeadlineMs(),",
          "          Date.now(),",
          "          runtimeDeadlineMs(),",
          "        ),",
        ].join("\n"),
        "        stageBudgetMs(startedAtMs, limits.deadlineMs, Date.now(), limits.deadlineMs),",
      ),
      issue: "runtime finalization and SLA must use the worker cutoff",
    },
    {
      name: "terminal SLA returns to the profile deadline",
      launcher,
      runtime: runtime.replace(
        "            report.elapsedMs <= runtimeDeadlineMs() &&",
        "            report.elapsedMs <= limits.deadlineMs &&",
      ),
      issue: "runtime finalization and SLA must use the worker cutoff",
    },
    {
      name: "terminal report omits the worker deadline",
      launcher,
      runtime: runtime.replace("    workerDeadlineAtMs,\n", ""),
      issue: "runtime report must parse and bind the exact worker deadline",
    },
    {
      name: "terminal report changes the worker deadline",
      launcher,
      runtime: runtime.replace(
        "    workerDeadlineAtMs,\n",
        "    workerDeadlineAtMs: limits.deadlineMs,\n",
      ),
      issue: "runtime report must parse and bind the exact worker deadline",
    },
    {
      name: "worker deadline parser returns the profile deadline",
      launcher,
      runtime: runtime.replace(
        [
          "  return parsed;",
          "}",
          "",
          "function requiredEnvironment",
        ].join("\n"),
        [
          "  return startedAtMs + deadlineMs;",
          "}",
          "",
          "function requiredEnvironment",
        ].join("\n"),
      ),
      issue: "runtime report must parse and bind the exact worker deadline",
    },
    {
      name: "original overlapping runtime",
      launcher,
      runtime: originalOverlap,
      issue: "runtime finalization and SLA must use the worker cutoff",
    },
  ] as const;
  for (const mutation of mutations) {
    expect(
      mutation.launcher !== launcher || mutation.runtime !== runtime,
      mutation.name,
    ).toBe(true);
    expect(
      composedDeadlineOwnershipIssues(mutation.launcher, mutation.runtime),
      mutation.name,
    ).toContain(mutation.issue);
  }
});

test("successful launcher publication commits the zero-open ledger last", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.stderr).not.toContain("finalize failed");
  expect(result.exitCode).toBe(0);
  expect(result.latest?.exitCode).toBe(0);
  const rows = result.ledger?.trim().split("\n").map((line) => JSON.parse(line));
  expect(rows).toHaveLength(3);
  expect(rows?.[1]).toMatchObject({
    status: "resolved",
    provingRunId: "run",
    prUrl: "https://github.com/ASRagab/orca-ts/pull/1",
  });
  expect(rows?.[2]).toMatchObject({
    terminalCommit: true,
  });
  expect(rows?.[2]?.terminalCommitId).toMatch(/^run\./);
  expect(result.latest?.terminalCommitId).toBe(rows?.[2]?.terminalCommitId);
  expect(result.latest?.ledgerSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.latest?.latestProjectionSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(rows?.[2]?.latestProjectionSha256).toBe(
    result.latest?.latestProjectionSha256,
  );
  expect(result.latest?.terminalProof).toMatch(/^[0-9a-f]{64}$/);
  expect(result.latest?.ledgerSha256).toBe(
    createHash("sha256").update(result.ledger ?? "").digest("hex"),
  );
}, 15_000);

test("expired absolute launcher deadline cannot publish live success", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    launcherDeadlineAtMs: 99,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.exitCode).toBe(74);
  expect(result.latest?.exitCode).not.toBe(0);
  expect(result.ledger).toBe(`${seed}\n`);
}, 15_000);

test("work cutoff expiry still publishes truthful failure evidence", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 124, {
    mode: "live",
    failCopies: false,
    launcherDeadlineAtMs: 10100,
    launcherWorkDeadlineAtMs: 99,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.exitCode).toBe(124);
  expect(result.latest).toMatchObject({ runId: "run", exitCode: 124 });
  expect(result.ledger).toBe(`${seed}\n`);
  expect(result.stderr).not.toContain("finalize failed");
  expect(launcher).toContain("launcher_finalization_reserve_ms=10000");
  const main = extractShellFunction(launcher, "main");
  expect(main).toBeDefined();
  expect(main?.replace(/\s+/g, " ")).toContain(
    "launcher_work_deadline_at_ms=$(( launcher_absolute_deadline_at_ms - launcher_finalization_reserve_ms ))",
  );
  const finalizer = extractShellFunction(launcher, "finalize");
  expect(finalizer).toBeDefined();
  expect(finalizer?.indexOf(
    'launcher_deadline_at_ms="$launcher_absolute_deadline_at_ms"',
  )).toBeLessThan(finalizer?.indexOf("run_before_deadline") ?? -1);
}, 15_000);

test("terminal ledger publication ignores a predictable stage symlink", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    precreatePredictableTerminalStageSymlink: true,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.ledgerIsSymlink).toBe(false);
  expect(result.attackerLedger).toBe("attacker-owned\n");
  expect(hasAuthoritativeLivePair(result.latest, result.ledger)).toBe(true);
  expect(result.terminalStageFiles).toEqual([]);
  expect(result.terminalStageMetadata).toEqual([]);
  expect(result.timedOut).toBe(false);
  expect(result.processGroupAliveAfterCleanup).toBe(false);
  expect(result.rootExistsAfterCleanup).toBe(false);
}, 15_000);

test("terminal ledger publication avoids interruptible cross-parent fallback", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    interruptCrossParentTerminalLedgerMove: true,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.crossParentMoveInterrupted).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.ledger?.endsWith("\n")).toBe(true);
  expect(hasAuthoritativeLivePair(result.latest, result.ledger)).toBe(true);
  expect(result.terminalStageFiles).toEqual([]);
  expect(result.terminalStageMetadata).toEqual([]);
  expect(result.timedOut).toBe(false);
  expect(result.processGroupAliveAfterCleanup).toBe(false);
  expect(result.rootExistsAfterCleanup).toBe(false);
}, 15_000);

test("terminal ledger publication contract rejects allocation and boundary mutations", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const validateCall = [
    "validate_terminal_ledger_publication_paths \\",
    '      "$terminal_ledger_stage" "$ledger" || return $?',
  ].join("\n");
  const commitTail = [
    `    ${validateCall}`,
    "    remaining_launcher_ms remaining_ms || return 124",
    '    if [[ "$remaining_ms" -le 0 ]]; then',
    "      return 124",
    "    fi",
    '    if ! mv "$terminal_ledger_stage" "$ledger"; then',
    "      return 1",
    "    fi",
  ].join("\n");
  const inspect = (source: string): string[] => {
    const issues: string[] = [];
    const creator = extractShellFunction(
      source,
      "create_terminal_ledger_stage",
    ) ?? "";
    const validator = extractShellFunction(
      source,
      "validate_terminal_ledger_publication_paths",
    ) ?? "";
    const merge = extractShellFunction(source, "merge_issue_ledger") ?? "";
    const finalizer = extractShellFunction(source, "finalize") ?? "";
    if (
      !creator.includes("umask 077") ||
      !creator.includes(
        'mktemp "$canonical_parent/.issues.jsonl.terminal.XXXXXX"',
      )
    ) {
      issues.push("terminal stage must use private six-X canonical-parent mktemp");
    }
    if (source.includes('issues.jsonl.terminal.$$')) {
      issues.push("terminal stage path must not be predictable");
    }
    for (const boundary of [
      '! -f "$stage"',
      '-L "$stage"',
      '! -f "$canonical"',
      '-L "$canonical"',
      '"$stage_parent" != "$canonical_parent"',
    ]) {
      if (!validator.includes(boundary)) {
        issues.push(`terminal boundary misses ${boundary}`);
      }
    }
    if ((merge.match(/validate_terminal_ledger_publication_paths/g) ?? []).length !== 5) {
      issues.push("terminal merge must enforce five no-follow boundaries");
    }
    if ((finalizer.match(/validate_terminal_ledger_publication_paths/g) ?? []).length !== 1) {
      issues.push("terminal preparation must recheck before its stage hash");
    }
    const allocation = [
      "capture_before_deadline terminal_ledger_stage \\",
      '      create_terminal_ledger_stage "$ledger" || return $?',
    ].join("\n");
    const prepare = finalizer.indexOf("prepare_terminal_ledger_evidence() {");
    if (prepare < 0 || finalizer.indexOf(allocation, prepare) < prepare) {
      issues.push("terminal stage must be allocated inside terminal preparation");
    }
    if (!merge.includes(commitTail)) {
      issues.push("terminal commit order must be hashes then boundary then decision then rename");
    }
    return issues;
  };

  const baselineIssues = inspect(launcher);
  expect(baselineIssues).toEqual([]);
  if (baselineIssues.length > 0) return;

  const mutations = [
    launcher.replace(
      'mktemp "$canonical_parent/.issues.jsonl.terminal.XXXXXX"',
      'printf \'%s\\n\' "$run_dir/issues.jsonl.terminal.$$"',
    ),
    launcher.replace(
      'mktemp "$canonical_parent/.issues.jsonl.terminal.XXXXXX"',
      'mktemp "${TMPDIR:-/tmp}/issues.jsonl.terminal.XXXXXX"',
    ),
    launcher.replace(' || -L "$stage"', ""),
    launcher.replace(
      commitTail,
      commitTail.replace(`    ${validateCall}\n`, "") + `\n    ${validateCall}`,
    ),
  ];
  for (const [index, mutation] of mutations.entries()) {
    expect(mutation, `mutation ${index + 1}`).not.toBe(launcher);
    expect(inspect(mutation), `mutation ${index + 1}`).not.toEqual([]);
  }
});

test("expired terminal ledger commit leaves retained latest unauthoritative", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    expireAtTerminalLedgerCommit: true,
    launcherDeadlineAtMs: 10_100,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.exitCode).toBe(74);
  expect(result.latest?.exitCode).toBe(0);
  expect(result.latest?.ledgerSha256).not.toBe(
    createHash("sha256").update(result.ledger ?? "").digest("hex"),
  );
  expect(result.ledger).toBe(`${seed}\n`);
  expect(hasAuthoritativeLivePair(result.latest, result.ledger)).toBe(false);
}, 15_000);

test("terminal ledger expiry proof rejects an early deadline decision", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const deadlineDecision = [
    "    remaining_launcher_ms remaining_ms || return 124",
    '    if [[ "$remaining_ms" -le 0 ]]; then',
    "      return 124",
    "    fi",
  ].join("\n");
  const terminalLedgerHash = [
    "    current_terminal_ledger_sha256=$(sha256_file \\",
    '      "$terminal_ledger_stage") || return $?',
  ].join("\n");
  const terminalRename = [
    '    if ! mv "$terminal_ledger_stage" "$ledger"; then',
    "      return 1",
    "    fi",
  ].join("\n");
  const outerPostSuccessDecision = [
    '  if [[ "$command_status" -eq 0 ]]; then',
    "    remaining_launcher_ms remaining_ms || return 124",
    '    if [[ "$remaining_ms" -le 0 ]]; then',
    "      return 124",
    "    fi",
    "  fi",
  ].join("\n");
  expect(launcher).toContain(deadlineDecision);
  expect(launcher).toContain(terminalLedgerHash);
  expect(launcher).toContain([deadlineDecision, terminalRename].join("\n"));
  expect(launcher).toContain(outerPostSuccessDecision);
  const mutation = launcher
    .replace([deadlineDecision, terminalRename].join("\n"), terminalRename)
    .replace(
      terminalLedgerHash,
      [terminalLedgerHash, deadlineDecision].join("\n"),
    )
    .replace(outerPostSuccessDecision, "");
  expect(mutation).not.toBe(launcher);
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(mutation, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    expireAtTerminalLedgerCommit: true,
    launcherDeadlineAtMs: 10_100,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
}, 15_000);

test("terminal ledger expiry proof rejects strict-before equality", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const outerPostSuccessDecision = [
    '  if [[ "$command_status" -eq 0 ]]; then',
    "    remaining_launcher_ms remaining_ms || return 124",
    '    if [[ "$remaining_ms" -le 0 ]]; then',
    "      return 124",
    "    fi",
    "  fi",
  ].join("\n");
  expect(launcher).toContain(outerPostSuccessDecision);
  const mutation = launcher
    .replace(
      '    if [[ "$remaining_ms" -le 0 ]]; then\n      return 124\n    fi\n    if ! mv "$terminal_ledger_stage" "$ledger"; then',
      '    if [[ "$remaining_ms" -lt 0 ]]; then\n      return 124\n    fi\n    if ! mv "$terminal_ledger_stage" "$ledger"; then',
    )
    .replace(outerPostSuccessDecision, "");
  expect(mutation).not.toBe(launcher);
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(mutation, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    expireAtTerminalLedgerCommit: true,
    launcherDeadlineAtMs: 13_100,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.exitCode).toBe(0);
}, 15_000);

test("expired absolute launcher deadline cannot publish preflight success", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "preflight",
    failCopies: false,
    workerExitCode: 0,
    workerCompletedAtMs: 50,
    launcherDeadlineAtMs: 99,
  });

  expect(result.exitCode).toBe(74);
  expect(result.preflightExists).toBe(false);
  expect(result.latest?.exitCode).not.toBe(0);
}, 15_000);

test("post-rename interruption recovers only through the terminal commit record", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const result = await runFinalizerHarness(launcher, 0, {
    mode: "live",
    failCopies: false,
    completeLiveEvidence: true,
    signalAfterTerminalLedgerRename: true,
    ledger: {
      base: `${seed}\n`,
      source: `${seed}\n`,
      candidate: `${seed}\n`,
    },
  });

  expect(result.stderr).toContain("terminal-ledger-rename-signal");
  expect(result.exitCode).toBe(0);
  const rows = result.ledger?.trim().split("\n").map((line) => JSON.parse(line));
  expect(rows?.filter((row) => row.terminalCommit === true)).toHaveLength(1);
  expect(rows?.at(-1)?.terminalCommitId).toBe(
    result.latest?.terminalCommitId,
  );
  expect(result.latest?.ledgerSha256).toBe(
    createHash("sha256").update(result.ledger ?? "").digest("hex"),
  );
  expect(hasAuthoritativeLivePair(result.latest, result.ledger)).toBe(true);
  expect(result.terminalStageFiles).toEqual([]);
  expect(result.terminalStageMetadata).toEqual([]);
}, 15_000);

test("terminal ledger cleanup cutoff recovers under owned outer deadline", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runTerminalLedgerRecoveryDeadlineHarness(
    launcher,
    "cleanup-cutoff",
  );

  expect(result.exitCode).toBe(0);
  expect(result.recoveryOwner).toBe("owned");
  expect(result.ledger).toBe(result.expectedLedger);
  expect(
    createHash("sha256").update(result.ledger ?? "").digest("hex"),
  ).toBe(result.expectedSha256);
  expect(result.remainingDescendants).toEqual([]);
  expect(result.remainingProcessGroups).toEqual([]);
}, 15_000);

test("terminal ledger cleanup cutoff works on stock macOS Bash", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runTerminalLedgerRecoveryDeadlineHarness(
    launcher,
    "cleanup-cutoff",
    "/bin/bash",
  );

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.recoveryOwner).toBe("owned");
  expect(result.ledger).toBe(result.expectedLedger);
  expect(
    createHash("sha256").update(result.ledger ?? "").digest("hex"),
  ).toBe(result.expectedSha256);
  expect(result.remainingDescendants).toEqual([]);
  expect(result.remainingProcessGroups).toEqual([]);
  expect(result.childExitedBeforeMarker).toBe(false);
  expect(result.processGroupAliveAfterCleanup).toBe(false);
  expect(result.rootExistsAfterCleanup).toBe(false);
}, 15_000);

test("pre-rename interruption probes recovery but cannot authorize success", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runTerminalLedgerRecoveryDeadlineHarness(
    launcher,
    "pre-rename-signal",
    "/bin/bash",
  );

  expect(result.exitCode).toBe(143);
  expect(result.launcherSignalStatus).toBe(143);
  expect(result.recoveryStarted).toBe(true);
  expect(result.recoveryStartCount).toBe(1);
  expect(result.recoveryOwner).toBe("owned");
  expect(result.ledger).toBeUndefined();
  expect(
    createHash("sha256").update(result.ledger ?? "").digest("hex"),
  ).not.toBe(result.expectedSha256);
  expect(result.remainingDescendants).toEqual([]);
  expect(result.remainingProcessGroups).toEqual([]);
  expect(result.childExitedBeforeMarker).toBe(false);
  expect(result.processGroupAliveAfterCleanup).toBe(false);
  expect(result.rootExistsAfterCleanup).toBe(false);
}, 15_000);

test("terminal ledger stalled recovery cannot authorize after outer cutoff", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const result = await runTerminalLedgerRecoveryDeadlineHarness(
    launcher,
    "stalled-recovery",
  );

  expect(result.exitCode).toBe(124);
  expect(result.recoveryOwner).toBe("owned");
  expect(result.recoveryTerminatedBeforeRelease).toBe(true);
  expect(result.recoveryChildDeadBeforeRelease).toBe(true);
  expect(result.remainingDescendants).toEqual([]);
  expect(result.remainingProcessGroups).toEqual([]);
}, 15_000);

test("structured harness cleanup closes inherited pipes before awaiting streams", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();

  const atomicStartedAt = Date.now();
  const atomic = await runAtomicPublicationHarness(
    launcher,
    "success",
    undefined,
    "before-rename",
    0,
    "/bin/bash",
    true,
  );
  const atomicElapsedMs = Date.now() - atomicStartedAt;

  const terminalStartedAt = Date.now();
  const terminal = await runTerminalLedgerRecoveryDeadlineHarness(
    launcher,
    "cleanup-cutoff",
    "/bin/bash",
    true,
  );
  const terminalElapsedMs = Date.now() - terminalStartedAt;

  expect(atomic.exitCode, atomic.stderr).toBe(0);
  expect(terminal.exitCode, terminal.stderr).toBe(0);
  expect(atomic.leaderExitedWithInheritedPipeHolder).toBe(true);
  expect(terminal.leaderExitedWithInheritedPipeHolder).toBe(true);
  expect(atomicElapsedMs).toBeLessThan(4_000);
  expect(terminalElapsedMs).toBeLessThan(8_000);
  expect(atomic.processGroupAliveAfterCleanup).toBe(false);
  expect(terminal.processGroupAliveAfterCleanup).toBe(false);
  expect(atomic.rootExistsAfterCleanup).toBe(false);
  expect(terminal.rootExistsAfterCleanup).toBe(false);
  expect(terminal.remainingDescendants).toEqual([]);
  expect(terminal.remainingProcessGroups).toEqual([]);
  expect([
    atomic.inheritedPipeFallbackUsed,
    terminal.inheritedPipeFallbackUsed,
  ]).toEqual([false, false]);
}, 15_000);

test("ledger merge rejects any non-append change to the complete base", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  expect(ledgerFullPrefixContractIssues(launcher)).toEqual([]);
  const weakenedPrefix = launcher.replace(
    [
      '    cmp -s "$base_ledger" \\',
      '      <(dd if="$target_ledger" bs=1 count="$base_bytes" 2>/dev/null)',
    ].join("\n"),
    [
      '    head -n 1 "$base_ledger" | cmp -s - \\',
      '      <(head -n 1 "$target_ledger")',
    ].join("\n"),
  );
  expect(weakenedPrefix).not.toBe(launcher);
  expect(ledgerFullPrefixContractIssues(weakenedPrefix)).toContain(
    "ledger merge must byte-compare the complete captured base",
  );
  for (const [guard, issue] of [
    [
      'if ! has_base_ledger_prefix "$ledger"; then',
      "source ledger must retain the complete captured base",
    ],
    [
      'if ! has_base_ledger_prefix "$candidate_ledger"; then',
      "candidate ledger must retain the complete captured base",
    ],
  ] as const) {
    const mutation = launcher.replace(guard, "if false; then");
    expect(mutation).not.toBe(launcher);
    expect(ledgerFullPrefixContractIssues(mutation)).toContain(issue);
  }

  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const row = (id: string, evidence: string): string =>
    JSON.stringify({
      id,
      runId: "full-prefix-test",
      at: "2026-07-14T16:00:00.000Z",
      classification: "gate",
      stage: "test",
      elapsedMs: 0,
      evidence,
      status: "open",
    });
  const baseRows = [
    seed,
    row("captured-base-one", "captured first non-seed row"),
    row("captured-base-two", "captured second non-seed row"),
  ];
  const mutations = [
    {
      name: "mutates",
      apply: (rows: string[]): string[] => [
        rows[0]!,
        row("captured-base-one-mutated", "mutated first non-seed row"),
        rows[2]!,
      ],
    },
    {
      name: "deletes",
      apply: (rows: string[]): string[] => [rows[0]!, rows[2]!],
    },
    {
      name: "reorders",
      apply: (rows: string[]): string[] => [
        rows[0]!,
        rows[2]!,
        rows[1]!,
      ],
    },
  ];
  const render = (rows: string[]): string => `${rows.join("\n")}\n`;
  const base = render(baseRows);
  for (const target of ["source", "candidate"] as const) {
    for (const mutation of mutations) {
      const changed = render([
        ...mutation.apply(baseRows),
        row(`${target}-${mutation.name}-suffix`, "valid suffix after base drift"),
      ]);
      const source = target === "source" ? changed : base;
      const candidate = target === "candidate" ? changed : base;
      const result = await runLedgerMergeHarness(launcher, {
        base,
        source,
        candidate,
      });
      expect(result.exitCode, `${target} ${mutation.name}`).toBe(65);
      expect(result.stderr, `${target} ${mutation.name}`).toBe(
        `${target} issue ledger no longer has captured append-only base\n`,
      );
      expect(result.source, `${target} ${mutation.name}`).toBe(source);
      expect(result.lockExists, `${target} ${mutation.name}`).toBe(false);
      expect(result.temporaryFiles, `${target} ${mutation.name}`).toEqual([]);
    }
  }
});

test("ledger marker states recover only one exact dead owner", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const base = `${seed}\n`;

  for (const scenario of [
    { name: "empty initialization", entries: [], exitCode: 0 },
    {
      name: "one dead owner",
      entries: [{ name: "owner.99999999.1" }],
      exitCode: 0,
    },
    {
      name: "malformed owner",
      entries: [{ name: "owner.invalid" }],
      exitCode: 124,
    },
    {
      name: "multiple owners",
      entries: [
        { name: "owner.99999998.1" },
        { name: "owner.99999999.2" },
      ],
      exitCode: 124,
    },
  ] as const) {
    const result = await runLedgerMergeHarness(
      launcher,
      { base, source: base, candidate: base },
      {
        deadlineMs: scenario.exitCode === 0 ? 5_000 : 300,
        lockEntries: [...scenario.entries],
      },
    );
    expect(result.exitCode, scenario.name).toBe(scenario.exitCode);
    expect(result.source, scenario.name).toBe(base);
    expect(result.temporaryFiles, scenario.name).toEqual([]);
    if (scenario.exitCode === 0) {
      expect(result.lockExists, scenario.name).toBe(false);
    } else {
      expect(result.lockEntries, scenario.name).toEqual(
        scenario.entries.map((entry) => entry.name).sort(),
      );
    }
  }

  const symlinked = await runLedgerMergeHarness(
    launcher,
    { base, source: base, candidate: base },
    {
      deadlineMs: 300,
      lockEntries: [{ name: "owner.99999999.1" }],
      symlinkLockDirectory: true,
    },
  );
  expect(symlinked.exitCode).toBe(124);
  expect(symlinked.source).toBe(base);
  expect(symlinked.lockEntries).toEqual(["owner.99999999.1"]);
  expect(symlinked.temporaryFiles).toEqual([]);

  const liveOwner = Bun.spawn(["sleep", "30"]);
  const liveMarker = `owner.${String(liveOwner.pid)}.1`;
  try {
    const result = await runLedgerMergeHarness(
      launcher,
      { base, source: base, candidate: base },
      {
        deadlineMs: 300,
        lockEntries: [{ name: liveMarker }],
      },
    );
    expect(result.exitCode).toBe(124);
    expect(result.lockEntries).toEqual([liveMarker]);
    expect(Bun.spawnSync(["kill", "-0", String(liveOwner.pid)]).exitCode).toBe(
      0,
    );
  } finally {
    liveOwner.kill("SIGKILL");
    await liveOwner.exited;
  }
}, 15_000);

test("stale recovery cannot steal a replacement live marker", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const functions = [
    extractIssueLedgerValidator(launcher),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "merge_issue_ledger"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-ledger-owner-race-"));
  const sourceLedger = join(root, "issues.jsonl");
  const candidateLedger = join(root, "candidate.jsonl");
  const baseLedger = join(root, "base.jsonl");
  const pausedA = join(root, "paused-a");
  const resumeA = join(root, "resume-a");
  const pausedB = join(root, "paused-b");
  const releaseB = join(root, "release-b");
  const enteredA = join(root, "entered-a");
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  await Bun.write(baseLedger, `${seed}\n`);
  await Bun.write(sourceLedger, `${seed}\n`);
  await Bun.write(candidateLedger, `${seed}\n`);
  await mkdir(`${sourceLedger}.lock`);
  const deadMarker = `${sourceLedger}.lock/owner.99999999.1`;
  await Bun.write(deadMarker, "");
  const script = join(root, "race.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      `dead_marker=${JSON.stringify(deadMarker)}`,
      `paused_a=${JSON.stringify(pausedA)}`,
      `resume_a=${JSON.stringify(resumeA)}`,
      `paused_b=${JSON.stringify(pausedB)}`,
      `release_b=${JSON.stringify(releaseB)}`,
      `entered_a=${JSON.stringify(enteredA)}`,
      "rm() {",
      '  target="${!#}"',
      '  if [[ "${ROLE:-}" == A && "$target" == "$dead_marker" && ! -e "$paused_a" ]]; then',
      '    : > "$paused_a"',
      '    while [[ ! -e "$resume_a" ]]; do sleep 0.01; done',
      "  fi",
      '  command rm "$@"',
      "}",
      "dd() {",
      '  if [[ "${ROLE:-}" == B && ! -e "$paused_b" ]]; then',
      '    : > "$paused_b"',
      '    while [[ ! -e "$release_b" ]]; do sleep 0.01; done',
      '  elif [[ "${ROLE:-}" == A ]]; then',
      '    : > "$entered_a"',
      "  fi",
      '  command dd "$@"',
      "}",
      ...functions,
      `ledger=${JSON.stringify(sourceLedger)}`,
      'ledger_lock="${ledger}.lock"',
      ...launcherDeadlineLines(5000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      `merge_issue_ledger ${JSON.stringify(candidateLedger)} ${JSON.stringify(baseLedger)}`,
    ].join("\n"),
  );
  const waitFor = async (path: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await Bun.file(path).exists()) return;
      await Bun.sleep(10);
    }
    expect(await Bun.file(path).exists()).toBe(true);
  };
  const processA = Bun.spawn(["bash", script], {
    env: { ...process.env, ROLE: "A" },
    stdout: "pipe",
    stderr: "pipe",
  });
  let processB: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await waitFor(pausedA);
    processB = Bun.spawn(["bash", script], {
      env: { ...process.env, ROLE: "B" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitFor(pausedB);
    const markerB = (await readdir(`${sourceLedger}.lock`)).filter((name) =>
      name.startsWith(`owner.${String(processB?.pid)}.`),
    );
    expect(markerB).toHaveLength(1);
    await Bun.write(resumeA, "");
    await Bun.sleep(100);
    expect(await Bun.file(enteredA).exists()).toBe(false);
    expect(await readdir(`${sourceLedger}.lock`)).toEqual(markerB);
    await Bun.write(releaseB, "");
    expect(await processB.exited).toBe(0);
    expect(await processA.exited).toBe(0);
    expect(await Bun.file(`${sourceLedger}.lock`).exists()).toBe(false);
  } finally {
    processA.kill("SIGKILL");
    if (processB !== undefined) processB.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("release removes only its marker and preserves a replacement owner", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const functions = [
    extractIssueLedgerValidator(launcher),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "merge_issue_ledger"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-ledger-release-race-"));
  const sourceLedger = join(root, "issues.jsonl");
  const candidateLedger = join(root, "candidate.jsonl");
  const baseLedger = join(root, "base.jsonl");
  const releasePaused = join(root, "release-paused");
  const releaseResume = join(root, "release-resume");
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  await Bun.write(baseLedger, `${seed}\n`);
  await Bun.write(sourceLedger, `${seed}\n`);
  await Bun.write(candidateLedger, `${seed}\n`);
  const script = join(root, "release-race.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      `release_paused=${JSON.stringify(releasePaused)}`,
      `release_resume=${JSON.stringify(releaseResume)}`,
      "rm() {",
      '  target="${!#}"',
      '  command rm "$@"',
      '  status="$?"',
      '  if [[ "$status" -eq 0 && "$target" == "$ledger_lock"/owner* && ! -e "$release_paused" ]]; then',
      '    : > "$release_paused"',
      '    while [[ ! -e "$release_resume" ]]; do sleep 0.01; done',
      "  fi",
      '  return "$status"',
      "}",
      ...functions,
      `ledger=${JSON.stringify(sourceLedger)}`,
      'ledger_lock="${ledger}.lock"',
      ...launcherDeadlineLines(5000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      `merge_issue_ledger ${JSON.stringify(candidateLedger)} ${JSON.stringify(baseLedger)}`,
    ].join("\n"),
  );
  const process = Bun.spawn(["bash", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const replacementOwner = Bun.spawn(["sleep", "30"]);
  const replacementMarker = `owner.${String(replacementOwner.pid)}.9`;
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await Bun.file(releasePaused).exists()) break;
      await Bun.sleep(10);
    }
    expect(await Bun.file(releasePaused).exists()).toBe(true);
    await Bun.write(join(`${sourceLedger}.lock`, replacementMarker), "");
    await Bun.write(releaseResume, "");
    expect(await process.exited).toBe(0);
    expect(await readdir(`${sourceLedger}.lock`)).toEqual([replacementMarker]);
    expect(
      Bun.spawnSync(["kill", "-0", String(replacementOwner.pid)]).exitCode,
    ).toBe(0);
  } finally {
    process.kill("SIGKILL");
    replacementOwner.kill("SIGKILL");
    await replacementOwner.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("TERM INT and HUP remove only the caller exact marker and temps", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const functions = [
    extractIssueLedgerValidator(launcher),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "merge_issue_ledger"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) return;
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;

  for (const [signal, expectedExitCode] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "orcats-ledger-signal-"));
    const sourceLedger = join(root, "issues.jsonl");
    const candidateLedger = join(root, "candidate.jsonl");
    const baseLedger = join(root, "base.jsonl");
    const entered = join(root, "entered");
    const release = join(root, "release");
    await Bun.write(baseLedger, `${seed}\n`);
    await Bun.write(sourceLedger, `${seed}\n`);
    await Bun.write(candidateLedger, `${seed}\n`);
    const script = join(root, "signal.sh");
    await Bun.write(
      script,
      [
        "#!/usr/bin/env bash",
        "set -u",
        "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
        `entered=${JSON.stringify(entered)}`,
        `release=${JSON.stringify(release)}`,
        "dd() {",
        '  if [[ ! -e "$entered" ]]; then',
        '    : > "$entered"',
        '    while [[ ! -e "$release" ]]; do sleep 0.01; done',
        "  fi",
        '  command dd "$@"',
        "}",
        ...functions,
        `ledger=${JSON.stringify(sourceLedger)}`,
        'ledger_lock="${ledger}.lock"',
        ...launcherDeadlineLines(5000),
        'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
        `merge_issue_ledger ${JSON.stringify(candidateLedger)} ${JSON.stringify(baseLedger)}`,
      ].join("\n"),
    );
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await Bun.file(entered).exists()) break;
        await Bun.sleep(10);
      }
      expect(await Bun.file(entered).exists()).toBe(true);
      const markers = await readdir(`${sourceLedger}.lock`);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatch(
        new RegExp(`^owner\\.${String(process.pid)}\\.[0-9]+$`),
      );
      process.kill(signal);
      await Bun.sleep(100);
      await Bun.write(release, "");
      expect(await process.exited).toBe(expectedExitCode);
      expect(await Bun.file(`${sourceLedger}.lock`).exists()).toBe(false);
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith("issues.jsonl."),
        ),
      ).toEqual([]);
    } finally {
      process.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("concurrent same-ID ledger suffixes reject candidate resolution", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const functions = [
    extractIssueLedgerValidator(launcher),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "run_before_deadline"),
    extractShellFunction(launcher, "merge_issue_ledger"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-ledger-conflict-"));
  const sourceLedger = join(root, "issues.jsonl");
  const candidateLedger = join(root, "candidate.jsonl");
  const baseLedger = join(root, "base.jsonl");
  const entered = join(root, "entered");
  const release = join(root, "release");
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const row = (status: "open" | "resolved", evidence: string): string =>
    JSON.stringify({
      id: "same-concurrent-id",
      runId: "conflict-test",
      at: "2026-07-14T16:00:00.000Z",
      classification: "gate",
      stage: "test",
      elapsedMs: 0,
      evidence,
      status,
    });
  const sourceOpen = row("open", "concurrent source open");
  const candidateResolution = row("resolved", "isolated candidate resolution");
  const expectedSource = `${seed}\n${sourceOpen}\n`;
  await Bun.write(baseLedger, `${seed}\n`);
  await Bun.write(sourceLedger, `${seed}\n`);
  await Bun.write(candidateLedger, `${seed}\n${candidateResolution}\n`);
  const script = join(root, "conflict.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      `entered=${JSON.stringify(entered)}`,
      `release=${JSON.stringify(release)}`,
      "dd() {",
      '  if [[ ! -e "$entered" ]]; then',
      '    : > "$entered"',
      '    while [[ ! -e "$release" ]]; do sleep 0.01; done',
      "  fi",
      '  command dd "$@"',
      "}",
      ...functions,
      `ledger=${JSON.stringify(sourceLedger)}`,
      'ledger_lock="${ledger}.lock"',
      ...launcherDeadlineLines(5000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      `merge_issue_ledger ${JSON.stringify(candidateLedger)} ${JSON.stringify(baseLedger)}`,
    ].join("\n"),
  );

  const mergeProcess = Bun.spawn(["bash", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await Bun.file(entered).exists()) break;
      await Bun.sleep(10);
    }
    expect(await Bun.file(entered).exists()).toBe(true);
    await Bun.write(sourceLedger, expectedSource);
    await Bun.write(release, "");
    expect(await mergeProcess.exited).toBe(65);
    expect(await Bun.file(sourceLedger).text()).toBe(expectedSource);
    expect(await Bun.file(`${sourceLedger}.lock`).exists()).toBe(false);
  } finally {
    mergeProcess.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("actual launcher startup bounds now_ms before exact time exists", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const root = await mkdtemp(join(tmpdir(), "orcats-startup-clock-"));
  const script = join(root, "launcher.sh");
  const termMarker = join(root, "term");
  const stalledClock = [
    "now_ms() {",
    `  trap ${JSON.stringify(`printf term > ${termMarker}`)} TERM`,
    "  while :; do :; done",
    "}",
  ].join("\n");
  const source = launcher
    .replace(
      "now_ms() {\n  bun -e 'process.stdout.write(String(Date.now()))'\n}",
      stalledClock,
    )
    .replace(
      "    simple) launcher_deadline_ms=600000 ;;",
      "    simple) launcher_deadline_ms=2000 ;;",
    );
  expect(source).not.toBe(launcher);
  expect(source).toContain(stalledClock);
  await Bun.write(script, source);

  const startedAt = Date.now();
  const process = Bun.spawn(["/bin/bash", script, "--preflight-only"], {
    detached: true,
    env: { ...globalThis.process.env, ORCA_BACKEND: "codex", TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const outcome = await Promise.race([
      process.exited.then((exitCode) => ({ timedOut: false, exitCode })),
      Bun.sleep(2_750).then(() => ({ timedOut: true, exitCode: 255 })),
    ]);
    if (outcome.timedOut) {
      try {
        globalThis.process.kill(-process.pid, "SIGKILL");
      } catch {}
      await process.exited;
    }
    expect({
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      termObserved: await Bun.file(termMarker).exists(),
    }).toEqual({ exitCode: 124, timedOut: false, termObserved: true });
    expect(Date.now() - startedAt).toBeLessThan(2_750);
  } finally {
    try {
      globalThis.process.kill(-process.pid, "SIGKILL");
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
}, 6_000);

test("deadline controller has no external cleanup or polling dependency", async () => {
  const result = await runControllerHangScenario("controller-dependencies");
  expect(result.exitCode).toBe(124);
  expect(result.entered).toBe(false);
  expect(result.termObserved).toBe(true);
  expect(result.elapsedMs).toBeLessThan(2_750);
}, 6_000);

test("hanging owner inspection fails closed within controller cutoff", async () => {
  const result = await runControllerHangScenario("owner-scan");
  expect(result.exitCode).toBe(124);
  expect(result.entered).toBe(true);
  expect(result.elapsedMs).toBeLessThan(4_750);
}, 6_000);

test("finalization command cannot outlive controller cutoff", async () => {
  const result = await runControllerHangScenario("finalization");
  expect(result.exitCode).toBe(124);
  expect(result.termObserved).toBe(true);
  expect(result.elapsedMs).toBeLessThan(2_750);
}, 6_000);

test("terminal exact clock cannot stall after command completion", async () => {
  const result = await runControllerHangScenario("terminal-clock");
  expect(result.exitCode).toBe(124);
  expect(result.entered).toBe(true);
  expect(result.elapsedMs).toBeLessThan(4_750);
}, 6_000);

test("launcher deadline wrapper terminates a stalled finalization action", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  if (remaining === undefined || bounded === undefined) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-finalizer-deadline-"));
  const script = join(root, "deadline.sh");
  const nested = join(root, "nested.sh");
  const childPid = join(root, "child.pid");
  await Bun.write(
    nested,
    [
      "#!/usr/bin/env bash",
      "sleep 5 &",
      'child_pid="$!"',
      `printf '%s\\n' "$child_pid" > ${JSON.stringify(childPid)}`,
      'wait "$child_pid"',
    ].join("\n"),
  );
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      remaining,
      bounded,
      ...launcherDeadlineLines(5000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      `run_before_deadline bash ${JSON.stringify(nested)}`,
    ].join("\n"),
  );

  try {
    const startedAt = Date.now();
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await process.exited;
    expect(exitCode).toBe(124);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await Bun.sleep(100);
    const pid = (await Bun.file(childPid).text()).trim();
    expect(Bun.spawnSync(["kill", "-0", pid]).exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful launcher command reaps residual process-group descendants", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  if (remaining === undefined || bounded === undefined) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-success-group-"));
  const script = join(root, "launcher.sh");
  const delayedWritePath = join(root, "delayed-write");
  const backgroundCommand =
    `(sleep 0.4; printf 'late\\n' > ${JSON.stringify(delayedWritePath)}) &`;
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      remaining,
      bounded,
      "launcher_signal_status=0",
      ...launcherDeadlineLines(5000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      `run_before_deadline bash -c ${JSON.stringify(backgroundCommand)}`,
      'exit "$?"',
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await process.exited;
    await Bun.sleep(700);
    expect({
      exitCode,
      delayedWrite: await Bun.file(delayedWritePath).exists(),
    }).toEqual({ exitCode: 125, delayedWrite: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher terminates detached command-owned descendants before returning", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  if (remaining === undefined || bounded === undefined) return;

  const readinessAttemptCount = 300;
  const readinessIntervalMs = 10;
  const activeTermReserveMs = 3_000;
  const minimumReadinessMarginMs = 2_000;
  const delayedStartupSeconds = 2.1;
  const lateWriteDelayMs = 4_000;
  for (const scenario of [
    { name: "success", deadlineMs: 8_000, signal: undefined, exitCode: 0 },
    { name: "timeout", deadlineMs: 8_000, signal: undefined, exitCode: 124 },
    { name: "signal", deadlineMs: 8_000, signal: "SIGTERM", exitCode: 143 },
  ] as const) {
    expect(
      scenario.deadlineMs - activeTermReserveMs -
        readinessAttemptCount * readinessIntervalMs,
      scenario.name,
    ).toBeGreaterThanOrEqual(minimumReadinessMarginMs);
    const root = await mkdtemp(join(tmpdir(), `orcats-detached-${scenario.name}-`));
    const nested = join(root, "nested.sh");
    const script = join(root, "launcher.sh");
    const readyPath = join(root, "ready");
    const childPidPath = join(root, "child.pid");
    const lateWritePath = join(root, "late-write");
    const childSource = [
      "import os,time",
      ...(scenario.name === "timeout"
        ? [`time.sleep(${String(delayedStartupSeconds)})`]
        : []),
      "os.setsid()",
      `open(${JSON.stringify(readyPath)}, "w").write("ready")`,
      `time.sleep(${String(lateWriteDelayMs / 1_000)})`,
      `open(${JSON.stringify(lateWritePath)}, "w").write("late")`,
      "time.sleep(30)",
    ].join("; ");
    await Bun.write(
      nested,
      [
        "#!/usr/bin/env bash",
        `python3 -c ${JSON.stringify(childSource)} >/dev/null 2>&1 &`,
        'child_pid="$!"',
        `printf '%s\\n' "$child_pid" > ${JSON.stringify(childPidPath)}`,
        `while [[ ! -s ${JSON.stringify(readyPath)} ]]; do sleep 0.01; done`,
        ...(scenario.name === "success" ? ["exit 0"] : ["sleep 30"]),
      ].join("\n"),
    );
    await Bun.write(
      script,
      [
        "#!/usr/bin/env bash",
        "set -u",
        "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
        remaining,
        bounded,
        "launcher_signal_status=0",
        ...launcherDeadlineLines(scenario.deadlineMs),
        `launcher_deadline_at_ms=$(( $(now_ms) + ${String(scenario.deadlineMs)} ))`,
        `run_before_deadline bash ${JSON.stringify(nested)}`,
        'exit "$?"',
      ].join("\n"),
    );

    let process: ReturnType<typeof Bun.spawn> | undefined;
    try {
      process = Bun.spawn(["bash", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      for (let attempt = 0; attempt < readinessAttemptCount; attempt += 1) {
        if (await Bun.file(readyPath).exists()) break;
        await Bun.sleep(readinessIntervalMs);
      }
      expect(await Bun.file(readyPath).exists(), scenario.name).toBe(true);
      const readyObservedAtMs = Date.now();
      if (scenario.signal !== undefined) process.kill(scenario.signal);
      const exitCode = await process.exited;
      await Bun.sleep(
        Math.max(0, readyObservedAtMs + lateWriteDelayMs + 200 - Date.now()),
      );
      const childPid = (await Bun.file(childPidPath).text()).trim();
      expect(
        {
          exitCode,
          childAlive: Bun.spawnSync(["kill", "-0", childPid]).exitCode === 0,
          lateWrite: await Bun.file(lateWritePath).exists(),
        },
        scenario.name,
      ).toEqual({
        exitCode: scenario.exitCode,
        childAlive: false,
        lateWrite: false,
      });
    } finally {
      process?.kill("SIGKILL");
      if (await Bun.file(childPidPath).exists()) {
        const childPid = (await Bun.file(childPidPath).text()).trim();
        Bun.spawnSync(["kill", "-KILL", childPid]);
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}, 25_000);

test("timeout and signal fail closed when post-command owner proof cannot complete", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  if (remaining === undefined || bounded === undefined) return;
  const postCommandBounded = bounded.replace(
    "trap 'cleanup_owned_processes_inline; exit 143' TERM",
    "trap 'exit 143' TERM",
  );
  expect(postCommandBounded).not.toBe(bounded);

  const results: Array<{
    readonly elapsedMs: number;
    readonly exitCode: number;
    readonly launcherSignalStatus: string;
    readonly name: string;
    readonly postCommandScanStarted: boolean;
    readonly scanCount: number;
    readonly timedOut: boolean;
  }> = [];
  for (const scenario of [
    { name: "timeout-failed-scan", signal: undefined, scanExit: "exit 70" },
    { name: "signal-hung-scan", signal: "SIGTERM", scanExit: "while :; do :; done" },
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), `orcats-owner-proof-${scenario.name}-`));
    const bin = join(root, "bin");
    const fakePs = join(bin, "ps");
    const nested = join(root, "nested.sh");
    const script = join(root, "launcher.sh");
    const readyPath = join(root, "ready");
    const childPidPath = join(root, "child.pid");
    const signalLatchPath = join(root, "signal-latch");
    const scanMarker = join(root, "owner-scans");
    const childSource = [
      "import os,time",
      "os.setsid()",
      `open(${JSON.stringify(readyPath)}, "w").write("ready")`,
      "time.sleep(30)",
    ].join("; ");
    await mkdir(bin);
    await Bun.write(
      fakePs,
      [
        "#!/usr/bin/env bash",
        `printf 'scan\\n' >> ${JSON.stringify(scanMarker)}`,
        scenario.scanExit,
      ].join("\n"),
    );
    await chmod(fakePs, 0o755);
    await Bun.write(
      nested,
      [
        "#!/usr/bin/env bash",
        `python3 -c ${JSON.stringify(childSource)} >/dev/null 2>&1 &`,
        'child_pid="$!"',
        `printf '%s\\n' "$child_pid" > ${JSON.stringify(childPidPath)}`,
        `while [[ ! -s ${JSON.stringify(readyPath)} ]]; do sleep 0.01; done`,
        "sleep 30",
      ].join("\n"),
    );
    await Bun.write(
      script,
      [
        "#!/usr/bin/env bash",
        "set -u",
        "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
        remaining,
        postCommandBounded,
        "launcher_signal_status=0",
        ...launcherDeadlineLines(5_000),
        'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
        `run_before_deadline bash ${JSON.stringify(nested)}`,
        'status="$?"',
        `printf '%s\\n' "$launcher_signal_status" > ${JSON.stringify(signalLatchPath)}`,
        'exit "$status"',
      ].join("\n"),
    );

    let process: ReturnType<typeof Bun.spawn> | undefined;
    const startedAt = Date.now();
    try {
      process = Bun.spawn(["bash", script], {
        env: {
          ...globalThis.process.env,
          PATH: `${bin}:${globalThis.process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await Bun.file(readyPath).exists()) break;
        await Bun.sleep(10);
      }
      expect(await Bun.file(readyPath).exists(), scenario.name).toBe(true);
      if (scenario.signal !== undefined) process.kill(scenario.signal);
      const outcome = await Promise.race([
        process.exited.then((exitCode) => ({ exitCode, timedOut: false })),
        Bun.sleep(6_250).then(() => ({ exitCode: 255, timedOut: true })),
      ]);
      const scanCount = await Bun.file(scanMarker).exists()
        ? (await Bun.file(scanMarker).text()).split("\n").filter(Boolean).length
        : 0;
      results.push({
        elapsedMs: Date.now() - startedAt,
        exitCode: outcome.exitCode,
        launcherSignalStatus: (await Bun.file(signalLatchPath).text()).trim(),
        name: scenario.name,
        postCommandScanStarted: scanCount === 1,
        scanCount,
        timedOut: outcome.timedOut,
      });
    } finally {
      process?.kill("SIGKILL");
      if (await Bun.file(childPidPath).exists()) {
        const childPid = (await Bun.file(childPidPath).text()).trim();
        Bun.spawnSync(["kill", "-KILL", childPid]);
      }
      await rm(root, { recursive: true, force: true });
    }
  }
  expect(results).toEqual([
    {
      elapsedMs: expect.any(Number),
      exitCode: 125,
      launcherSignalStatus: "0",
      name: "timeout-failed-scan",
      postCommandScanStarted: true,
      scanCount: expect.any(Number),
      timedOut: false,
    },
    {
      elapsedMs: expect.any(Number),
      exitCode: 124,
      launcherSignalStatus: "0",
      name: "signal-hung-scan",
      postCommandScanStarted: true,
      scanCount: expect.any(Number),
      timedOut: false,
    },
  ]);
  expect(results.every((result) => result.elapsedMs < 6_250)).toBe(true);
}, 15_000);

test("launcher filters command-owner environments before persistence", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(bounded).toBeDefined();
  if (bounded === undefined) return;

  expect(bounded).toContain("set -o pipefail");
  expect(bounded).toContain(
    'ps eww -U "$UID" -x -o pid=,command= |',
  );
  expect(bounded).toContain('awk \\');
  expect(bounded).not.toContain(
    'pid=,command= \\\n      > "$command_owner_scan"',
  );
});

test("launcher leaves no owner-scan temp persistence across SIGKILL", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  if (remaining === undefined || bounded === undefined) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-owner-scan-sigkill-"));
  const script = join(root, "launcher.sh");
  const rawSentinel = "ORCATS_RAW_ENV_SENTINEL=must-not-persist";
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      remaining,
      bounded,
      "ps() {",
      `  printf '999999 fake-command ${rawSentinel} ORCA_IMPROVEMENT_COMMAND_OWNER=%s\\n' "$command_owner_token"`,
      "}",
      "kill() {",
      '  if [[ "${1:-}" == -TERM && "${2:-}" == 999999 ]]; then',
      '    command kill -KILL "$command_parent_pid"',
      "  fi",
      '  command kill "$@"',
      "}",
      "launcher_signal_status=0",
      ...launcherDeadlineLines(5_000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      "run_before_deadline true",
      'exit "$?"',
    ].join("\n"),
  );

  const process = Bun.spawn(["bash", script], {
    env: { ...globalThis.process.env, TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    expect(await process.exited).toBe(137);
    const scanFiles = (await readdir(root)).filter((entry) =>
      entry.startsWith("orcats-command-owner-scan."),
    );
    expect(scanFiles).toEqual([]);
  } finally {
    process.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher fails closed when command-owner inspection fails", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  if (remaining === undefined || bounded === undefined) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-owner-scan-failure-"));
  const bin = join(root, "bin");
  const fakePs = join(bin, "ps");
  const script = join(root, "launcher.sh");
  await mkdir(bin);
  await Bun.write(fakePs, "#!/usr/bin/env bash\nexit 70\n");
  await chmod(fakePs, 0o755);
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      remaining,
      bounded,
      "launcher_signal_status=0",
      ...launcherDeadlineLines(5_000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      "run_before_deadline true",
      'exit "$?"',
    ].join("\n"),
  );

  try {
    const exitCode = await Bun.spawn(["bash", script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    expect(exitCode).toBe(125);
    expect(
      (await readdir(root)).filter((entry) =>
        entry.startsWith("orcats-command-"),
      ),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher fails closed when command-owner filter fails", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  if (remaining === undefined || bounded === undefined) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-owner-filter-failure-"));
  const bin = join(root, "bin");
  const fakeAwk = join(bin, "awk");
  const script = join(root, "launcher.sh");
  await mkdir(bin);
  await Bun.write(fakeAwk, "#!/usr/bin/env bash\nexit 71\n");
  await chmod(fakeAwk, 0o755);
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      remaining,
      bounded,
      "launcher_signal_status=0",
      ...launcherDeadlineLines(5_000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      "run_before_deadline true",
      'exit "$?"',
    ].join("\n"),
  );

  try {
    const exitCode = await Bun.spawn(["bash", script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        TMPDIR: root,
      },
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    expect(exitCode).toBe(125);
    expect(
      (await readdir(root)).filter((entry) =>
        entry.startsWith("orcats-command-"),
      ),
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-command owner cleanup preserves timeout and signal status", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  if (remaining === undefined || bounded === undefined) return;

  const expectedStatuses = [
    { scan: "TERM", selectedScan: 1, signal: undefined, exitCode: 124 },
    { scan: "KILL", selectedScan: 2, signal: "SIGTERM", exitCode: 143 },
    { scan: "NONE", selectedScan: 3, signal: "SIGINT", exitCode: 130 },
    { scan: "TERM", selectedScan: 1, signal: "SIGHUP", exitCode: 129 },
  ] as const;
  for (const scenario of expectedStatuses) {
    const root = await mkdtemp(
      join(tmpdir(), `orcats-cleanup-${scenario.scan.toLowerCase()}-`),
    );
    const bin = join(root, "bin");
    const fakePs = join(bin, "ps");
    const leader = join(root, "leader.sh");
    const owner = join(root, "owner.py");
    const script = join(root, "launcher.sh");
    const scanCountPath = join(root, "scan-count");
    const scanEnteredPath = join(root, "scan-entered");
    const leaderExitedPath = join(root, "leader-exited");
    const ownerReadyPath = join(root, "owner-ready");
    const ownerPidPath = join(root, "owner.pid");
    const signalLatchPath = join(root, "signal-latch");
    const needsOwner = scenario.selectedScan > 1;
    await mkdir(bin);
    await Bun.write(
      fakePs,
      [
        "#!/bin/bash",
        "scan_count=0",
        'if [[ -s "$ORCA_SCAN_COUNT" ]]; then',
        '  IFS= read -r scan_count < "$ORCA_SCAN_COUNT"',
        "fi",
        "scan_count=$(( scan_count + 1 ))",
        'printf \'%s\\n\' "$scan_count" > "$ORCA_SCAN_COUNT"',
        'if [[ "$scan_count" -eq "$ORCA_SELECTED_SCAN" ]]; then',
        '  printf \'%s\\n\' "$scan_count" > "$ORCA_SCAN_ENTERED"',
        "  while :; do :; done",
        "fi",
        'exec /bin/ps "$@"',
      ].join("\n"),
    );
    await chmod(fakePs, 0o755);
    await Bun.write(
      owner,
      [
        "import os",
        "import signal",
        "import time",
        "os.setsid()",
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        'open(os.environ["ORCA_OWNER_READY"], "w").write("ready")',
        "time.sleep(30)",
      ].join("\n"),
    );
    await Bun.write(
      leader,
      [
        "#!/bin/bash",
        "set -u",
        ...(needsOwner
          ? [
              `python3 ${JSON.stringify(owner)} >/dev/null 2>&1 &`,
              'owner_pid="$!"',
              `printf '%s\\n' "$owner_pid" > ${JSON.stringify(ownerPidPath)}`,
              'while [[ ! -s "$ORCA_OWNER_READY" ]]; do sleep 0.01; done',
            ]
          : []),
        `: > ${JSON.stringify(leaderExitedPath)}`,
        "exit 0",
      ].join("\n"),
    );
    await chmod(leader, 0o755);
    await Bun.write(
      script,
      [
        "#!/bin/bash",
        "set -u",
        "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
        remaining,
        bounded,
        "launcher_signal_status=0",
        "terminal_commit_signal_status=0",
        "launcher_deadline_ms=5000",
        'started_at_ms="$(now_ms)"',
        "launcher_deadline_at_ms=$(( started_at_ms + launcher_deadline_ms ))",
        "trap 'launcher_signal_status=143; exit 143' TERM",
        "trap 'launcher_signal_status=130; exit 130' INT",
        "trap 'launcher_signal_status=129; exit 129' HUP",
        "set +e",
        `run_before_deadline /bin/bash ${JSON.stringify(leader)}`,
        'status="$?"',
        `printf '%s\\n' "$launcher_signal_status" > ${JSON.stringify(signalLatchPath)}`,
        'exit "$status"',
      ].join("\n"),
    );

    const harnessProcess = Bun.spawn(["/bin/bash", script], {
      env: {
        ...globalThis.process.env,
        ORCA_OWNER_READY: ownerReadyPath,
        ORCA_SCAN_COUNT: scanCountPath,
        ORCA_SCAN_ENTERED: scanEnteredPath,
        ORCA_SELECTED_SCAN: String(scenario.selectedScan),
        PATH: `${bin}:${globalThis.process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const trackedPids = new Set<number>();
    let ownerPid: number | undefined;
    const recoverOwnerPid = async (): Promise<number | undefined> => {
      if (!(await Bun.file(ownerPidPath).exists())) return undefined;
      const candidate = Number((await Bun.file(ownerPidPath).text()).trim());
      return Number.isInteger(candidate) && candidate > 0
        ? candidate
        : undefined;
    };
    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (await Bun.file(scanEnteredPath).exists()) break;
        await Bun.sleep(10);
      }
      if (needsOwner) {
        ownerPid = await recoverOwnerPid();
        if (ownerPid !== undefined) trackedPids.add(ownerPid);
      }
      expect(await Bun.file(scanEnteredPath).exists(), scenario.scan).toBe(true);
      expect(await Bun.file(leaderExitedPath).exists(), scenario.scan).toBe(true);
      if (needsOwner) {
        expect(Number.isInteger(ownerPid), scenario.scan).toBe(true);
      }
      for (const pid of collectOwnedHarnessPids(
        harnessProcess.pid,
        script,
        trackedPids,
      )) {
        trackedPids.add(pid);
      }
      const signalledAt = Date.now();
      if (scenario.signal !== undefined) harnessProcess.kill(scenario.signal);
      const outcome = await Promise.race([
        harnessProcess.exited.then((exitCode) => ({ exitCode, timedOut: false })),
        Bun.sleep(6_500).then(() => ({ exitCode: 255, timedOut: true })),
      ]);
      const elapsedAfterSignalMs = Date.now() - signalledAt;
      await Bun.sleep(50);
      const livePids = collectOwnedHarnessPids(
        harnessProcess.pid,
        script,
        trackedPids,
      );
      const controllerPids = [...livePids]
        .filter((pid) => pid !== ownerPid)
        .sort((left, right) => left - right);
      expect(
        {
          controllerPids,
          elapsedAfterSignalMs,
          exitCode: outcome.exitCode,
          launcherSignalStatus: (await Bun.file(signalLatchPath).text()).trim(),
          scanCount: Number((await Bun.file(scanCountPath).text()).trim()),
          timedOut: outcome.timedOut,
        },
        scenario.scan,
      ).toEqual({
        controllerPids: [],
        elapsedAfterSignalMs: expect.any(Number),
        exitCode: scenario.exitCode,
        launcherSignalStatus: scenario.signal === undefined
          ? "0"
          : String(scenario.exitCode),
        scanCount: scenario.selectedScan,
        timedOut: false,
      });
      if (scenario.signal !== undefined) {
        expect(elapsedAfterSignalMs, scenario.scan).toBeLessThan(1_500);
      }
    } finally {
      if (ownerPid === undefined) {
        ownerPid = await recoverOwnerPid();
        if (ownerPid !== undefined) trackedPids.add(ownerPid);
      }
      if (ownerPid !== undefined) {
        Bun.spawnSync(["kill", "-KILL", String(ownerPid)]);
      }
      const cleanupResidue = await terminateOwnedHarness(
        harnessProcess.pid,
        script,
        trackedPids,
      );
      try {
        expect(cleanupResidue, scenario.scan).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}, 20_000);

test("descendant containment contract states its cooperative proof boundary", async () => {
  const [launcher, runbook] = await Promise.all([
    Bun.file(".orca/workflows/codebase-improvement.sh").text(),
    Bun.file(".orca/workflows/codebase-improvement.run.md").text(),
  ]);
  const requiredRunbookSentences = [
    "Containment covers process-group members and descendants retaining the inherited owner token.",
    "Bounded owner inspection fails closed unless it proves the cooperative set empty.",
    "Arbitrary same-UID hostile processes are outside the proof because they can also mutate repository authority directly.",
    "This is not kernel isolation.",
  ] as const;
  const priorUnqualifiedWording =
    "Same-user owner inspection finds detached descendants";
  const replaceSentence = (
    source: string,
    sentence: string,
    replacement: string,
  ): string => {
    const escaped = sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return source.replace(new RegExp(escaped.replace(/ /g, "\\s+")), replacement);
  };

  const inspectContract = (
    launcherSource: string,
    runbookSource: string,
  ): string[] => {
    const issues: string[] = [];
    const compactRunbook = runbookSource.replace(/\s+/g, " ");
    for (const sentence of requiredRunbookSentences) {
      if (!compactRunbook.includes(sentence)) {
        issues.push(`runbook must state: ${sentence}`);
      }
    }
    if (compactRunbook.includes(priorUnqualifiedWording)) {
      issues.push("runbook retains prior unqualified descendant claim");
    }

    const bounded = extractShellFunction(launcherSource, "run_before_deadline");
    if (bounded === undefined) {
      issues.push("launcher must define run_before_deadline");
      return issues;
    }
    const terminationStart = bounded.indexOf(
      "  terminate_command_owner_pids() {",
    );
    const terminationEnd = bounded.indexOf(
      "\n  cleanup_owned_processes_inline() {",
      terminationStart,
    );
    if (terminationStart < 0 || terminationEnd < 0) {
      issues.push("launcher must define bounded cooperative-owner termination");
      return issues;
    }
    const termination = bounded.slice(terminationStart, terminationEnd);
    const boundedScans = termination.match(
      /controller_run_until "\$command_term_second" "\$command_kill_second" \\\n+      scan_and_signal_command_owners (?:TERM|KILL|NONE)/g,
    );
    if (boundedScans?.length !== 3) {
      issues.push("TERM KILL and empty-owner proof must all be controller-bounded");
    }
    const failClosedBranches = termination.match(/\*\) return 125 ;;/g);
    if (failClosedBranches?.length !== 3) {
      issues.push("bounded TERM and KILL owner inspections must fail closed");
    }
    const preservingBranches = termination.match(
      /124\|143\|130\|129\) return "\$owner_scan_status" ;;/g,
    );
    if (preservingBranches?.length !== 3) {
      issues.push(
        "bounded owner timeout and signal statuses must propagate unchanged",
      );
    }
    const finalInspection = termination.slice(
      termination.lastIndexOf(
        'scan_and_signal_command_owners NONE || owner_scan_status=$?',
      ),
    );
    if (
      !finalInspection.includes("0) return 0 ;;") ||
      !finalInspection.includes("42) return 125 ;;")
    ) {
      issues.push("final bounded inspection must prove cooperative owner set empty");
    }
    if (bounded.includes("command_owner_had_process")) {
      issues.push(
        "successful status must depend on final residual ownership, not prior discovery",
      );
    }
    const commandRunStart = bounded.indexOf(
      '  if [[ "$command_capture_mode" == true ]]',
      terminationEnd,
    );
    const cleanupCall = bounded.indexOf(
      "\n  owner_cleanup_status=0\n  terminate_command_owner_pids || owner_cleanup_status=$?",
      commandRunStart,
    );
    if (cleanupCall < 0) {
      issues.push(
        "launcher must call cooperative-owner cleanup proof after every command exit",
      );
    } else if (
      /return "\$command_status"|124\)\s+return 124/.test(
        bounded.slice(commandRunStart, cleanupCall),
      )
    ) {
      issues.push(
        "cooperative-owner cleanup proof must precede command-status returns",
      );
    }
    if (!bounded.includes('    return "$owner_cleanup_status"')) {
      issues.push("cooperative-owner cleanup caller must preserve bounded status");
    }
    if (
      !bounded.includes(
        '        launcher_signal_status="$owner_cleanup_status"',
      )
    ) {
      issues.push("cooperative-owner cleanup signals must update launcher signal status");
    }
    return issues;
  };

  expect(inspectContract(launcher, runbook)).toEqual([]);

  const mutations = [
    {
      name: "prior unqualified wording",
      launcher,
      runbook: replaceSentence(
        runbook,
        requiredRunbookSentences[0],
        `${priorUnqualifiedWording}.`,
      ),
      issue: "runbook retains prior unqualified descendant claim",
    },
    {
      name: "owner-token retention omitted",
      launcher,
      runbook: replaceSentence(
        runbook,
        requiredRunbookSentences[0],
        "Containment covers process-group members and descendants with the inherited owner token.",
      ),
      issue: `runbook must state: ${requiredRunbookSentences[0]}`,
    },
    {
      name: "hostile same-UID process claimed inside proof",
      launcher,
      runbook: replaceSentence(
        runbook,
        requiredRunbookSentences[2],
        "Arbitrary same-UID hostile processes are inside the proof because they can also mutate repository authority directly.",
      ),
      issue: `runbook must state: ${requiredRunbookSentences[2]}`,
    },
    {
      name: "kernel isolation claimed",
      launcher,
      runbook: replaceSentence(
        runbook,
        requiredRunbookSentences[3],
        "This is kernel isolation.",
      ),
      issue: `runbook must state: ${requiredRunbookSentences[3]}`,
    },
    {
      name: "inspection allowed to fail open",
      launcher,
      runbook: replaceSentence(
        runbook,
        requiredRunbookSentences[1],
        "Bounded owner inspection may fail open without proving the cooperative set empty.",
      ),
      issue: `runbook must state: ${requiredRunbookSentences[1]}`,
    },
    {
      name: "TERM inspection failure accepted",
      launcher: launcher.replace(
        '      124|143|130|129) return "$owner_scan_status" ;;\n' +
          "      *) return 125 ;;",
        '      124|143|130|129) return "$owner_scan_status" ;;\n' +
          "      *) return 0 ;;",
      ),
      runbook,
      issue: "bounded TERM and KILL owner inspections must fail closed",
    },
    {
      name: "empty-owner proof omitted",
      launcher: launcher.replace(
        "      0) return 0 ;;\n      42) return 125 ;;",
        "      0|42) return 0 ;;",
      ),
      runbook,
      issue: "final bounded inspection must prove cooperative owner set empty",
    },
    {
      name: "observed-once owner failure restored",
      launcher: launcher
        .replace(
          "  local command_status=0\n",
          "  local command_status=0\n  local command_owner_had_process=false\n",
        )
        .replace("      42) ;;", "      42) command_owner_had_process=true ;;")
        .replace(
          '  if [[ "$command_status" -eq 0 ]]; then',
          '  if [[ "$command_owner_had_process" == true &&\n' +
            '    "$command_status" -eq 0 ]]; then\n' +
            "    command_status=125\n" +
            "  fi\n" +
            '  if [[ "$command_status" -eq 0 ]]; then',
        ),
      runbook,
      issue:
        "successful status must depend on final residual ownership, not prior discovery",
    },
    {
      name: "reachable cleanup proof call omitted",
      launcher: launcher.replace(
        "  owner_cleanup_status=0\n" +
          "  terminate_command_owner_pids || owner_cleanup_status=$?\n" +
          '  if [[ "$owner_cleanup_status" -ne 0 ]]; then\n' +
          "    case \"$owner_cleanup_status\" in\n" +
          "      143|130|129)\n" +
          '        if [[ "$launcher_signal_status" -eq 0 ]]; then\n' +
          '          launcher_signal_status="$owner_cleanup_status"\n' +
          "        fi\n" +
          "        ;;\n" +
          "    esac\n" +
          '    return "$owner_cleanup_status"\n' +
          "  fi\n",
        "",
      ),
      runbook,
      issue:
        "launcher must call cooperative-owner cleanup proof after every command exit",
    },
    {
      name: "bounded cleanup status flattening restored",
      launcher: launcher.replace(
        '      124|143|130|129) return "$owner_scan_status" ;;',
        "      124|143|130|129) return 125 ;;",
      ),
      runbook,
      issue: "bounded owner timeout and signal statuses must propagate unchanged",
    },
    {
      name: "cleanup caller status flattening restored",
      launcher: launcher.replace(
        '    return "$owner_cleanup_status"',
        "    return 125",
      ),
      runbook,
      issue: "cooperative-owner cleanup caller must preserve bounded status",
    },
  ] as const;
  for (const mutation of mutations) {
    expect(
      mutation.launcher !== launcher || mutation.runbook !== runbook,
      mutation.name,
    ).toBe(true);
    expect(
      inspectContract(mutation.launcher, mutation.runbook),
      mutation.name,
    ).toContain(mutation.issue);
  }
});

test("deadline polling cannot defer TERM behind a stalled clock subprocess", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  if (remaining === undefined || bounded === undefined) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-stalled-clock-signal-"));
  const script = join(root, "launcher.sh");
  const nested = join(root, "nested.sh");
  const childPidPath = join(root, "child.pid");
  const clockStallPath = join(root, "clock.stall");
  const clockEnteredPath = join(root, "clock.entered");
  const concurrentFinalizerPath = join(root, "finalized-while-child-alive");
  await Bun.write(
    nested,
    [
      "#!/usr/bin/env bash",
      "sleep 30 &",
      'child_pid="$!"',
      `printf '%s\\n' "$child_pid" > ${JSON.stringify(childPidPath)}`,
      `: > ${JSON.stringify(clockStallPath)}`,
      'wait "$child_pid"',
    ].join("\n"),
  );
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() {",
      `  if [[ -f ${JSON.stringify(clockStallPath)} ]]; then`,
      `    : > ${JSON.stringify(clockEnteredPath)}`,
      "    sleep 2",
      "  fi",
      "  printf '100\\n'",
      "}",
      remaining,
      bounded,
      "launcher_signal_status=0",
      "launcher_deadline_ms=30000",
      "launcher_deadline_at_ms=30100",
      `child_pid_path=${JSON.stringify(childPidPath)}`,
      `concurrent_finalizer_path=${JSON.stringify(concurrentFinalizerPath)}`,
      "finalize_probe() {",
      '  if [[ -f "$child_pid_path" ]]; then',
      '    child_pid=$(<"$child_pid_path")',
      '    if kill -0 "$child_pid" 2>/dev/null; then',
      '      printf \'alive\\n\' > "$concurrent_finalizer_path"',
      "    fi",
      "  fi",
      "}",
      "trap finalize_probe EXIT",
      `run_before_deadline bash ${JSON.stringify(nested)}`,
      'exit "$?"',
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await Bun.file(childPidPath).exists()) break;
      await Bun.sleep(10);
    }
    expect(await Bun.file(childPidPath).exists()).toBe(true);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await Bun.file(clockEnteredPath).exists()) break;
      await Bun.sleep(10);
    }
    const signalledAt = Date.now();
    process.kill("SIGTERM");
    expect(await process.exited).toBe(143);
    expect(Date.now() - signalledAt).toBeLessThan(1_500);
    await Bun.sleep(100);
    const childPid = (await Bun.file(childPidPath).text()).trim();
    expect(Bun.spawnSync(["kill", "-0", childPid]).exitCode).not.toBe(0);
    expect(await Bun.file(concurrentFinalizerPath).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("main-shell bounded capture preserves command-substitution stdout", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const capture = extractShellFunction(launcher, "capture_before_deadline");
  const captureAction = extractShellFunction(launcher, "capture_command_output");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  expect(capture).toBeDefined();
  if (
    remaining === undefined ||
    bounded === undefined ||
    captureAction === undefined ||
    capture === undefined
  ) {
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-main-shell-capture-"));
  const script = join(root, "capture.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      remaining,
      bounded,
      captureAction,
      capture,
      "launcher_signal_status=0",
      ...launcherDeadlineLines(5000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      'captured="stale"',
      `capture_before_deadline captured bash -c ${JSON.stringify("printf 'alpha\\n\\nbeta\\n\\n'")}`,
      `[[ "$captured" == $'alpha\\n\\nbeta' ]] || exit 91`,
      `capture_before_deadline captured bash -c ${JSON.stringify("printf partial; exit 7")}`,
      'status="$?"',
      '[[ "$status" -eq 7 && "$captured" == partial ]] || exit 92',
      "capture_before_deadline captured true",
      '[[ -z "$captured" ]] || exit 93',
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captured shell function preserves status under control-frame collision", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const capture = extractShellFunction(launcher, "capture_before_deadline");
  const captureAction = extractShellFunction(launcher, "capture_command_output");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  expect(capture).toBeDefined();
  if (
    remaining === undefined ||
    bounded === undefined ||
    captureAction === undefined ||
    capture === undefined
  ) {
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-control-frame-collision-"));
  const script = join(root, "capture.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      remaining,
      bounded,
      captureAction,
      capture,
      "launcher_signal_status=0",
      ...launcherDeadlineLines(5_000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      "emit_control_frame_collisions() {",
      '  local pid_nonce=""',
      '  local status_nonce=""',
      '  if [[ -n "${controller_capture_nonce:-}" ]]; then',
      "    printf '\\0%s:pid:%s\\0\\0%s:status:0\\0' \\",
      '      "$controller_capture_nonce" "$$" "$controller_capture_nonce"',
      "  fi",
      '  if [[ -n "${controller_pid_pattern:-}" ]]; then',
      '    pid_nonce="${controller_pid_pattern#^}"',
      '    pid_nonce="${pid_nonce%%:pid:*}"',
      "    printf '\\0%s:pid:%s\\0' \"$pid_nonce\" \"$$\"",
      "  fi",
      '  if [[ -n "${controller_status_pattern:-}" ]]; then',
      '    status_nonce="${controller_status_pattern#^}"',
      '    status_nonce="${status_nonce%%:status:*}"',
      "    printf '\\0%s:status:0\\0' \"$status_nonce\"",
      "  fi",
      "  printf ordinary-payload",
      "  return 7",
      "}",
      'captured=""',
      "capture_before_deadline captured emit_control_frame_collisions",
      'status="$?"',
      'printf %s "$captured"',
      'exit "$status"',
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["/bin/bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 7,
      stdout: "ordinary-payload",
      stderr: "",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captured shell function preserves output larger than pipe capacity", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const capture = extractShellFunction(launcher, "capture_before_deadline");
  const captureAction = extractShellFunction(launcher, "capture_command_output");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  expect(capture).toBeDefined();
  if (
    remaining === undefined ||
    bounded === undefined ||
    captureAction === undefined ||
    capture === undefined
  ) {
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-large-capture-"));
  const script = join(root, "capture.sh");
  const capturedPath = join(root, "captured.txt");
  const chunk = "0123456789abcdef".repeat(64);
  const repeats = 256;
  const expected = chunk.repeat(repeats);
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      remaining,
      bounded,
      captureAction,
      capture,
      "launcher_signal_status=0",
      ...launcherDeadlineLines(5_000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      "emit_large_output() {",
      "  local index=0",
      `  local chunk=${JSON.stringify(chunk)}`,
      `  while [[ "$index" -lt ${String(repeats)} ]]; do`,
      '    printf %s "$chunk"',
      "    index=$(( index + 1 ))",
      "  done",
      "}",
      'captured=""',
      "capture_before_deadline captured emit_large_output",
      `printf %s "$captured" > ${JSON.stringify(capturedPath)}`,
      'exit "$?"',
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["/bin/bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect({
      captured: await Bun.file(capturedPath).text(),
      exitCode,
      stderr,
    }).toEqual({ captured: expected, exitCode: 0, stderr: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captured broker rejects a successful empty NUL control frame", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const controller = extractShellFunction(launcher, "controller_run_until");
  expect(controller).toBeDefined();
  if (controller === undefined) return;

  const readBranch = [
    '        if IFS= read -r -d \'\' -t "$controller_wait_seconds" \\',
    "          controller_line <&7; then",
  ].join("\n");
  const instrumentedReadBranch = [
    readBranch,
    `          printf '%s:%s\\n' "$?" "\${#controller_line}" >> "$read_proof"`,
  ].join("\n");
  const pidFrame =
    `      printf '%s:pid:%s\\0' "$controller_capture_nonce" "$controller_job_pid"`;
  const injectedController = controller
    .replace(readBranch, instrumentedReadBranch)
    .replace(pidFrame, [`      printf '\\0'`, pidFrame].join("\n"));
  expect(injectedController).not.toBe(controller);
  expect(injectedController).toContain(instrumentedReadBranch);
  expect(injectedController).toContain(`      printf '\\0'`);

  const root = await mkdtemp(join(tmpdir(), "orcats-empty-control-frame-"));
  const script = join(root, "capture.sh");
  const readProof = join(root, "read-proof.txt");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      `read_proof=${JSON.stringify(readProof)}`,
      injectedController,
      "emit_payload() { printf payload; }",
      'captured="stale"',
      "SECONDS=0",
      "controller_run_until 2 3 --capture captured emit_payload",
      'exit "$?"',
    ].join("\n"),
  );

  const startedAt = Date.now();
  try {
    const process = Bun.spawn(["/bin/bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    const firstRead = (await Bun.file(readProof).text()).split("\n")[0];
    expect({ exitCode, firstRead, stderr }).toEqual({
      exitCode: 125,
      firstRead: "0:0",
      stderr: "",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captured broker rejects missing or truncated typed frames", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const controller = extractShellFunction(launcher, "controller_run_until");
  expect(controller).toBeDefined();
  if (controller === undefined) return;

  const payloadFrame = [
    "        printf '%s%s:%s\\0' \\",
    '          "$controller_payload_prefix" "${#broker_capture_value}" \\',
    '          "$broker_capture_value"',
  ].join("\n");
  const statusFrame = [
    "      printf '%s:status:%s\\0' \\",
    '        "$controller_capture_nonce" "$controller_job_status"',
  ].join("\n");
  const mutations = [
    {
      name: "missing-payload",
      source: controller.replace(payloadFrame, ":"),
    },
    {
      name: "truncated-payload",
      source: controller.replace(
        "        printf '%s%s:%s\\0' \\",
        "        printf '%s%s:%s' \\",
      ),
    },
    {
      name: "missing-status",
      source: controller.replace(statusFrame, ":"),
    },
  ] as const;
  for (const mutation of mutations) {
    expect(mutation.source, mutation.name).not.toBe(controller);
  }
  if (mutations.some((mutation) => mutation.source === controller)) return;

  for (const mutation of mutations) {
    const root = await mkdtemp(join(tmpdir(), `orcats-${mutation.name}-`));
    const script = join(root, "capture.sh");
    await Bun.write(
      script,
      [
        "#!/usr/bin/env bash",
        "set -u",
        mutation.source,
        "emit_payload() { printf payload; return 7; }",
        'captured="stale"',
        "SECONDS=0",
        "controller_run_until 2 3 --capture captured emit_payload",
        'exit "$?"',
      ].join("\n"),
    );
    const startedAt = Date.now();
    try {
      const process = Bun.spawn(["/bin/bash", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);
      expect({
        elapsedMs: Date.now() - startedAt,
        exitCode,
        stderr,
      }).toEqual({ elapsedMs: expect.any(Number), exitCode: 125, stderr: "" });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("captured command timeout leaves no private TMPDIR residue", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const capture = extractShellFunction(launcher, "capture_before_deadline");
  const captureAction = extractShellFunction(launcher, "capture_command_output");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  expect(capture).toBeDefined();
  if (
    remaining === undefined ||
    bounded === undefined ||
    captureAction === undefined ||
    capture === undefined
  ) {
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "orcats-capture-timeout-"));
  const script = join(root, "capture.sh");
  const clockCalls = join(root, "clock-calls");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      `clock_calls=${JSON.stringify(clockCalls)}`,
      "now_ms() {",
      "  local calls=0",
      '  if [[ -f "$clock_calls" ]]; then calls=$(<"$clock_calls"); fi',
      '  calls=$(( calls + 1 ))',
      '  printf %s "$calls" > "$clock_calls"',
      '  if [[ "$calls" -eq 1 ]]; then',
      "    printf '100\\n'",
      "    return 0",
      "  fi",
      "  trap '' TERM",
      "  sleep 30",
      "}",
      remaining,
      bounded,
      captureAction,
      capture,
      "launcher_signal_status=0",
      ...launcherDeadlineLines(5_000),
      "launcher_deadline_at_ms=5100",
      'captured=""',
      `capture_before_deadline captured bash -c ${JSON.stringify("printf partial")}`,
      'exit "$?"',
    ].join("\n"),
  );

  try {
    const exitCode = await Bun.spawn(["bash", script], {
      env: { ...globalThis.process.env, TMPDIR: root },
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    const residue = (await readdir(root)).filter((entry) =>
      entry.startsWith("orcats-command-output."),
    );
    expect({
      clockCalls: (await Bun.file(clockCalls).text()).trim(),
      exitCode,
      residue,
    }).toEqual({ clockCalls: "2", exitCode: 124, residue: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 8_000);

test("active capture leaves no residue after owned groups receive SIGKILL", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const controller = extractShellFunction(launcher, "controller_run_until");
  expect(controller).toBeDefined();
  if (controller === undefined) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-capture-sigkill-"));
  const nested = join(root, "nested.sh");
  const script = join(root, "launcher.sh");
  const brokerPidPath = join(root, "broker.pid");
  const nestedPidPath = join(root, "nested.pid");
  const commandPidPath = join(root, "command.pid");
  const lateWritePath = join(root, "late-write");
  const instrumentedController = controller.replace(
    "    controller_job_pid=$!",
    [
      "    controller_job_pid=$!",
      `    printf '%s\\n' "$controller_job_pid" > ${JSON.stringify(brokerPidPath)}`,
    ].join("\n"),
  );
  expect(instrumentedController).not.toBe(controller);
  if (instrumentedController === controller) {
    await rm(root, { recursive: true, force: true });
    return;
  }

  await Bun.write(
    nested,
    [
      "#!/usr/bin/env bash",
      "printf partial",
      `printf '%s\\n' "$$" > ${JSON.stringify(nestedPidPath)}`,
      "sleep 30 &",
      'command_pid="$!"',
      `printf '%s\\n' "$command_pid" > ${JSON.stringify(commandPidPath)}`,
      'wait "$command_pid"',
      `printf late > ${JSON.stringify(lateWritePath)}`,
    ].join("\n"),
  );
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      instrumentedController,
      'captured=""',
      "SECONDS=0",
      `controller_run_until 20 21 --capture captured /bin/bash ${JSON.stringify(nested)}`,
      'exit "$?"',
    ].join("\n"),
  );

  const process = Bun.spawn(["/bin/bash", script], {
    detached: true,
    env: { ...globalThis.process.env, TMPDIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(process.stdout).text();
  const stderr = new Response(process.stderr).text();
  const targetAlive = (target: number): boolean => {
    try {
      globalThis.process.kill(target, 0);
      return true;
    } catch {
      return false;
    }
  };
  let brokerPid = 0;
  let nestedPid = 0;
  let commandPid = 0;
  const killGroup = (pid: number): void => {
    if (pid <= 0 || !targetAlive(-pid)) return;
    try {
      globalThis.process.kill(-pid, "SIGKILL");
    } catch {}
  };

  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        await Bun.file(brokerPidPath).exists() &&
        await Bun.file(nestedPidPath).exists() &&
        await Bun.file(commandPidPath).exists()
      ) {
        break;
      }
      await Bun.sleep(10);
    }
    expect(await Bun.file(brokerPidPath).exists()).toBe(true);
    expect(await Bun.file(nestedPidPath).exists()).toBe(true);
    expect(await Bun.file(commandPidPath).exists()).toBe(true);
    brokerPid = Number((await Bun.file(brokerPidPath).text()).trim());
    nestedPid = Number((await Bun.file(nestedPidPath).text()).trim());
    commandPid = Number((await Bun.file(commandPidPath).text()).trim());
    expect(new Set([brokerPid, nestedPid, commandPid]).size).toBe(3);
    expect(targetAlive(-process.pid)).toBe(true);
    expect(targetAlive(-brokerPid)).toBe(true);
    expect(await Bun.file(lateWritePath).exists()).toBe(false);
    expect(
      (await readdir(root)).filter((entry) =>
        entry.startsWith("orcats-command-output.") ||
        entry.startsWith("orcats-controller-capture.")
      ),
    ).toEqual([]);

    const signalledAt = Date.now();
    killGroup(process.pid);
    killGroup(brokerPid);
    expect(await process.exited).toBe(137);
    expect(Date.now() - signalledAt).toBeLessThan(1_500);
    await Promise.all([stdout, stderr]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        !targetAlive(-process.pid) &&
        !targetAlive(-brokerPid) &&
        !targetAlive(brokerPid) &&
        !targetAlive(nestedPid) &&
        !targetAlive(commandPid)
      ) {
        break;
      }
      await Bun.sleep(10);
    }
    expect({
      brokerGroupAlive: targetAlive(-brokerPid),
      brokerPidAlive: targetAlive(brokerPid),
      commandPidAlive: targetAlive(commandPid),
      harnessGroupAlive: targetAlive(-process.pid),
      nestedPidAlive: targetAlive(nestedPid),
    }).toEqual({
      brokerGroupAlive: false,
      brokerPidAlive: false,
      commandPidAlive: false,
      harnessGroupAlive: false,
      nestedPidAlive: false,
    });
    await Bun.sleep(100);
    expect(await Bun.file(lateWritePath).exists()).toBe(false);
    expect(
      (await readdir(root)).filter((entry) =>
        entry.startsWith("orcats-command-output.") ||
        entry.startsWith("orcats-controller-capture.")
      ),
    ).toEqual([]);
  } finally {
    killGroup(process.pid);
    killGroup(brokerPid);
    await process.exited;
    await Promise.all([stdout.catch(() => ""), stderr.catch(() => "")]);
    await rm(root, { recursive: true, force: true });
  }
}, 8_000);

test("captured bounded output reaps TERM INT and HUP groups promptly", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  const capture = extractShellFunction(launcher, "capture_before_deadline");
  const captureAction = extractShellFunction(launcher, "capture_command_output");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  expect(capture).toBeDefined();
  if (
    remaining === undefined ||
    bounded === undefined ||
    captureAction === undefined ||
    capture === undefined
  ) {
    return;
  }

  for (const { signal, status } of [
    { signal: "SIGTERM", status: 143 },
    { signal: "SIGINT", status: 130 },
    { signal: "SIGHUP", status: 129 },
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "orcats-captured-signal-"));
    const nested = join(root, "nested.sh");
    const script = join(root, "launcher.sh");
    const groupPidPath = join(root, "group.pid");
    const childPidPath = join(root, "child.pid");
    const capturedPath = join(root, "captured.txt");
    const concurrentFinalizerPath = join(root, "finalized-while-child-alive");
    await Bun.write(
      nested,
      [
        "#!/usr/bin/env bash",
        "printf started",
        `printf '%s\\n' "$$" > ${JSON.stringify(groupPidPath)}`,
        "sleep 2 &",
        'child_pid="$!"',
        `printf '%s\\n' "$child_pid" > ${JSON.stringify(childPidPath)}`,
        'wait "$child_pid"',
      ].join("\n"),
    );
    await Bun.write(
      script,
      [
        "#!/usr/bin/env bash",
        "set -u",
        "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
        remaining,
        bounded,
        captureAction,
        capture,
        "launcher_signal_status=0",
        `child_pid_path=${JSON.stringify(childPidPath)}`,
        `captured_path=${JSON.stringify(capturedPath)}`,
        `concurrent_finalizer_path=${JSON.stringify(concurrentFinalizerPath)}`,
        'captured=""',
        "finalize_probe() {",
        '  printf %s "$captured" > "$captured_path"',
        '  if [[ -f "$child_pid_path" ]]; then',
        '    child_pid=$(<"$child_pid_path")',
        '    if kill -0 "$child_pid" 2>/dev/null; then',
        '      printf \'alive\\n\' > "$concurrent_finalizer_path"',
        "    fi",
        "  fi",
        "}",
        "trap finalize_probe EXIT",
        ...launcherDeadlineLines(30000),
        'launcher_deadline_at_ms=$(( $(now_ms) + 30000 ))',
        `capture_before_deadline captured bash ${JSON.stringify(nested)}`,
        'exit "$?"',
      ].join("\n"),
    );

    try {
      const process = Bun.spawn(["bash", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const trackedPids = new Set<number>();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await Bun.file(childPidPath).exists()) break;
        await Bun.sleep(10);
      }
      expect(await Bun.file(childPidPath).exists()).toBe(true);
      for (const pid of collectOwnedHarnessPids(process.pid, script, trackedPids)) {
        trackedPids.add(pid);
      }
      expect(trackedPids.size).toBeGreaterThanOrEqual(4);
      const signalledAt = Date.now();
      process.kill(signal);
      process.kill(signal);
      expect(await process.exited).toBe(status);
      expect(Date.now() - signalledAt).toBeLessThan(1_500);
      await Bun.sleep(100);
      const childPid = (await Bun.file(childPidPath).text()).trim();
      expect(Bun.spawnSync(["kill", "-0", childPid]).exitCode).not.toBe(0);
      expect(await Bun.file(capturedPath).text()).toBe("started");
      expect(await Bun.file(concurrentFinalizerPath).exists()).toBe(false);
      expect([
        ...collectOwnedHarnessPids(process.pid, script, trackedPids),
      ]).toEqual([]);
    } finally {
      if (await Bun.file(groupPidPath).exists()) {
        const groupPid = (await Bun.file(groupPidPath).text()).trim();
        Bun.spawnSync(["kill", "-KILL", "--", `-${groupPid}`]);
      }
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("deadline controller preserves a signal arriving at the final wrapper wait", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const controller = extractShellFunction(launcher, "controller_run_until");
  expect(controller).toBeDefined();
  if (controller === undefined) return;
  const synchronized = controller.replace(
    '  wait "$controller_wrapper_pid" 2>/dev/null || true',
    [
      "  controller_record_signal TERM 143",
      '  wait "$controller_wrapper_pid" 2>/dev/null || true',
    ].join("\n"),
  );
  expect(synchronized).not.toBe(controller);

  const root = await mkdtemp(join(tmpdir(), "orcats-launcher-wait-signal-"));
  const script = join(root, "wait-signal.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      synchronized,
      "controller_started_seconds=0",
      "SECONDS=0",
      "controller_run_until 4 5 true",
      'exit "$?"',
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(143);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external signals stop and reap the active launcher process group before finalization", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const remaining = extractShellFunction(launcher, "remaining_launcher_ms");
  const bounded = extractShellFunction(launcher, "run_before_deadline");
  expect(remaining).toBeDefined();
  expect(bounded).toBeDefined();
  if (remaining === undefined || bounded === undefined) return;

  for (const { signal, status } of [
    { signal: "SIGTERM", status: 143 },
    { signal: "SIGINT", status: 130 },
    { signal: "SIGHUP", status: 129 },
  ] as const) {
    const root = await mkdtemp(join(tmpdir(), "orcats-launcher-signal-"));
    const nested = join(root, "nested.sh");
    const script = join(root, "launcher.sh");
    const groupPidPath = join(root, "group.pid");
    const childPidPath = join(root, "child.pid");
    const concurrentFinalizerPath = join(root, "finalized-while-child-alive");
    await Bun.write(
      nested,
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$$" > ${JSON.stringify(groupPidPath)}`,
        "sleep 30 &",
        'child_pid="$!"',
        `printf '%s\\n' "$child_pid" > ${JSON.stringify(childPidPath)}`,
        'wait "$child_pid"',
      ].join("\n"),
    );
    await Bun.write(
      script,
      [
        "#!/usr/bin/env bash",
        "set -u",
        "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
        remaining,
        bounded,
        "launcher_signal_status=0",
        `child_pid_path=${JSON.stringify(childPidPath)}`,
        `concurrent_finalizer_path=${JSON.stringify(concurrentFinalizerPath)}`,
        "finalize_probe() {",
        '  if [[ -f "$child_pid_path" ]]; then',
        '    child_pid=$(<"$child_pid_path")',
        '    if kill -0 "$child_pid" 2>/dev/null; then',
        '      printf \'alive\\n\' > "$concurrent_finalizer_path"',
        "    fi",
        "  fi",
        "}",
        "trap finalize_probe EXIT",
        ...launcherDeadlineLines(30000),
        'launcher_deadline_at_ms=$(( $(now_ms) + 30000 ))',
        `run_before_deadline bash ${JSON.stringify(nested)}`,
        'exit "$?"',
      ].join("\n"),
    );

    try {
      const process = Bun.spawn(["bash", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await Bun.file(childPidPath).exists()) break;
        await Bun.sleep(10);
      }
      expect(await Bun.file(childPidPath).exists()).toBe(true);
      process.kill(signal);
      expect(await process.exited).toBe(status);
      await Bun.sleep(100);
      const childPid = (await Bun.file(childPidPath).text()).trim();
      expect(Bun.spawnSync(["kill", "-0", childPid]).exitCode).not.toBe(0);
      expect(await Bun.file(concurrentFinalizerPath).exists()).toBe(false);
    } finally {
      if (await Bun.file(groupPidPath).exists()) {
        const groupPid = (await Bun.file(groupPidPath).text()).trim();
        Bun.spawnSync(["kill", "-KILL", "--", `-${groupPid}`]);
      }
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("timed-out ledger merge releases its owned lock and temp file", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const functions = [
    extractIssueLedgerValidator(launcher),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "run_before_deadline"),
    extractShellFunction(launcher, "merge_issue_ledger"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-ledger-timeout-"));
  const sourceLedger = join(root, "issues.jsonl");
  const candidateLedger = join(root, "candidate.jsonl");
  const baseLedger = join(root, "base.jsonl");
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  await Bun.write(baseLedger, `${seed}\n`);
  await Bun.write(sourceLedger, `${seed}\n`);
  await Bun.write(candidateLedger, `${seed}\n`);
  const script = join(root, "timeout.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      "dd() { sleep 5; }",
      'rm() { sleep 0.25; command rm "$@"; }',
      ...functions,
      `ledger=${JSON.stringify(sourceLedger)}`,
      'ledger_lock="${ledger}.lock"',
      ...launcherDeadlineLines(250),
      'launcher_deadline_at_ms=$(( $(now_ms) + 250 ))',
      `run_before_deadline merge_issue_ledger ${JSON.stringify(candidateLedger)} ${JSON.stringify(baseLedger)}`,
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(124);
    await Bun.sleep(100);
    expect(await Bun.file(`${sourceLedger}.lock`).exists()).toBe(false);
    const mergeTemps: string[] = [];
    for await (const path of new Bun.Glob("issues.jsonl.*.*").scan(root)) {
      mergeTemps.push(path);
    }
    expect(mergeTemps).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger merge recovers a lock owned by a dead process", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const functions = [
    extractIssueLedgerValidator(launcher),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "merge_issue_ledger"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-ledger-stale-lock-"));
  const sourceLedger = join(root, "issues.jsonl");
  const candidateLedger = join(root, "candidate.jsonl");
  const baseLedger = join(root, "base.jsonl");
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  const candidate = JSON.stringify({
    id: "stale-lock-candidate",
    runId: "stale-lock-test",
    at: "2026-07-14T16:00:00.000Z",
    classification: "gate",
    stage: "test",
    elapsedMs: 0,
    evidence: "candidate append",
    status: "open",
  });
  await Bun.write(baseLedger, `${seed}\n`);
  await Bun.write(sourceLedger, `${seed}\n`);
  await Bun.write(candidateLedger, `${seed}\n${candidate}\n`);
  await mkdir(`${sourceLedger}.lock`);
  await Bun.write(`${sourceLedger}.lock/owner.99999999.1`, "");
  const script = join(root, "recover.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      ...functions,
      `ledger=${JSON.stringify(sourceLedger)}`,
      'ledger_lock="${ledger}.lock"',
      ...launcherDeadlineLines(5000),
      'launcher_deadline_at_ms=$(( $(now_ms) + 5000 ))',
      `merge_issue_ledger ${JSON.stringify(candidateLedger)} ${JSON.stringify(baseLedger)}`,
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(0);
    expect(await Bun.file(`${sourceLedger}.lock`).exists()).toBe(false);
    expect(await Bun.file(sourceLedger).text()).toContain(candidate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger merge never removes a lock with a live owner", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const functions = [
    extractIssueLedgerValidator(launcher),
    extractShellFunction(launcher, "remaining_launcher_ms"),
    extractShellFunction(launcher, "merge_issue_ledger"),
  ];
  expect(functions.every((value) => value !== undefined)).toBe(true);
  if (functions.some((value) => value === undefined)) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-ledger-live-lock-"));
  const sourceLedger = join(root, "issues.jsonl");
  const candidateLedger = join(root, "candidate.jsonl");
  const baseLedger = join(root, "base.jsonl");
  const seed = (await Bun.file(".orca/improvement-loop/issues.jsonl").text())
    .split("\n")[0]!;
  await Bun.write(baseLedger, `${seed}\n`);
  await Bun.write(sourceLedger, `${seed}\n`);
  await Bun.write(candidateLedger, `${seed}\n`);
  await mkdir(`${sourceLedger}.lock`);
  const owner = Bun.spawn(["sleep", "30"]);
  const ownerMarker = `owner.${String(owner.pid)}.1`;
  await Bun.write(`${sourceLedger}.lock/${ownerMarker}`, "");
  const script = join(root, "preserve.sh");
  await Bun.write(
    script,
    [
      "#!/usr/bin/env bash",
      "set -u",
      "now_ms() { bun -e 'process.stdout.write(String(Date.now()))'; }",
      ...functions,
      `ledger=${JSON.stringify(sourceLedger)}`,
      'ledger_lock="${ledger}.lock"',
      ...launcherDeadlineLines(250),
      'launcher_deadline_at_ms=$(( $(now_ms) + 250 ))',
      `merge_issue_ledger ${JSON.stringify(candidateLedger)} ${JSON.stringify(baseLedger)}`,
    ].join("\n"),
  );

  try {
    const process = Bun.spawn(["bash", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(124);
    expect(await Bun.file(`${sourceLedger}.lock/${ownerMarker}`).exists()).toBe(
      true,
    );
    expect(Bun.spawnSync(["kill", "-0", String(owner.pid)]).exitCode).toBe(0);
  } finally {
    owner.kill("SIGKILL");
    await owner.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight explicitly runs every ignored workflow test", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.sh").text();
  const expected = [
    "bun test",
    "./.orca/workflows/codebase-improvement-lib.test.ts",
    "./.orca/workflows/codebase-improvement-runtime.test.ts",
    "./.orca/workflows/codebase-improvement-contract.test.ts",
    "./.orca/workflows/codebase-improvement-artifacts.test.ts",
  ].join(" ");
  expect(focusedPreflightCommand(source)).toBe(expected);
  const main = extractShellFunction(source, "main");
  expect(main).toBeDefined();
  expect(main).toContain("run_before_deadline run_preflight_gates");

  const mutation = source.replace(
    "    ./.orca/workflows/codebase-improvement-runtime.test.ts \\\n",
    "  : ./.orca/workflows/codebase-improvement-runtime.test.ts\n",
  );
  expect(mutation).not.toBe(source);
  expect(focusedPreflightCommand(mutation)).not.toBe(expected);
});

test("preflight validates real strict merge protection before deterministic gates", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.sh").text();
  const preflightGates = extractShellFunction(source, "run_preflight_gates");
  expect(preflightGates).toBeDefined();
  const protectionIndex =
    preflightGates?.indexOf("assert_required_merge_protection") ?? -1;
  const testIndex = preflightGates?.indexOf("bun test") ?? -1;
  expect(protectionIndex).toBeGreaterThanOrEqual(0);
  expect(testIndex).toBeGreaterThanOrEqual(0);
  expect(protectionIndex).toBeLessThan(testIndex);

  const missingProtection = source.replace(
    "  assert_required_merge_protection\n",
    "",
  );
  expect(missingProtection).not.toBe(source);
  const mutatedPreflightGates = extractShellFunction(
    missingProtection,
    "run_preflight_gates",
  );
  expect(mutatedPreflightGates).toBeDefined();
  expect(
    mutatedPreflightGates?.indexOf("assert_required_merge_protection") ?? -1,
  ).toBe(-1);

  const protectedMain = {
    required_status_checks: {
      strict: true,
      contexts: ["Verify"],
      checks: [{ context: "Verify", app_id: 15368 }],
    },
    enforce_admins: { enabled: true },
  };
  expect(await runMergeProtectionValidator(source, protectedMain)).toBe(0);
  for (const invalid of [
    {
      ...protectedMain,
      required_status_checks: {
        ...protectedMain.required_status_checks,
        strict: false,
      },
    },
    { ...protectedMain, enforce_admins: { enabled: false } },
    {
      ...protectedMain,
      required_status_checks: {
        ...protectedMain.required_status_checks,
        contexts: ["CI / Verify"],
        checks: [{ context: "CI / Verify", app_id: 15368 }],
      },
    },
    {
      ...protectedMain,
      required_status_checks: {
        strict: true,
        contexts: ["Verify"],
        checks: [{ context: "Verify", app_id: 42 }],
      },
    },
    {
      ...protectedMain,
      required_status_checks: {
        strict: true,
        contexts: ["Verify"],
        checks: [],
      },
    },
  ]) {
    expect(await runMergeProtectionValidator(source, invalid)).not.toBe(0);
  }
});

test("live revalidates merge protection before claiming preflight", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.sh").text();
  const main = extractShellFunction(source, "main");
  expect(main).toBeDefined();
  if (main === undefined) return;
  const liveGuard = main.indexOf(
    '  if [[ "$mode" == live ]]; then\n    run_before_deadline assert_required_merge_protection',
  );
  const claim = main.indexOf(
    'claim_preflight_attestation "$stable_preflight_path" "$claimed_preflight_path"',
  );
  expect(liveGuard).toBeGreaterThan(-1);
  expect(claim).toBeGreaterThan(liveGuard);
});

test("launcher copies itself without dropping executable mode", async () => {
  const path = ".orca/workflows/codebase-improvement.sh";
  const source = await Bun.file(path).text();
  const copyBlock = extractShellFunction(source, "copy_locked_artifacts");
  expect(copyBlock).toBeDefined();
  if (copyBlock === undefined) return;
  expect(copyBlock).toContain(
    'cp -p "$source_root/$path" "$worktree/$path"',
  );
  expect(extractShellArray(source, "locked_artifacts")).toContain(path);
  for (const required of [
    "codebase-improvement-runtime.ts",
    "codebase-improvement-runtime.test.ts",
    "codebase-improvement.sh",
  ]) {
    expect(source).toContain(required);
  }
  expect((await stat(path)).mode & 0o111).toBe(0o111);
});

test("launcher pins Codex before repository discovery and workflow execution", async () => {
  const launcher = await Bun.file(".orca/workflows/codebase-improvement.sh").text();
  const workflow = await Bun.file(".orca/workflows/codebase-improvement.ts").text();
  const runbook = await Bun.file(
    ".orca/workflows/codebase-improvement.run.md",
  ).text();
  const compactRunbook = runbook.replace(/\s+/g, " ");
  const main = extractShellFunction(launcher, "main");
  expect(main).toBeDefined();
  if (main === undefined) return;
  const requestedBackend = main.indexOf(
    'requested_backend="${ORCA_BACKEND:-}"',
  );
  const rejection = main.indexOf(
    'unsupported proving backend: ${requested_backend}; expected codex',
  );
  const pin = main.indexOf("export ORCA_BACKEND=codex");
  const scriptParent = main.indexOf('script_parent="${script_source%/*}"');
  const repositoryDiscovery = main.indexOf(
    'script_dir=$(cd "$script_parent" && pwd -P)',
  );

  expect(requestedBackend).toBeGreaterThan(-1);
  expect(rejection).toBeGreaterThan(requestedBackend);
  expect(pin).toBeGreaterThan(rejection);
  expect(scriptParent).toBeGreaterThan(pin);
  expect(repositoryDiscovery).toBeGreaterThan(scriptParent);
  expect(main).toContain(
    'if [[ -n "$requested_backend" && "$requested_backend" != codex ]]; then',
  );
  expect(main).toContain("return 64");
  expect(workflow).toContain('selectBackend({ default: "codex" })');
  expect(workflow).toContain('activeSelected.tag !== "codex"');
  expect(workflow).toContain("proving workflow requires codex backend");
  expect(launcher).not.toContain("--backend codex");
  expect(compactRunbook).toContain(
    "rejects any non-empty `ORCA_BACKEND` value other than `codex`",
  );
  expect(compactRunbook).toContain("exports `ORCA_BACKEND=codex`");
  expect(compactRunbook).toContain(
    "revalidates the selected backend tag before agent work",
  );
});

test("workflow rejects non-Codex before monitor or repository work", async () => {
  const root = await mkdtemp(join(tmpdir(), "orcats-backend-guard-"));
  const workflow = resolve(".orca/workflows/codebase-improvement.ts");
  try {
    const child = Bun.spawn(["bun", workflow], {
      cwd: root,
      env: {
        ...process.env,
        ORCA_BACKEND: "claude",
        ORCA_IMPROVEMENT_RUN_ID: "",
        ORCA_IMPROVEMENT_STARTED_AT_MS: "",
        ORCA_IMPROVEMENT_PREFLIGHT_PATH: join(root, "must-not-read.json"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;
    expect(exitCode).not.toBe(0);
    expect(output).toContain(
      "proving workflow requires codex backend; received claude",
    );
    expect(output).not.toContain("ORCA_IMPROVEMENT_RUN_ID");
    expect(output).not.toContain("must-not-read.json");
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher binds the retained branch into every workflow failure", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const invocation = extractShellFunction(launcher, "run_live_workflow");
  expect(invocation).toBeDefined();
  if (invocation === undefined) return;
  expect(invocation).toContain('ORCA_IMPROVEMENT_RUN_ID="$run_id" \\');
  expect(invocation).toContain('ORCA_IMPROVEMENT_BRANCH="$branch" \\');
  expect(invocation.indexOf('ORCA_IMPROVEMENT_BRANCH="$branch"')).toBeLessThan(
    invocation.indexOf("orca-run.sh"),
  );
});

test("launcher pins a freshly built source runtime", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const runbook = await Bun.file(
    ".orca/workflows/codebase-improvement.run.md",
  ).text();
  const main = extractShellFunction(launcher, "main");
  const buildRuntime = extractShellFunction(launcher, "build_runtime");
  expect(main).toBeDefined();
  expect(buildRuntime).toBeDefined();
  if (main === undefined || buildRuntime === undefined) return;
  const buildIndex = buildRuntime.indexOf("bun run build:binary");
  const buildCallIndex = main.indexOf("run_before_deadline build_runtime");
  const headIndex = main.indexOf(
    'capture_before_deadline runtime_head git -C "$source_root" rev-parse HEAD',
  );
  const fetchIndex = main.indexOf(
    'git -C "$source_root" fetch origin main',
  );
  const preflightIndex = main.indexOf(
    'if [[ "$mode" == preflight ]]',
    buildCallIndex,
  );
  expect(buildIndex).toBeGreaterThan(-1);
  expect(buildCallIndex).toBeGreaterThan(-1);
  expect(headIndex).toBeGreaterThan(-1);
  expect(headIndex).toBeLessThan(buildCallIndex);
  expect(buildCallIndex).toBeLessThan(fetchIndex);
  expect(buildCallIndex).toBeLessThan(preflightIndex);
  expect(launcher).toContain(
    'GIT_NO_REPLACE_OBJECTS=1 git -C "$source_root" \\',
  );
  expect(launcher).toContain('archive --format=tar "$runtime_head"');
  expect(launcher).toContain('runtime_path="$run_dir/runtime/orcats"');
  expect(launcher).toContain('PATH="$(dirname "$runtime_path"):$PATH"');
  for (const evidence of [
    "runtimePath",
    "runtimeHead",
    "runtimeSha256",
    "runtimeVersion",
  ]) {
    expect(launcher).toContain(evidence);
  }
  expect(runbook).toContain("builds and pins a clean archive of source HEAD");
  expect(runbook).toContain("ignores a global Orcats installation");
});

test("launcher builds runtime from committed HEAD instead of dirty source bytes", async () => {
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  const buildRuntime = extractShellFunction(launcher, "build_runtime");
  expect(buildRuntime).toBeDefined();
  if (buildRuntime === undefined) return;

  const root = await mkdtemp(join(tmpdir(), "orcats-runtime-provenance-"));
  const sourceRoot = join(root, "source");
  const runDirectory = join(root, "run");
  const fakeBin = join(root, "bin");
  const fakeBun = join(fakeBin, "bun");
  const runtimePath = join(runDirectory, "runtime", "orcats");
  const harness = join(root, "build-runtime.sh");
  const run = async (args: string[]): Promise<string> => {
    const child = Bun.spawn(args, {
      cwd: sourceRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    return stdout.trim();
  };

  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await Bun.write(join(sourceRoot, "runtime-input.txt"), "committed\n");
    await run(["git", "init", "-q"]);
    await run(["git", "add", "runtime-input.txt"]);
    await run([
      "git",
      "-c",
      "user.name=Orcats Test",
      "-c",
      "user.email=orcats@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "runtime fixture",
    ]);
    const runtimeHead = await run(["git", "rev-parse", "HEAD"]);
    await Bun.write(join(sourceRoot, "runtime-input.txt"), "substituted\n");
    await run(["git", "add", "runtime-input.txt"]);
    const replacementTree = await run(["git", "write-tree"]);
    const replacementCommit = await run([
      "git",
      "-c",
      "user.name=Orcats Test",
      "-c",
      "user.email=orcats@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit-tree",
      replacementTree,
      "-p",
      runtimeHead,
      "-m",
      "replacement runtime fixture",
    ]);
    await run(["git", "replace", runtimeHead, replacementCommit]);
    await Bun.write(join(sourceRoot, "runtime-input.txt"), "dirty\n");
    await Bun.write(
      fakeBun,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'case "$1 $2" in',
        '  "install --frozen-lockfile") ;;',
        '  "run build:binary")',
        "    mkdir -p dist",
        "    cp runtime-input.txt dist/orcats",
        "    chmod +x dist/orcats",
        "    ;;",
        "  *) exit 64 ;;",
        "esac",
      ].join("\n"),
    );
    await chmod(fakeBun, 0o755);
    await Bun.write(
      harness,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `source_root=${JSON.stringify(sourceRoot)}`,
        `runtime_head=${JSON.stringify(runtimeHead)}`,
        `run_dir=${JSON.stringify(runDirectory)}`,
        `runtime_path=${JSON.stringify(runtimePath)}`,
        buildRuntime,
        "build_runtime",
      ].join("\n"),
    );

    const child = Bun.spawn(["bash", harness], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(await Bun.file(runtimePath).exists()).toBe(true);
    expect(await Bun.file(runtimePath).text()).toBe("committed\n");
    expect(await Bun.file(join(sourceRoot, "runtime-input.txt")).text()).toBe(
      "dirty\n",
    );
    expect(await Bun.file(join(sourceRoot, "dist", "orcats")).exists()).toBe(
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher finalizes setup, preflight, and live exits atomically", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.sh").text();
  const finalizer = extractShellFunction(source, "finalize");
  const main = extractShellFunction(source, "main");
  expect(finalizer).toBeDefined();
  expect(main).toBeDefined();
  for (const required of [
    'local original_status="$?"',
    "trap - EXIT",
    "set +e",
    '$worktree/.orca/monitoring',
    '$worktree/.orca/improvement-loop/runs/$run_id',
    '$worktree/.orca/improvement-loop/issues.jsonl',
    'latest_tmp="${latest}.tmp.$$"',
    'render_latest_evidence_action',
    'atomic_rename_before_deadline',
    'validate_latest_publication_file',
    'record_finalize_failure()',
    'exit "$final_status"',
  ]) {
    expect(finalizer).toContain(required);
  }
  for (const phase of ["phase=setup", "phase=preflight", "phase=live"]) {
    expect(source).toContain(phase);
  }
  const finalDeadline = finalizer.lastIndexOf(
    "finalization exceeded profile deadline",
  );
  const latestRender = finalizer.indexOf(
    "if ! render_latest_evidence; then",
    finalDeadline,
  );
  expect(latestRender).toBeGreaterThan(-1);
  expect(finalDeadline).toBeLessThan(latestRender);
  expect(finalizer).not.toContain("ended_at_ms=$(now_ms)");
  expect(
    finalizer.match(/capture_before_deadline ended_at_ms now_ms/g),
  ).toHaveLength(2);
  expect(main).toContain('git -C "$source_root" fetch origin main');
  const finalizerTrap = source.indexOf("trap finalize EXIT");
  const mainInvocation = source.indexOf('main "$@"', finalizerTrap);
  expect(finalizerTrap).toBeGreaterThan(-1);
  expect(mainInvocation).toBeGreaterThan(finalizerTrap);
});

test("launcher finalizer fails closed without hiding a prior failure", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.sh").text();
  const finalizer = extractShellFunction(source, "finalize");
  expect(finalizer).toBeDefined();
  if (finalizer === undefined) return;

  const successfulBody = await runFinalizerHarness(source, 0);
  expect(successfulBody.exitCode).toBe(74);
  expect(successfulBody.stderr).toContain(
    "finalize failed: copy monitor evidence",
  );
  expect(successfulBody.stderr).not.toContain("command not found");
  expect(successfulBody.latest?.exitCode).toBe(successfulBody.exitCode);

  const failedBody = await runFinalizerHarness(source, 42);
  expect(failedBody.exitCode).toBe(42);
  expect(failedBody.stderr).toContain(
    "finalize failed: copy monitor evidence",
  );
  expect(failedBody.stderr).not.toContain("command not found");
  expect(failedBody.latest?.exitCode).toBe(failedBody.exitCode);
}, 15_000);

test("runbook names exact gates and merge proof", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.run.md").text();
  for (const required of [
    "bun test",
    "bun run lint",
    "bun run verify",
    "all four ignored workflow test suites",
    "CI / Verify",
    "no checks reported",
    "10 minutes",
    "30 minutes",
    "45 minutes",
    "isDraft=false",
    "count only their active work",
    "ORCA_IMPROVEMENT_BRANCH",
    "Every post-turn test-diff and changed-path Git probe",
    "report.remoteChecks",
    "checkedAt",
    "monitorPath",
    "exit\n`74`",
  ]) {
    expect(source).toContain(required);
  }
});

test("design records current scout scope and committed range contracts", async () => {
  const design = await Bun.file(
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ).text();
  const selectedControlLine = design.match(/^selectedControl: (.+)$/m)?.[1];
  expect(selectedControlLine?.split(", ")).toEqual([
    "candidateId",
    "brief",
    "testName",
    "productionPath",
  ]);

  const verification = design.slice(
    design.indexOf("### 8. Final Verification"),
    design.indexOf("### 9. Delivery"),
  );
  expect(verification).toContain("- exactly two to three changed paths;");
  expect(verification).not.toContain("one through three changed paths");

  const proofIntegrity = design.slice(
    design.indexOf("## Proof Integrity"),
    design.indexOf("Before the first live run:"),
  );
  const normalizedProofIntegrity = proofIntegrity.replace(/\s+/g, " ");
  expect(normalizedProofIntegrity).toContain(
    "full parent-to-head `git diff --name-only -z <parent SHA> <head SHA> --` path query",
  );
  expect(normalizedProofIntegrity).not.toContain("diff-tree");
});

test("runbook names the deterministic scout packet and unchanged timing", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.run.md").text();
  for (const required of [
    "10 seconds for deterministic gathering",
    "80 seconds total",
    "two fresh synthesis conversations",
    "each limited to 40 seconds",
    "only when the first ends in its exact timeout cancellation",
    "10 seconds",
    "synthesis attempt records",
    "10,000",
    "`File: <path>` section header",
    "rankedCandidateIds",
    "evidence digest",
    "no-tool failure",
    "100-second scout allocation",
    "560-second allocation",
    "600-second launcher-to-merge ceiling",
    "unused positive-overlap test for each selected source that has one",
    "Files without hotspots contribute up to their first 40 lines.",
    "16 lines before and after each hotspot",
    "one rendered line from every allowed production path",
    "unique `testPath`",
    "exclusive production path",
    "No non-target `tests/**` path",
    "Reserved source-test pairs",
    "structured rendered-line markers",
    "prefix text cannot satisfy a citation",
  ]) {
    expect(source).toContain(required);
  }
});

test("proof documents record Correction 44 compact-scout evidence", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    for (const required of [
      "Correction 44",
      "20260717000416-46151",
      "73,245",
      "9,998",
      "10,000-character",
      "96c1c4df54aa386adef1ceea1154b4925476095249966eafe0b9988351f6274a",
      "fresh explicit authorization",
    ]) {
      expect(source, proofPath).toContain(required);
    }
  }
});

test("proof documents record Correction 45 audit fixes", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const ledgerSha256 =
    "1ebfb5e0bec4d7f3fd4db71c8550ab7193e181e52c733ae8850bbcd7a0f261f1";
  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const firstAuditIndex = source.lastIndexOf(
      "audit-scout-validation-reserve-deadline",
    );
    const correction45Index = source.lastIndexOf(
      "Correction 45",
      firstAuditIndex,
    );
    const correction44Index = source.lastIndexOf(
      "Correction 44",
      correction45Index,
    );
    expect(correction45Index, proofPath).toBeGreaterThan(correction44Index);
    const correction45 = source.slice(correction45Index);
    for (const required of [
      "Correction 45",
      "audit-scout-validation-reserve-deadline",
      "audit-candidate-citation-token-boundary",
      "audit-current-scout-plan-evidence-cap",
      "132 rows",
      ledgerSha256,
      "10-second validation",
      "exact citation-token boundaries",
      "fresh explicit authorization",
    ]) {
      expect(correction45, proofPath).toContain(required);
    }
    const normalized = correction45.toLowerCase().replace(/\s+/g, " ");
    for (const pending of [
      "full verification",
      "new manifest",
      "three fresh audits",
      "preflight",
      "live run",
      "pending",
    ]) {
      expect(normalized, proofPath).toContain(pending);
    }
    expect(normalized, proofPath).toContain("prompt-size");
    expect(normalized, proofPath).toContain("reasoning-effort");
    expect(normalized, proofPath).toContain("unchanged");
  }

  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  const ledgerLines = ledger.trimEnd().split("\n");
  const correction45Lines = ledgerLines.slice(0, 132);
  const rows = correction45Lines.map(
    (line) => JSON.parse(line) as { id: string },
  );
  expect(rows).toHaveLength(132);
  expect(new Set(rows.map((row) => row.id)).size).toBe(132);
  expect(
    createHash("sha256")
      .update(`${correction45Lines.slice(0, 129).join("\n")}\n`)
      .digest("hex"),
  ).toBe("96c1c4df54aa386adef1ceea1154b4925476095249966eafe0b9988351f6274a");
  expect(
    createHash("sha256")
      .update(`${correction45Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(ledgerSha256);
});

test("proof documents record Correction 46 harness timeout fix", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const rowId = "review-terminal-package-lock-harness-timeout";
  const prefixSha256 =
    "1ebfb5e0bec4d7f3fd4db71c8550ab7193e181e52c733ae8850bbcd7a0f261f1";
  const ledgerSha256 =
    "07da8ff81c2d550629961d9d0d5a2f9d3b7a9dfeaf8647a972b899f9fa5ef347";
  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const rowIndex = source.lastIndexOf(rowId);
    const correction46Index = source.lastIndexOf("Correction 46", rowIndex);
    const correction45Index = source.lastIndexOf(
      "Correction 45",
      correction46Index,
    );
    expect(correction46Index, proofPath).toBeGreaterThan(correction45Index);
    const correction46 = source.slice(correction46Index);
    for (const required of [
      "Correction 46",
      rowId,
      "133 rows",
      ledgerSha256,
      "15-second",
      "terminal package-lock drift blocks success publication",
      "fresh explicit authorization",
    ]) {
      expect(correction46, proofPath).toContain(required);
    }
    const normalized = correction46.toLowerCase().replace(/\s+/g, " ");
    for (const pending of [
      "full verification",
      "new manifest",
      "three fresh audits",
      "preflight",
      "live run",
      "pending",
    ]) {
      expect(normalized, proofPath).toContain(pending);
    }
  }

  const artifactSource = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const targetStart = artifactSource.indexOf(
    'test("terminal package-lock drift blocks success publication"',
  );
  const nextTestStart = artifactSource.indexOf("\ntest(", targetStart + 1);
  expect(targetStart).toBeGreaterThan(-1);
  expect(nextTestStart).toBeGreaterThan(targetStart);
  expect(
    artifactSource.slice(targetStart, nextTestStart).trimEnd().endsWith(
      "}, 15_000);",
    ),
  ).toBe(true);

  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  const correction46Lines = ledger.trimEnd().split("\n").slice(0, 133);
  const rows = correction46Lines.map(
    (line) => JSON.parse(line) as { id: string },
  );
  expect(rows).toHaveLength(133);
  expect(new Set(rows.map((row) => row.id)).size).toBe(133);
  expect(
    createHash("sha256")
      .update(`${correction46Lines.slice(0, 132).join("\n")}\n`)
      .digest("hex"),
  ).toBe(prefixSha256);
  expect(rows.at(-1)).toEqual({
    id: rowId,
    runId: "correction46-verification-20260717",
    at: "2026-07-17T02:48:32.000Z",
    classification: "gate",
    stage: "correction46-verification",
    elapsedMs: 0,
    evidence:
      'The "terminal package-lock drift blocks success publication" test runs three subprocess harnesses under the default 5-second Bun timeout, timed out in the aggregate gate, and took 4.98s isolated.',
    backend: "codex",
    worktree:
      "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
    branch: "meta/codebase-improvement-loop",
    monitorPath: "independent-audit:no-monitor",
    status: "open",
  });
  expect(
    createHash("sha256")
      .update(`${correction46Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(ledgerSha256);
});

test("proof documents record Correction 47 finalizer harness timeout policy", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const rowId = "review-finalizer-harness-timeout-policy";
  const prefixSha256 =
    "07da8ff81c2d550629961d9d0d5a2f9d3b7a9dfeaf8647a972b899f9fa5ef347";
  const ledgerSha256 =
    "24cb771218c8ff8839397eb12e64588b649980c09928249dfc7aa3f4ae84e43f";
  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const rowIndex = source.lastIndexOf(rowId);
    const correction47Index = source.lastIndexOf("Correction 47", rowIndex);
    const correction46Index = source.lastIndexOf(
      "Correction 46",
      correction47Index,
    );
    expect(correction47Index, proofPath).toBeGreaterThan(correction46Index);
    const correction47 = source.slice(correction47Index);
    for (const required of [
      "Correction 47",
      rowId,
      "134 rows",
      ledgerSha256,
      "31 finalizer-harness tests",
      "33 static calls",
      "52 loop-expanded subprocess runs",
      "24 default-timeout tests",
      "15-second",
      "30-second",
      "rejects indirect harness references",
      "exactly one six-scenario 30-second exception",
      "successful terminal publication validates monitor identity and outcome",
      "fresh explicit authorization",
    ]) {
      expect(correction47, proofPath).toContain(required);
    }
    const normalized = correction47.toLowerCase().replace(/\s+/g, " ");
    for (const pending of [
      "full verification",
      "new manifest",
      "three fresh audits",
      "preflight",
      "live run",
      "pending",
    ]) {
      expect(normalized, proofPath).toContain(pending);
    }
  }

  const artifactSource = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const inspection = inspectFinalizerHarnessTimeouts(artifactSource);
  expect(inspection.testCount).toBe(42);
  expect(inspection.callCount).toBe(78);
  expect(inspection.issues).toEqual([]);

  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  const correction47Lines = ledger.trimEnd().split("\n").slice(0, 134);
  const rows = correction47Lines.map(
    (line) => JSON.parse(line) as { id: string },
  );
  expect(rows).toHaveLength(134);
  expect(new Set(rows.map((row) => row.id)).size).toBe(134);
  expect(
    createHash("sha256")
      .update(`${correction47Lines.slice(0, 133).join("\n")}\n`)
      .digest("hex"),
  ).toBe(prefixSha256);
  expect(rows.at(-1)).toEqual({
    id: rowId,
    runId: "correction47-verification-20260717",
    at: "2026-07-17T03:26:51.000Z",
    classification: "gate",
    stage: "correction47-verification",
    elapsedMs: 0,
    evidence:
      'The "successful terminal publication validates monitor identity and outcome" test timed out at 5003.72ms under Bun\'s default 5-second timeout; 24 of 31 finalizer-harness tests still lacked explicit timeouts, proving a class-wide policy gap.',
    backend: "codex",
    worktree:
      "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
    branch: "meta/codebase-improvement-loop",
    monitorPath: "independent-audit:no-monitor",
    status: "open",
  });
  expect(
    createHash("sha256")
      .update(`${correction47Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(ledgerSha256);
});

test("proof documents record Correction 48 unconditional scenario policy", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const rowId = "audit-finalizer-harness-conditional-skip";
  const prefixSha256 =
    "24cb771218c8ff8839397eb12e64588b649980c09928249dfc7aa3f4ae84e43f";
  const ledgerSha256 =
    "f42621dd2b4400f075ff182be37a6f2953ce9ef1f47fc3b4b2ed2d6167bc22d3";
  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const rowIndex = source.lastIndexOf(rowId);
    const correction48Index = source.lastIndexOf("Correction 48", rowIndex);
    const correction47Index = source.lastIndexOf(
      "Correction 47",
      correction48Index,
    );
    expect(correction47Index, proofPath).toBeGreaterThan(-1);
    expect(correction48Index, proofPath).toBeGreaterThan(correction47Index);
    const correction48 = source.slice(correction48Index);
    for (const required of [
      "Correction 48",
      rowId,
      "135 rows",
      ledgerSha256,
      "conditional `continue`",
      "unconditional top-level harness call",
      "six scenarios",
      "exact six unique mutation literals",
      "spread elements",
      "fresh explicit authorization",
    ]) {
      expect(correction48, proofPath).toContain(required);
    }
    const normalized = correction48.toLowerCase().replace(/\s+/g, " ");
    for (const pending of [
      "full verification",
      "new manifest",
      "three fresh audits",
      "preflight",
      "live run",
      "pending",
    ]) {
      expect(normalized, proofPath).toContain(pending);
    }
  }

  const artifactSource = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const inspection = inspectFinalizerHarnessTimeouts(artifactSource);
  expect(inspection.testCount).toBe(42);
  expect(inspection.callCount).toBe(78);
  expect(inspection.expandedRunCount).toBe(95);
  expect(inspection.longTimeoutScenarioCount).toBe(6);
  expect(inspection.issues).toEqual([]);

  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  const ledgerLines = ledger.trimEnd().split("\n");
  const correction48Lines = ledgerLines.slice(0, 135);
  const rows = correction48Lines.map(
    (line) => JSON.parse(line) as { id: string },
  );
  expect(rows).toHaveLength(135);
  expect(new Set(rows.map((row) => row.id)).size).toBe(135);
  expect(
    createHash("sha256")
      .update(`${correction48Lines.slice(0, 134).join("\n")}\n`)
      .digest("hex"),
  ).toBe(prefixSha256);
  expect(rows.at(-1)).toEqual({
    id: rowId,
    runId: "correction48-verification-20260717",
    at: "2026-07-17T04:06:06.000Z",
    classification: "gate",
    stage: "correction48-verification",
    elapsedMs: 0,
    evidence:
      "The frozen-byte policy audit proved a conditional continue could skip one of the six 30-second finalizer scenarios while preserving 31 tests, 33 calls, 52 expanded runs, and an empty policy issue list.",
    backend: "codex",
    worktree:
      "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
    branch: "meta/codebase-improvement-loop",
    monitorPath: "independent-audit:no-monitor",
    status: "open",
  });
  expect(
    createHash("sha256")
      .update(`${correction48Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(ledgerSha256);
});

const correction49ProofRowIds = [
  "audit-finalizer-harness-scenario-binding",
  "audit-finalizer-harness-global-loop-control",
  "audit-finalizer-harness-option-integrity",
  "audit-finalizer-harness-scenario-identity",
  "audit-finalizer-harness-callable-identity",
] as const;

test("proof documents record Correction 49 exact harness scenario policy", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const rowIds = correction49ProofRowIds;
  const prefixSha256 =
    "f42621dd2b4400f075ff182be37a6f2953ce9ef1f47fc3b4b2ed2d6167bc22d3";
  const ledgerSha256 =
    "401a417c41f1c24aaef1fdf8990ae1c049c8d7affcb822e8d552fc2372d463e3";
  const sectionSha256ByPath = new Map([
    [
      proofPaths[0],
      "84f5977603710e81a49cadff4256df028ab5c60242d2ac8961a4348b07f6f676",
    ],
    [
      proofPaths[1],
      "5c82cdc2126a60e41d48546eaef76751d984327afbd4c486cf0600bcf262f308",
    ],
    [
      proofPaths[2],
      "00b8a416125476b555dacaec3eff41e1bbdbd18d2eb28e7867ebef9b04a30efc",
    ],
    [
      proofPaths[3],
      "14d96df0e020d7498c5372c8b953c7baee56c42a2096da24af279d2ddb26ceda",
    ],
  ]);
  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(source, 49, rowIds, 50);
    expect(inspection.issues, proofPath).toEqual([]);
    expect(inspection.sha256, proofPath).toBe(
      sectionSha256ByPath.get(proofPath),
    );
  }
  const suffixedCorrection49Row = (
    await Bun.file(proofPaths[0]).text()
  ).replace(
    "- `audit-finalizer-harness-callable-identity`:",
    "- `audit-finalizer-harness-callable-identity-suffix`:",
  );
  expect(
    inspectCorrectionProofSection(suffixedCorrection49Row, 49, rowIds, 50).issues,
  ).toEqual([
    "Correction 49 row anchor audit-finalizer-harness-callable-identity count must be 1, received 0",
  ]);

  const artifactSource = await Bun.file(
    ".orca/workflows/codebase-improvement-artifacts.test.ts",
  ).text();
  const inspection = inspectFinalizerHarnessTimeouts(artifactSource);
  expect(inspection.testCount).toBe(42);
  expect(inspection.callCount).toBe(78);
  expect(inspection.expandedRunCount).toBe(95);
  expect(inspection.longTimeoutScenarioCount).toBe(6);
  expect(inspection.issues).toEqual([]);

  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  const ledgerLines = ledger.trimEnd().split("\n");
  const correction49Lines = ledgerLines.slice(0, 140);
  const rows = correction49Lines.map(
    (line) => JSON.parse(line) as { id: string },
  );
  expect(rows).toHaveLength(140);
  expect(new Set(rows.map((row) => row.id)).size).toBe(140);
  expect(
    createHash("sha256")
      .update(`${correction49Lines.slice(0, 135).join("\n")}\n`)
      .digest("hex"),
  ).toBe(prefixSha256);
  expect(rows.slice(-5)).toEqual([
    {
      id: rowIds[0],
      runId: "correction49-verification-20260717",
      at: "2026-07-17T05:21:24.000Z",
      classification: "gate",
      stage: "correction49-verification",
      elapsedMs: 0,
      evidence:
        "Frozen-byte review proved the six-scenario loop could run the report mutation six times because the loop binding was not tied to terminalEvidenceMutation.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: rowIds[1],
      runId: "correction49-verification-20260717",
      at: "2026-07-17T05:21:25.000Z",
      classification: "gate",
      stage: "correction49-verification",
      elapsedMs: 0,
      evidence:
        "Review proved ordinary harness loops could skip declared scenarios through continue, returns before or after the first call, or a swallowing try/catch while static counts stayed unchanged.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: rowIds[2],
      runId: "correction49-verification-20260717",
      at: "2026-07-17T05:21:26.000Z",
      classification: "gate",
      stage: "correction49-verification",
      elapsedMs: 0,
      evidence:
        "Review proved spreads, computed duplicate keys, pre-call reassignment, and effectful option evaluation could override a valid selector while policy counts and assertions stayed green.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: rowIds[3],
      runId: "correction49-verification-20260717",
      at: "2026-07-17T05:21:27.000Z",
      classification: "gate",
      stage: "correction49-verification",
      elapsedMs: 0,
      evidence:
        "Review proved named arrays could be emptied and inline arrays could use empty spreads or duplicate scenarios while static expanded-run counts and target assertions still passed.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: rowIds[4],
      runId: "correction49-verification-20260717",
      at: "2026-07-17T05:21:28.000Z",
      classification: "gate",
      stage: "correction49-verification",
      elapsedMs: 0,
      evidence:
        "Review proved nested fake runFinalizerHarness declarations or temporary terminalMonitorFixture reassignment could replace real behavior without changing scenario source or call counts.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
  ]);
  expect(
    createHash("sha256")
      .update(`${correction49Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(ledgerSha256);
});


function replaceAfterHeading(
  source: string,
  heading: string,
  from: string,
  to: string,
): string {
  const headingIndex = source.indexOf(heading);
  if (headingIndex < 0) {
    throw new Error(`missing heading: ${heading}`);
  }
  const tail = source.slice(headingIndex);
  if (!tail.includes(from)) {
    throw new Error(`missing mutation target after ${heading}: ${from}`);
  }
  return source.slice(0, headingIndex) + tail.replace(from, to);
}

function correctionHeadingIndices(
  source: string,
  correctionNumber: number,
): number[] {
  const heading = new RegExp(
    `^(?:#{2,3}[ \\t]+|-[ \\t]+\\[x\\][ \\t]+(?:\\*\\*)?)[^\\r\\n\\u2028\\u2029]*\\bCorrection[ \\t]+${correctionNumber}\\b[^\\r\\n\\u2028\\u2029]*$`,
    "gm",
  );
  return [
    ...source.matchAll(heading),
  ].flatMap((match) => (match.index === undefined ? [] : [match.index]));
}

function exactCorrectionHeadingIndices(
  source: string,
  correctionNumber: number,
): number[] {
  const heading = `## Correction ${correctionNumber}`;
  const indices: number[] = [];
  let offset = 0;
  while (offset <= source.length - heading.length) {
    const index = source.indexOf(heading, offset);
    if (index < 0) break;
    const startsOnLfBoundary = index === 0 || source[index - 1] === "\n";
    const headingEnd = index + heading.length;
    const endsOnLfBoundary =
      headingEnd === source.length || source[headingEnd] === "\n";
    if (startsOnLfBoundary && endsOnLfBoundary) indices.push(index);
    offset = index + heading.length;
  }
  return indices;
}

type CorrectionProofHeadingPolicy = {
  current?: "broad" | "exact";
  next?: "broad" | "exact";
};

type CorrectionProofInspection = {
  issues: string[];
  section?: string;
  body?: string;
  sha256?: string;
};

function escapeProofRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function correctionRowAnchorIndices(source: string, rowId: string): number[] {
  const escapedRowId = escapeProofRegExp(rowId);
  const anchor = new RegExp(
    `^[ \\t]*-[ \\t]+\\\`${escapedRowId}\\\`:[^\\n]*$`,
    "gm",
  );
  return [...source.matchAll(anchor)].flatMap((match) =>
    match.index === undefined ? [] : [match.index],
  );
}

function inspectCorrectionProofSection(
  source: string,
  correctionNumber: number,
  orderedRowIds: readonly string[],
  nextCorrectionNumber?: number,
  headingPolicy: CorrectionProofHeadingPolicy = {},
): CorrectionProofInspection {
  const issues: string[] = [];
  const headings =
    headingPolicy.current === "exact"
      ? exactCorrectionHeadingIndices(source, correctionNumber)
      : correctionHeadingIndices(source, correctionNumber);
  if (headings.length !== 1) {
    issues.push(
      `Correction ${correctionNumber} heading count must be 1, received ${headings.length}`,
    );
  }
  const rowIndices = orderedRowIds.map((rowId) => {
    const indices = correctionRowAnchorIndices(source, rowId);
    if (indices.length !== 1) {
      issues.push(
        `Correction ${correctionNumber} row anchor ${rowId} count must be 1, received ${indices.length}`,
      );
    }
    return indices[0];
  });
  const nextHeadings =
    nextCorrectionNumber === undefined
      ? []
      : headingPolicy.next === "exact"
        ? exactCorrectionHeadingIndices(source, nextCorrectionNumber)
        : correctionHeadingIndices(source, nextCorrectionNumber);
  if (nextCorrectionNumber !== undefined && nextHeadings.length !== 1) {
    issues.push(
      `Correction ${nextCorrectionNumber} boundary heading count must be 1, received ${nextHeadings.length}`,
    );
  }
  if (issues.length > 0) return { issues };

  const headingIndex = headings[0]!;
  const boundaryIndex = nextHeadings[0] ?? source.length;
  const orderedIndices = [headingIndex, ...rowIndices, boundaryIndex];
  if (
    orderedIndices.some(
      (index, position) =>
        position > 0 && index! <= orderedIndices[position - 1]!,
    )
  ) {
    issues.push(
      `Correction ${correctionNumber} order must be heading < ordered row anchors < ${nextCorrectionNumber === undefined ? "EOF" : `Correction ${nextCorrectionNumber}`}`,
    );
    return { issues };
  }

  const section = source.slice(headingIndex, boundaryIndex);
  const headingEnd = section.indexOf("\n");
  const body = headingEnd < 0 ? "" : section.slice(headingEnd + 1);
  return {
    issues,
    section,
    body,
    sha256: createHash("sha256").update(section).digest("hex"),
  };
}

function correctionSectionLockIssues(
  inspection: CorrectionProofInspection,
  correctionNumber: number,
  expectedSha256: string,
): string[] {
  if (inspection.issues.length > 0) return inspection.issues;
  if (inspection.sha256 !== expectedSha256) {
    return [`Correction ${correctionNumber} section SHA-256 mismatch`];
  }
  return [];
}

test("proof document policy rejects section borrowing and semantic reversal", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement.run.md",
  ).text();
  const correction49Sha256 =
    "84f5977603710e81a49cadff4256df028ab5c60242d2ac8961a4348b07f6f676";
  const correction50Sha256 =
    "fbaf51ee11ad7ddc4c8595dc9480a93fb978c3b7d602014b3c240163b90157a4";
  const correction51Sha256 =
    "79ea5a2c8fe957189662e4f50b64bedbafc3c530718f3f300da1829db0256626";
  const correction50Rows = [
    "audit-finalizer-harness-callback-identity",
    "audit-finalizer-harness-option-binding-purity",
    "audit-matcher-proof-symbol-identity",
    "audit-delivery-immutable-push-ref",
    "audit-merge-command-authority",
    "audit-terminal-report-binding",
    "audit-work-finalization-reserve",
    "audit-timeout-usage-accounting",
    "audit-design-contract-drift",
  ];
  const correction51Rows = [
    "audit-cross-layer-finalization-reserve-composition",
  ];
  const correction49Required = "exact scenario-array digests";
  const correction49Borrow = replaceAfterHeading(
    replaceAfterHeading(
      source,
      "## Correction 49",
      correction49Required,
      "scenario-array digests",
    ),
    "## Correction 50",
    "Nine validated root causes remained after Correction 49:",
    `Nine validated root causes remained after Correction 49: ${correction49Required}.`,
  );
  expect(
    correctionSectionLockIssues(
      inspectCorrectionProofSection(
        correction49Borrow,
        49,
        correction49ProofRowIds,
        50,
      ),
      49,
      correction49Sha256,
    ),
  ).toEqual(["Correction 49 section SHA-256 mismatch"]);
  const nonHeadingCorrection49 = source.replace(
    "## Correction 49",
    "Correction 49",
  );
  expect(
    inspectCorrectionProofSection(
      nonHeadingCorrection49,
      49,
      correction49ProofRowIds,
      50,
    ).issues,
  ).toEqual(["Correction 49 heading count must be 1, received 0"]);
  const correction500Boundary = source.replace(
    "## Correction 50",
    "## Correction 500",
  );
  expect(
    inspectCorrectionProofSection(
      correction500Boundary,
      49,
      correction49ProofRowIds,
      50,
    ).issues,
  ).toEqual(["Correction 50 boundary heading count must be 1, received 0"]);
  const correction50Borrow = replaceAfterHeading(
    source,
    "## Correction 50",
    "Final measured gates:",
    "Measured gates:",
  );
  expect(
    correctionSectionLockIssues(
      inspectCorrectionProofSection(correction50Borrow, 50, correction50Rows, 51),
      50,
      correction50Sha256,
    ),
  ).toEqual(["Correction 50 section SHA-256 mismatch"]);
  const semanticallyMutatedCorrection50Heading = source.replace(
    "## Correction 50",
    "## Not Correction 50",
  );
  expect(
    correctionSectionLockIssues(
      inspectCorrectionProofSection(
        semanticallyMutatedCorrection50Heading,
        50,
        correction50Rows,
        51,
      ),
      50,
      correction50Sha256,
    ),
  ).toEqual(["Correction 50 section SHA-256 mismatch"]);
  const nonHeadingCorrection50 = source.replace(
    "## Correction 50",
    "Correction 50",
  );
  expect(
    inspectCorrectionProofSection(nonHeadingCorrection50, 50, correction50Rows, 51)
      .issues,
  ).toEqual(["Correction 50 heading count must be 1, received 0"]);
  const nonHeadingBoundary = source.replace(
    "## Correction 51",
    "Correction 51",
  );
  expect(
    inspectCorrectionProofSection(nonHeadingBoundary, 50, correction50Rows, 51)
      .issues,
  ).toEqual(["Correction 51 boundary heading count must be 1, received 0"]);
  const correction510Heading = source.replace(
    "## Correction 51",
    "## Correction 510",
  );
  expect(
    inspectCorrectionProofSection(correction510Heading, 51, correction51Rows, 52)
      .issues,
  ).toEqual(["Correction 51 heading count must be 1, received 0"]);
  const correction51BorrowedAuthorization = replaceAfterHeading(
    source,
    "## Correction 51",
    "Any live run or\nGitHub write requires fresh explicit authorization.",
    "",
  );
  expect(
    correctionSectionLockIssues(
      inspectCorrectionProofSection(
        correction51BorrowedAuthorization,
        51,
        correction51Rows,
        52,
      ),
      51,
      correction51Sha256,
    ),
  ).toEqual(["Correction 51 section SHA-256 mismatch"]);
  const correction520Heading = source.replace(
    "## Correction 52",
    "## Correction 520",
  );
  expect(correctionHeadingIndices(correction520Heading, 52)).toEqual([]);
  const bindingAfterSetup = replaceAfterHeading(
    source,
    "## Correction 51",
    "before fallible\n  setup",
    "after fallible\n  setup",
  );
  const pendingDeclaredComplete = replaceAfterHeading(
    source,
    "## Correction 51",
    "live run remain pending.",
    "live run pending work is complete.",
  );
  const prohibitedActionsRan = replaceAfterHeading(
    source,
    "## Correction 51",
    "No manifest generation, audit, preflight, live\nexecution, push, PR, CI wait, or merge ran in Correction 51.",
    "Manifest generation, audit, preflight, live\nexecution, push, PR, CI wait, and merge ran in Correction 51.",
  );
  const retainedHashNegated = replaceAfterHeading(
    source,
    "## Correction 51",
    "retain SHA-256",
    "do not retain SHA-256",
  );
  const finalLedgerNegated = replaceAfterHeading(
    source,
    "## Correction 51",
    "brings the ledger to 150 rows and 150 unique IDs",
    "does not bring the ledger to 150 rows and 150 unique IDs",
  );
  for (const [name, mutation] of [
    ["binding after fallible setup", bindingAfterSetup],
    ["pending work declared complete", pendingDeclaredComplete],
    ["prohibited actions claimed as run", prohibitedActionsRan],
    ["retained ledger hash semantically negated", retainedHashNegated],
    ["final ledger count semantically negated", finalLedgerNegated],
  ] as const) {
    expect(
      correctionSectionLockIssues(
        inspectCorrectionProofSection(mutation, 51, correction51Rows, 52),
        51,
        correction51Sha256,
      ),
      name,
    ).toEqual(["Correction 51 section SHA-256 mismatch"]);
  }
});

test("proof document policy rejects forgeable correction headings rows boundaries and claims", async () => {
  const source = await Bun.file(
    ".orca/workflows/codebase-improvement.run.md",
  ).text();
  const undetected: string[] = [];
  const correction50Rows = [
    "audit-finalizer-harness-callback-identity",
    "audit-finalizer-harness-option-binding-purity",
    "audit-matcher-proof-symbol-identity",
    "audit-delivery-immutable-push-ref",
    "audit-merge-command-authority",
    "audit-terminal-report-binding",
    "audit-work-finalization-reserve",
    "audit-timeout-usage-accounting",
    "audit-design-contract-drift",
  ];
  const inspectCorrection50 = (candidate: string) =>
    inspectCorrectionProofSection(
      candidate,
      50,
      correction50Rows,
      51,
    );

  const newlineAfterMarker = source.replace(
    "## Correction 50",
    "##\nCorrection 50",
  );
  expect(inspectCorrection50(newlineAfterMarker).issues).toEqual([
    "Correction 50 heading count must be 1, received 0",
  ]);

  const lineTerminatorIssues: Array<{
    label: string;
    issues: readonly string[];
  }> = [];
  const expectedLineTerminatorIssues: Array<{
    label: string;
    issues: readonly string[];
  }> = [];
  const lineTerminatorMutations = [
    ["CR", "\r"],
    ["LINE SEPARATOR", "\u2028"],
    ["PARAGRAPH SEPARATOR", "\u2029"],
  ] as const;
  for (const [label, terminator] of lineTerminatorMutations) {
    const mutant = source.replace(
      "## Correction 50",
      `## ${terminator}Correction 50`,
    );
    lineTerminatorIssues.push({
      label,
      issues: inspectCorrection50(mutant).issues,
    });
    expectedLineTerminatorIssues.push({
      label,
      issues: ["Correction 50 heading count must be 1, received 0"],
    });
  }
  expect(lineTerminatorIssues).toEqual(expectedLineTerminatorIssues);
  const weakenedHeading = new RegExp(
    `^(?:#{2,3}[ \\t]+|-[ \\t]+\\[x\\][ \\t]+(?:\\*\\*)?)[^\\n]*\\bCorrection[ \\t]+50\\b[^\\n]*$`,
    "gm",
  );
  expect(
    lineTerminatorMutations.map(([label, terminator]) => ({
      label,
      headingCount: [
        ...source.replace(
          "## Correction 50",
          `## ${terminator}Correction 50`,
        ).matchAll(weakenedHeading),
      ].length,
    })),
  ).toEqual([
    { label: "CR", headingCount: 1 },
    { label: "LINE SEPARATOR", headingCount: 1 },
    { label: "PARAGRAPH SEPARATOR", headingCount: 1 },
  ]);

  const suffixedRow = source.replace(
    "- `audit-design-contract-drift`:",
    "- `audit-design-contract-drift-suffix`:",
  );
  expect(inspectCorrection50(suffixedRow).issues).toEqual([
    "Correction 50 row anchor audit-design-contract-drift count must be 1, received 0",
  ]);

  const proseOnlyRow = source.replace(
    "- `audit-design-contract-drift`:",
    "Prose mentions `audit-design-contract-drift`:",
  );
  expect(inspectCorrection50(proseOnlyRow).issues).toEqual([
    "Correction 50 row anchor audit-design-contract-drift count must be 1, received 0",
  ]);

  const duplicateRow = source.replace(
    "- `audit-design-contract-drift`:",
    "- `audit-design-contract-drift`:\n- `audit-design-contract-drift`:",
  );
  expect(inspectCorrection50(duplicateRow).issues).toEqual([
    "Correction 50 row anchor audit-design-contract-drift count must be 1, received 2",
  ]);

  const firstRowAnchor = "- `audit-finalizer-harness-callback-identity`:";
  const secondRowAnchor =
    "- `audit-finalizer-harness-option-binding-purity`:";
  const reversedRows = source
    .replace(firstRowAnchor, "__CORRECTION_50_FIRST_ROW__")
    .replace(secondRowAnchor, firstRowAnchor)
    .replace("__CORRECTION_50_FIRST_ROW__", secondRowAnchor);
  expect(inspectCorrection50(reversedRows).issues).toEqual([
    "Correction 50 order must be heading < ordered row anchors < Correction 51",
  ]);

  const duplicateHeading = source.replace(
    "Nine validated root causes remained after Correction 49:",
    "## Correction 50\n\nBorrowed paragraph.\n\nNine validated root causes remained after Correction 49:",
  );
  expect(inspectCorrection50(duplicateHeading).issues).toEqual([
    "Correction 50 heading count must be 1, received 2",
  ]);

  const duplicateBoundary = source.replace(
    "## Correction 51",
    "## Correction 51\n\n## Correction 51",
  );
  expect(inspectCorrection50(duplicateBoundary).issues).toEqual([
    "Correction 51 boundary heading count must be 1, received 2",
  ]);

  const authorization =
    "Any live run or\nGitHub write requires fresh explicit authorization.";
  const sourceWithCorrection54 = replaceAfterHeading(
    source,
    "## Correction 53",
    authorization,
    `${authorization}\n\nA forged trailing Correction 53 claim.`,
  );
  const correction53Index = correctionHeadingIndices(sourceWithCorrection54, 53)[0]!;
  const authorizationIndex = sourceWithCorrection54.indexOf(
    authorization,
    correction53Index,
  );
  const correction53Fixture = sourceWithCorrection54.slice(
    correction53Index,
    sourceWithCorrection54.length,
  );
  const cleanCorrection53Fixture = correction53Fixture.replace(
    "\n\nA forged trailing Correction 53 claim.",
    "",
  );
  const cleanCorrection53 = inspectCorrectionProofSection(
    cleanCorrection53Fixture,
    53,
    [
      "audit-correction50-proof-heading-start",
      "audit-correction51-heading-word-boundary",
      "audit-correction51-proof-section-end-boundary",
    ],
    54,
  );
  expect(cleanCorrection53.issues).toEqual([]);
  expect(
    correctionSectionLockIssues(
      inspectCorrectionProofSection(
        correction53Fixture,
        53,
        [
          "audit-correction50-proof-heading-start",
          "audit-correction51-heading-word-boundary",
          "audit-correction51-proof-section-end-boundary",
        ],
        54,
      ),
      53,
      cleanCorrection53.sha256!,
    ),
  ).toEqual(["Correction 53 section SHA-256 mismatch"]);
  expect(authorizationIndex).toBeGreaterThan(correction53Index);

  const semanticNegation = source.replace(
    "All seven harness loops require exact scenario-array digests.",
    "All seven harness loops do not require exact scenario-array digests.",
  );
  const correction49 = inspectCorrectionProofSection(
    source,
    49,
    correction49ProofRowIds,
    50,
  );
  expect(correction49.issues).toEqual([]);
  expect(
    correctionSectionLockIssues(
      inspectCorrectionProofSection(
        semanticNegation,
        49,
        correction49ProofRowIds,
        50,
      ),
      49,
      correction49.sha256!,
    ),
  ).toEqual(["Correction 49 section SHA-256 mismatch"]);

  const changedGateCount = source.replace(
    "Focused policy verification passes 18/18 with 88 assertions.",
    "Focused policy verification passes 17/18 with 87 assertions.",
  );
  expect(
    correctionSectionLockIssues(
      inspectCorrectionProofSection(
        changedGateCount,
        49,
        correction49ProofRowIds,
        50,
      ),
      49,
      correction49.sha256!,
    ),
  ).toEqual(["Correction 49 section SHA-256 mismatch"]);

  expect(undetected).toEqual([]);
});

test("proof documents record Correction 50 audit closure", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const rowIds = [
    "audit-finalizer-harness-callback-identity",
    "audit-finalizer-harness-option-binding-purity",
    "audit-matcher-proof-symbol-identity",
    "audit-delivery-immutable-push-ref",
    "audit-merge-command-authority",
    "audit-terminal-report-binding",
    "audit-work-finalization-reserve",
    "audit-timeout-usage-accounting",
    "audit-design-contract-drift",
  ];
  const prefixSha256 =
    "401a417c41f1c24aaef1fdf8990ae1c049c8d7affcb822e8d552fc2372d463e3";
  const ledgerSha256 =
    "607bd1a3250dcf1afeb9880683179391a69cc98fda7e151c938d0b9658604338";
  const sectionSha256ByPath = new Map([
    [
      proofPaths[0],
      "fbaf51ee11ad7ddc4c8595dc9480a93fb978c3b7d602014b3c240163b90157a4",
    ],
    [
      proofPaths[1],
      "98e055c5c4f4f0cb4c8b3882f01cc8a3799bf76cc5d42775405491a6556d8bac",
    ],
    [
      proofPaths[2],
      "86fc16e47015ad72d49a76e14ecfcb22739316250132a5f139c35517b7b386bb",
    ],
    [
      proofPaths[3],
      "e700d19bf365477a014f6da9c86ea456cbc0795b30b17f4c10c73b4f81d6ca68",
    ],
  ]);

  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(source, 50, rowIds, 51);
    expect(inspection.issues, proofPath).toEqual([]);
    expect(inspection.sha256, proofPath).toBe(
      sectionSha256ByPath.get(proofPath),
    );
  }

  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  const ledgerLines = ledger.trimEnd().split("\n");
  const correction50Lines = ledgerLines.slice(0, 149);
  const rows = correction50Lines.map(
    (line) => JSON.parse(line) as { id: string },
  );
  expect(rows).toHaveLength(149);
  expect(new Set(rows.map((row) => row.id)).size).toBe(149);
  expect(
    createHash("sha256")
      .update(ledgerLines.slice(0, 140).join("\n") + "\n")
      .digest("hex"),
  ).toBe(prefixSha256);
  const expectedRows =   [
    {
      "id": "audit-finalizer-harness-callback-identity",
      "runId": "correction50-verification-20260717",
      "at": "2026-07-17T08:28:56.000Z",
      "classification": "gate",
      "stage": "correction50-verification",
      "elapsedMs": 0,
      "evidence": "Finalizer-harness policy protected scenario identities and selected statements but not exact whole callback source, so a post-call conditional continue or swallowing catch could weaken behavior while every existing diagnostic stayed green.",
      "backend": "codex",
      "worktree": "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      "branch": "meta/codebase-improvement-loop",
      "monitorPath": "independent-audit:no-monitor",
      "status": "open"
    },
    {
      "id": "audit-finalizer-harness-option-binding-purity",
      "runId": "correction50-verification-20260717",
      "at": "2026-07-17T08:28:57.000Z",
      "classification": "gate",
      "stage": "correction50-verification",
      "elapsedMs": 0,
      "evidence": "Finalizer-harness option policy validated an option expression but not a pre-loop identifier initializer, so an effectful const alias could execute before a nominally passive harness option.",
      "backend": "codex",
      "worktree": "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      "branch": "meta/codebase-improvement-loop",
      "monitorPath": "independent-audit:no-monitor",
      "status": "open"
    },
    {
      "id": "audit-matcher-proof-symbol-identity",
      "runId": "correction50-verification-20260717",
      "at": "2026-07-17T08:28:58.000Z",
      "classification": "gate",
      "stage": "correction50-verification",
      "elapsedMs": 0,
      "evidence": "Matcher-proof contracts matched identifier text instead of canonical TypeScript symbols, so same-name local shadows could satisfy the preload-writer and matcherProofArgs import checks.",
      "backend": "codex",
      "worktree": "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      "branch": "meta/codebase-improvement-loop",
      "monitorPath": "independent-audit:no-monitor",
      "status": "open"
    },
    {
      "id": "audit-delivery-immutable-push-ref",
      "runId": "correction50-verification-20260717",
      "at": "2026-07-17T08:28:59.000Z",
      "classification": "scope",
      "stage": "correction50-verification",
      "elapsedMs": 0,
      "evidence": "Delivery pushed mutable HEAD through the current remote name and did not prove the exact remote branch SHA before pull-request creation.",
      "backend": "codex",
      "worktree": "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      "branch": "meta/codebase-improvement-loop",
      "monitorPath": "independent-audit:no-monitor",
      "status": "open"
    },
    {
      "id": "audit-merge-command-authority",
      "runId": "correction50-verification-20260717",
      "at": "2026-07-17T08:29:00.000Z",
      "classification": "merge",
      "stage": "correction50-verification",
      "elapsedMs": 0,
      "evidence": "Merge confirmation could run after a failed squash command, allowing a later MERGED state to hide the failed command response.",
      "backend": "codex",
      "worktree": "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      "branch": "meta/codebase-improvement-loop",
      "monitorPath": "independent-audit:no-monitor",
      "status": "open"
    },
    {
      "id": "audit-terminal-report-binding",
      "runId": "correction50-verification-20260717",
      "at": "2026-07-17T08:29:01.000Z",
      "classification": "gate",
      "stage": "correction50-verification",
      "elapsedMs": 0,
      "evidence": "The launcher accepted a zero-exit worker report with only a non-empty prUrl, so unbound run, monitor, repository, head, CI, merge, SLA, and usage claims could be hashed and staged as terminal success.",
      "backend": "codex",
      "worktree": "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      "branch": "meta/codebase-improvement-loop",
      "monitorPath": "independent-audit:no-monitor",
      "status": "open"
    },
    {
      "id": "audit-work-finalization-reserve",
      "runId": "correction50-verification-20260717",
      "at": "2026-07-17T08:29:02.000Z",
      "classification": "sla-overrun",
      "stage": "correction50-verification",
      "elapsedMs": 0,
      "evidence": "Worker and launcher active work could consume their complete absolute deadlines, leaving no reserved interval to retract stale evidence and publish truthful terminal failure; merge also subtracted the runtime reserve twice.",
      "backend": "codex",
      "worktree": "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      "branch": "meta/codebase-improvement-loop",
      "monitorPath": "independent-audit:no-monitor",
      "status": "open"
    },
    {
      "id": "audit-timeout-usage-accounting",
      "runId": "correction50-verification-20260717",
      "at": "2026-07-17T08:29:03.000Z",
      "classification": "gate",
      "stage": "correction50-verification",
      "elapsedMs": 0,
      "evidence": "Non-scout timeout handling rethrew without preserving valid usage from a fulfilled terminal outcome, undercounting consumed backend tokens.",
      "backend": "codex",
      "worktree": "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      "branch": "meta/codebase-improvement-loop",
      "monitorPath": "independent-audit:no-monitor",
      "status": "open"
    },
    {
      "id": "audit-design-contract-drift",
      "runId": "correction50-verification-20260717",
      "at": "2026-07-17T08:29:04.000Z",
      "classification": "documentation",
      "stage": "correction50-verification",
      "elapsedMs": 0,
      "evidence": "The design documented selectedControl with only two of four fields, allowed one changed path despite the two-path schema minimum, and prescribed unscoped diff-tree instead of the full parent-to-head range proof.",
      "backend": "codex",
      "worktree": "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      "branch": "meta/codebase-improvement-loop",
      "monitorPath": "independent-audit:no-monitor",
      "status": "open"
    }
  ];
  expect(rows.slice(-9)).toEqual(expectedRows);
  expect(
    createHash("sha256")
      .update(`${correction50Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(ledgerSha256);
});

test("proof documents record Correction 51 finalization reserve composition", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const rowId = "audit-cross-layer-finalization-reserve-composition";
  const retainedLedgerSha256 =
    "607bd1a3250dcf1afeb9880683179391a69cc98fda7e151c938d0b9658604338";
  const prefixSha256 =
    "401a417c41f1c24aaef1fdf8990ae1c049c8d7affcb822e8d552fc2372d463e3";
  const ledgerSha256 =
    "f77b1bf5c4ec4a65b28c4d433a3a46e0bf4c43bb0ad72212f86da250af0e9872";
  const sectionSha256ByPath = new Map([
    [
      proofPaths[0],
      "79ea5a2c8fe957189662e4f50b64bedbafc3c530718f3f300da1829db0256626",
    ],
    [
      proofPaths[1],
      "f9d8eb74beb5a86dd5271cc9dfc77c1f824513dda1b995550628c018c9b951e3",
    ],
    [
      proofPaths[2],
      "c023e6ad37b4bf4db9745226a8d68536706d222ca31909c470ca225585fe8bf2",
    ],
    [
      proofPaths[3],
      "61de7f955f4df1fa4250852c78ee4ff6596952ee4128f68ff955914314671508",
    ],
  ]);

  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(
      source,
      51,
      [rowId],
      52,
    );
    expect(inspection.issues, proofPath).toEqual([]);
    expect(inspection.sha256, proofPath).toBe(
      sectionSha256ByPath.get(proofPath),
    );
  }

  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  const ledgerLines = ledger.trimEnd().split("\n");
  const correction51Lines = ledgerLines.slice(0, 150);
  const rows = correction51Lines.map(
    (line) => JSON.parse(line) as { id: string },
  );
  expect(rows).toHaveLength(150);
  expect(new Set(rows.map((row) => row.id)).size).toBe(150);
  expect(
    createHash("sha256")
      .update(`${ledgerLines.slice(0, 149).join("\n")}\n`)
      .digest("hex"),
  ).toBe(retainedLedgerSha256);
  expect(
    createHash("sha256")
      .update(`${ledgerLines.slice(0, 140).join("\n")}\n`)
      .digest("hex"),
  ).toBe(prefixSha256);
  expect(rows.slice(149)).toEqual([
    {
      id: rowId,
      runId: "correction51-verification-20260717",
      at: "2026-07-17T10:05:09.000Z",
      classification: "sla-overrun",
      stage: "correction51-verification",
      elapsedMs: 0,
      evidence:
        "Task 4 review proved the launcher and runtime independently claimed the same final 10-second interval, so launcher supervision could terminate the worker while runtime terminal evidence was still being published.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
  ]);
  expect(
    createHash("sha256")
      .update(`${correction51Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(ledgerSha256);
});

test("proof documents record Correction 52 historical proof binding", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const rowIds = [
    "audit-correction49-proof-section-boundary",
    "audit-correction51-ledger-claim-semantic-binding",
  ];
  const retainedLedgerSha256 =
    "f77b1bf5c4ec4a65b28c4d433a3a46e0bf4c43bb0ad72212f86da250af0e9872";
  const ledgerSha256 =
    "24328b018809a39e2659dcc62e94c7600d106e63cebb2d4cfc00af83ee24bdcb";
  const sectionSha256ByPath = new Map([
    [
      proofPaths[0],
      "5e6c24627722ec6eceb868bbeed595b467c021061e626f709dfb4b7060108b77",
    ],
    [
      proofPaths[1],
      "5bb273011187438af10a3d00a7b67af0a6c806984bfe09322c83a70dae18cc29",
    ],
    [
      proofPaths[2],
      "69aa6beb43f7594ee24139ecc8ebee1b56404c52443d7aa517c2b6ca5856a216",
    ],
    [
      proofPaths[3],
      "18f64684215e8e50dd922cc82ea7f7f5c82fac053e96f55ea32d302a4c7ce391",
    ],
  ]);

  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(
      source,
      52,
      rowIds,
      53,
    );
    expect(inspection.issues, proofPath).toEqual([]);
    expect(inspection.sha256, proofPath).toBe(
      sectionSha256ByPath.get(proofPath),
    );
  }

  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  const ledgerLines = ledger.trimEnd().split("\n");
  const correction52Lines = ledgerLines.slice(0, 152);
  const rows = correction52Lines.map(
    (line) => JSON.parse(line) as { id: string },
  );
  expect(rows).toHaveLength(152);
  expect(new Set(rows.map((row) => row.id)).size).toBe(152);
  expect(
    createHash("sha256")
      .update(`${ledgerLines.slice(0, 150).join("\n")}\n`)
      .digest("hex"),
  ).toBe(retainedLedgerSha256);
  expect(rows.slice(150)).toEqual([
    {
      id: rowIds[0],
      runId: "correction52-verification-20260717",
      at: "2026-07-17T11:51:50.000Z",
      classification: "gate",
      stage: "correction52-verification",
      elapsedMs: 0,
      evidence:
        "Evidence audit proved the Correction 49 proof sliced from its heading through end-of-file, so a required historical token removed from Correction 49 could be borrowed from Correction 50 or later text.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: rowIds[1],
      runId: "correction52-verification-20260717",
      at: "2026-07-17T11:51:51.000Z",
      classification: "gate",
      stage: "correction52-verification",
      elapsedMs: 0,
      evidence:
        "Evidence audit proved the Correction 51 ledger proof required count and SHA-256 fragments instead of exact affirmative sentences, so semantic negation could preserve every required fragment while reversing the claim.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
  ]);
  expect(
    createHash("sha256")
      .update(`${correction52Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(ledgerSha256);
});

test("proof documents bind Correction 53 through the Correction 54 heading", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const rowIds = [
    "audit-correction50-proof-heading-start",
    "audit-correction51-heading-word-boundary",
    "audit-correction51-proof-section-end-boundary",
  ];
  const retainedLedgerSha256 =
    "24328b018809a39e2659dcc62e94c7600d106e63cebb2d4cfc00af83ee24bdcb";
  const ledgerSha256 =
    "5e64ec63520b0f86bb53e4abe7f5f1b072543dde459c96e65b9e1e6dbef41b65";
  const sectionSha256 =
    "67c134a9332c2bb7b61a0f5cac827725aac56a05b38ed56bd4b46fdb9ce97d72";
  const sectionByteLength = 2461;
  const completeSectionSha256ByPath = new Map([
    [
      proofPaths[0],
      "bb178055e7ea020795a8d19702270855f4359068245375415822190226c29388",
    ],
    [
      proofPaths[1],
      "63a62a340aa85c1fc6ccff0b4f080e0314bb8792b8689aaa13acacab1c5d092f",
    ],
    [
      proofPaths[2],
      "3163142a2285c8a0fc6034d2d8de12580d04a4d82e75cddf1a5567a3012e4c83",
    ],
    [
      proofPaths[3],
      "d6069da55b62b4cf37a8390224751694a93d9390c59453b8e4fb769e225f1548",
    ],
  ]);

  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(
      source,
      53,
      rowIds,
      54,
    );
    expect(inspection.issues, proofPath).toEqual([]);
    expect(inspection.sha256, proofPath).toBe(
      completeSectionSha256ByPath.get(proofPath),
    );
    expect(inspection.body?.length, proofPath).toBeGreaterThanOrEqual(
      sectionByteLength,
    );
    expect(
      createHash("sha256")
        .update(inspection.body!.slice(0, sectionByteLength))
        .digest("hex"),
      proofPath,
    ).toBe(sectionSha256);
  }

  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  const ledgerLines = ledger.trimEnd().split("\n");
  const correction53Lines = ledgerLines.slice(0, 155);
  const rows = correction53Lines.map(
    (line) => JSON.parse(line) as { id: string },
  );
  expect(rows).toHaveLength(155);
  expect(new Set(rows.map((row) => row.id)).size).toBe(155);
  expect(
    createHash("sha256")
      .update(`${ledgerLines.slice(0, 152).join("\n")}\n`)
      .digest("hex"),
  ).toBe(retainedLedgerSha256);
  expect(rows.slice(152)).toEqual([
    {
      id: rowIds[0],
      runId: "correction53-verification-20260717",
      at: "2026-07-17T13:08:54.000Z",
      classification: "gate",
      stage: "correction53-verification",
      elapsedMs: 0,
      evidence:
        "Evidence audit proved the Correction 50 proof located its start with plain-text lastIndexOf, so a non-heading Correction 50 label could satisfy the historical proof.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: rowIds[1],
      runId: "correction53-verification-20260717",
      at: "2026-07-17T13:08:55.000Z",
      classification: "gate",
      stage: "correction53-verification",
      elapsedMs: 0,
      evidence:
        "Evidence audit proved the Correction 51 and Correction 52 heading matchers lacked numeric word boundaries, so Correction 510 or Correction 520 could satisfy an exact historical heading.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: rowIds[2],
      runId: "correction53-verification-20260717",
      at: "2026-07-17T13:08:56.000Z",
      classification: "gate",
      stage: "correction53-verification",
      elapsedMs: 0,
      evidence:
        "Evidence audit proved the Correction 51 proof ended at reusable authorization text instead of the next correction heading, so a required sentence could be borrowed from Correction 52.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
  ]);
  expect(
    createHash("sha256")
      .update(`${correction53Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(ledgerSha256);
});

test("proof documents preserve one exact Correction 54 section through Correction 55", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const rowIds = [
    "audit-runtime-filesystem-deadline-coverage",
    "audit-ci-poll-deadline-reserve",
    "audit-launcher-publication-deadline-coverage",
    "audit-merge-response-authoritative-confirmation",
    "audit-correction-heading-horizontal-whitespace",
    "audit-correction-row-anchor-exact-line",
    "audit-correction-heading-uniqueness",
    "audit-correction53-section-end-boundary",
    "audit-proof-semantic-execution-binding",
  ];
  const expectedSection = [
    "## Correction 54",
    "",
    "Nine successor-audit root causes remained after Correction 53:",
    "",
    "- `audit-runtime-filesystem-deadline-coverage`: Active filesystem operations",
    "  now share the exact 580-second work remainder and reject completion at or",
    "  after cutoff.",
    "- `audit-ci-poll-deadline-reserve`: Every pending CI sleep is deadline-bound",
    "  and preserves the 5,000 ms merge-confirmation plus 5,000 ms issue-closure",
    "  reserves.",
    "- `audit-launcher-publication-deadline-coverage`: Every canonical launcher",
    "  publication uses the supervised atomic rename protocol with a 1,000 ms",
    "  read-only recovery reserve.",
    "- `audit-merge-response-authoritative-confirmation`: Every exact SHA-locked",
    "  squash response is persisted before authoritative state confirmation,",
    "  including failed responses and ordered dual-cause failure.",
    "- `audit-correction-heading-horizontal-whitespace`: Correction headings accept",
    "  horizontal space or tab only; a newline after the Markdown marker is",
    "  rejected.",
    "- `audit-correction-row-anchor-exact-line`: Escaped row IDs match only exact",
    "  Markdown anchor lines; suffixed and prose-only IDs are rejected.",
    "- `audit-correction-heading-uniqueness`: Each current and supplied next-number",
    "  correction heading must occur exactly once.",
    "- `audit-correction53-section-end-boundary`: Correction 53 is bounded by the",
    "  exact Correction 54 heading rather than reusable authorization prose or EOF.",
    "- `audit-proof-semantic-execution-binding`: Exact section bytes and SHA-256",
    "  values bind historical wording, semantic polarity, and measured-count prose",
    "  without claiming that static text executed a command.",
    "",
    "The unchanged first 155 ledger rows retain SHA-256",
    "`5e64ec63520b0f86bb53e4abe7f5f1b072543dde459c96e65b9e1e6dbef41b65`.",
    "Nine append-only open rows bring the ledger to 164 rows and 164 unique IDs",
    "with SHA-256 `1311cdd92f9177984ccce0f74d3f8c794c13529b86837503b1597502008a723c`.",
    "",
    "Static hashes bind wording and history only. Executed focused and aggregate",
    "gate outputs plus a fresh preflight prove execution. Historical measured-count",
    "prose remains locked documentation, not evidence that those commands ran.",
    "",
    "Final measured Task 4 gate: focused proof document policy and Correction 54",
    "verification passes 5/5 with",
    "68 assertions.",
    "The Task 5 aggregate gate and fresh preflight remain pending and must execute;",
    "their later outputs, not this static section, will prove those actions.",
    "",
    "No manifest generation, audit, preflight, live execution, push, PR, CI wait,",
    "or merge ran in Correction 54. Any live run or GitHub write requires fresh",
    "explicit authorization.",
    "",
  ].join("\n");
  const sections: string[] = [];

  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(source, 54, rowIds, 55);
    expect(inspection.issues, proofPath).toEqual([]);
    expect(inspection.section, proofPath).toBe(expectedSection);
    expect(inspection.sha256, proofPath).toBe(
      createHash("sha256").update(expectedSection).digest("hex"),
    );
    sections.push(inspection.section!);
  }
  expect(new Set(sections).size).toBe(1);

  const mutationSource = await Bun.file(proofPaths[0]!).text();
  for (const [label, replacement, expectedIssue] of [
    [
      "missing",
      "## Correction 550",
      "Correction 55 boundary heading count must be 1, received 0",
    ],
    [
      "duplicate",
      "## Correction 55\n\n## Correction 55",
      "Correction 55 boundary heading count must be 1, received 2",
    ],
    [
      "CR-forged",
      "## \rCorrection 55",
      "Correction 55 boundary heading count must be 1, received 0",
    ],
  ] as const) {
    const mutation = mutationSource.replace("## Correction 55", replacement);
    expect(mutation, label).not.toBe(mutationSource);
    expect(
      inspectCorrectionProofSection(mutation, 54, rowIds, 55).issues,
      label,
    ).toEqual([expectedIssue]);
  }
});

test("Correction 54 ledger preserves nine exact open rows", async () => {
  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  const ledgerLines = ledger.trimEnd().split("\n");
  const correction54Lines = ledgerLines.slice(0, 164);
  const rows = correction54Lines.map(
    (line) => JSON.parse(line) as { id: string },
  );
  expect(rows).toHaveLength(164);
  expect(new Set(rows.map((row) => row.id)).size).toBe(164);
  expect(
    createHash("sha256")
      .update(`${ledgerLines.slice(0, 155).join("\n")}\n`)
      .digest("hex"),
  ).toBe("5e64ec63520b0f86bb53e4abe7f5f1b072543dde459c96e65b9e1e6dbef41b65");
  expect(rows.slice(155)).toEqual([
    {
      id: "audit-runtime-filesystem-deadline-coverage",
      runId: "correction54-verification-20260717",
      at: "2026-07-17T13:08:57.000Z",
      classification: "sla-overrun",
      stage: "correction54-verification",
      elapsedMs: 0,
      evidence:
        "Successor audit proved active filesystem operations could complete after the 580-second cutoff because reads and writes used post-operation checks or unbounded promises.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: "audit-ci-poll-deadline-reserve",
      runId: "correction54-verification-20260717",
      at: "2026-07-17T13:08:58.000Z",
      classification: "sla-overrun",
      stage: "correction54-verification",
      elapsedMs: 0,
      evidence:
        "Successor audit proved a pending CI poll could sleep through the delivery terminal reserves and wake at or after cutoff.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: "audit-launcher-publication-deadline-coverage",
      runId: "correction54-verification-20260717",
      at: "2026-07-17T13:08:59.000Z",
      classification: "gate",
      stage: "correction54-verification",
      elapsedMs: 0,
      evidence:
        "Successor audit proved canonical launcher writes and renames could outlive the 600-second deadline because publication commit points and redirections were not supervised.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: "audit-merge-response-authoritative-confirmation",
      runId: "correction54-verification-20260717",
      at: "2026-07-17T13:09:00.000Z",
      classification: "merge",
      stage: "correction54-verification",
      elapsedMs: 0,
      evidence:
        "Successor audit proved a failed squash response could prevent authoritative confirmation even when GitHub had accepted the merge.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: "audit-correction-heading-horizontal-whitespace",
      runId: "correction54-verification-20260717",
      at: "2026-07-17T13:09:01.000Z",
      classification: "gate",
      stage: "correction54-verification",
      elapsedMs: 0,
      evidence:
        "Evidence audit proved the correction heading matcher used general whitespace, so a newline after the Markdown marker could forge a heading.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: "audit-correction-row-anchor-exact-line",
      runId: "correction54-verification-20260717",
      at: "2026-07-17T13:09:02.000Z",
      classification: "gate",
      stage: "correction54-verification",
      elapsedMs: 0,
      evidence:
        "Evidence audit proved substring row lookup accepted a suffixed ID or an ID mentioned only in prose as the required row anchor.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: "audit-correction-heading-uniqueness",
      runId: "correction54-verification-20260717",
      at: "2026-07-17T13:09:03.000Z",
      classification: "gate",
      stage: "correction54-verification",
      elapsedMs: 0,
      evidence:
        "Evidence audit proved the historical extractor selected one nearby heading without rejecting a duplicate current heading and borrowed paragraph.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: "audit-correction53-section-end-boundary",
      runId: "correction54-verification-20260717",
      at: "2026-07-17T13:09:04.000Z",
      classification: "gate",
      stage: "correction54-verification",
      elapsedMs: 0,
      evidence:
        "Evidence audit proved the Correction 53 proof ended at reusable authorization text or EOF instead of the exact Correction 54 heading.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
    {
      id: "audit-proof-semantic-execution-binding",
      runId: "correction54-verification-20260717",
      at: "2026-07-17T13:09:05.000Z",
      classification: "gate",
      stage: "correction54-verification",
      elapsedMs: 0,
      evidence:
        "Evidence audit proved fragment and count checks allowed semantic negation or changed measured-count prose and could misstate static documentation as executed proof.",
      backend: "codex",
      worktree:
        "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
      branch: "meta/codebase-improvement-loop",
      monitorPath: "independent-audit:no-monitor",
      status: "open",
    },
  ]);
  expect(
    createHash("sha256")
      .update(`${correction54Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(
    "1311cdd92f9177984ccce0f74d3f8c794c13529b86837503b1597502008a723c",
  );
});

test("exact LF-delimited C56 boundary rejects semantic negation and line terminators", () => {
  const clean = "before\n## Correction 56\nbody\n";
  const semanticNegation = clean.replace(
    "## Correction 56",
    "## Correction 56 does not record the repair",
  );
  expect(correctionHeadingIndices(semanticNegation, 56)).toHaveLength(1);
  expect(exactCorrectionHeadingIndices(semanticNegation, 56)).toEqual([]);

  const terminators = [
    ["LF", "\n"],
    ["CR", "\r"],
    ["LINE SEPARATOR", "\u2028"],
    ["PARAGRAPH SEPARATOR", "\u2029"],
  ] as const;
  expect(
    terminators.map(([label, terminator]) => ({
      label,
      count: exactCorrectionHeadingIndices(
        `before${terminator}## Correction 56\nbody`,
        56,
      ).length,
    })),
  ).toEqual([
    { label: "LF", count: 1 },
    { label: "CR", count: 0 },
    { label: "LINE SEPARATOR", count: 0 },
    { label: "PARAGRAPH SEPARATOR", count: 0 },
  ]);
  expect(
    terminators.map(([label, terminator]) => ({
      label,
      count: exactCorrectionHeadingIndices(
        `## Correction 56${terminator}body`,
        56,
      ).length,
    })),
  ).toEqual([
    { label: "LF", count: 1 },
    { label: "CR", count: 0 },
    { label: "LINE SEPARATOR", count: 0 },
    { label: "PARAGRAPH SEPARATOR", count: 0 },
  ]);
  for (const [, terminator] of terminators) {
    expect(
      exactCorrectionHeadingIndices(`## ${terminator}Correction 56\n`, 56),
    ).toEqual([]);
  }
});

const correction56ProofPaths = [
  ".orca/workflows/codebase-improvement.run.md",
  "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
  "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
  "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
] as const;

const correction56ProofRowIds = [
  "audit-terminal-ledger-recovery-reserve",
  "audit-canonical-publication-no-clobber",
] as const;

const correction56ExpectedSection = [
  "## Correction 56",
  "",
  "Two deadline and atomic-publication audit findings remained after Correction 55:",
  "",
  "- `audit-terminal-ledger-recovery-reserve`: Terminal-ledger commit now spends",
  "  the existing 1,000 ms reserve on its merge and runs one read-only recovery",
  "  validator under the remaining outer deadline. Both signal channels gate",
  "  recovery before and after it; a stalled validator is terminated and cannot",
  "  authorize success after cutoff.",
  "- `audit-canonical-publication-no-clobber`: Each canonical destination now uses",
  "  a destination-keyed `mkdir` publication lock held through the final absence",
  "  check and `mv`. Existing, invalid, SIGKILL-stale, or cleanup-stale locks fail",
  "  closed with status 73, while cleanup preserves an already committed move",
  "  status.",
  "",
  "The unchanged first 165 ledger rows retain SHA-256",
  "`62f6ed7843676b071f88908dcd82a0b9e64613d06cc1ad44da26a86fe8d862db`.",
  "Two append-only open rows bring the ledger to 167 rows and 167 unique IDs",
  "with SHA-256 `390a6523ffc73ddb04daba2820605115059a4032dd7c78ff32687008e91662ed`.",
  "",
  "The exact Correction 55 section remains 1,530 UTF-8 bytes with SHA-256",
  "`186c083d3f40dd8fd3e39903e794f29ad776802591ffb7b8a690d091ec209f13`. The C55",
  "successor digest",
  "`8e90acb21113296ff9d5590465273d38cbc0b265e5b5618ffda33e8a039cd5a6`",
  "is invalidated historical evidence and cannot authorize preflight or live",
  "execution.",
  "",
  "Measured Task 1 final focused verification passed 11/11 tests with 127",
  "assertions; `bash -n` and `bun run typecheck` passed. Measured Task 2 final",
  "focused verification passed 15/15 tests with 291 assertions; `/bin/bash -n`,",
  "`bash -n`, `bun run typecheck`, and `git diff --check` passed. These are the",
  "only executed results recorded in this static section.",
  "",
  "The full deterministic aggregate gate, successor manifest and digest, three",
  "successor audits, fresh simple preflight, live backend run, push, ready PR, CI",
  "wait, and SHA-locked squash merge remain pending. No preflight, live backend,",
  "push, PR, CI wait, merge, or GitHub mutation ran in Correction 56 Task 3.",
  "Fresh authorization remains required for any live run or GitHub write.",
  "",
].join("\n");

const correction56ExpectedSectionSha256 =
  "3122b34df66312a94ed78eb3631bc7e79b442d0e48bfe656f444da444b3e961e";

const correction56LedgerLines = [
  '{"id":"audit-terminal-ledger-recovery-reserve","runId":"correction56-verification-20260718","at":"2026-07-18T00:42:31.000Z","classification":"sla-overrun","stage":"correction56-verification","elapsedMs":0,"evidence":"Deadline and atomic-publication audit proved terminal-ledger recovery used the full outer deadline and then ran unsupervised record and SHA reads, so a cleanup timeout after canonical rename could be reset to success after cutoff.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
  '{"id":"audit-canonical-publication-no-clobber","runId":"correction56-verification-20260718","at":"2026-07-18T00:42:32.000Z","classification":"gate","stage":"correction56-verification","elapsedMs":0,"evidence":"Deadline and atomic-publication audit proved canonical latest and preflight publication checked destination absence before an overwriting move, so concurrent publishers could both succeed and leave a mixed evidence pair.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
] as const;

const correction57ProofRowIds = [
  "audit-stock-bash-harness-process-identity",
  "audit-terminal-ledger-post-commit-signal-recovery",
  "audit-harness-pipe-eof-before-group-cleanup",
] as const;

const correction57LedgerLines = [
  '{"id":"audit-stock-bash-harness-process-identity","runId":"correction57-verification-20260718","at":"2026-07-18T19:07:42.000Z","classification":"gate","stage":"correction57-verification","elapsedMs":0,"evidence":"The required stock-Bash artifact gate proved proof harnesses used Bash-4-only BASHPID under set -u, so macOS Bash 3.2 exited before signal, commit, and teardown markers and masked behavior with timeouts or missing files.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
  '{"id":"audit-terminal-ledger-post-commit-signal-recovery","runId":"correction57-verification-20260718","at":"2026-07-18T19:07:43.000Z","classification":"gate","stage":"correction57-verification","elapsedMs":0,"evidence":"The full artifact gate proved Correction 56 treated a caught launcher signal as proof that the terminal-ledger rename had not committed, skipping the exact record and hash recovery probe and returning 143 after an already-authorized canonical commit.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
  '{"id":"audit-harness-pipe-eof-before-group-cleanup","runId":"correction57-verification-20260718","at":"2026-07-18T19:07:44.000Z","classification":"gate","stage":"correction57-verification","elapsedMs":0,"evidence":"Independent Task 1 review proved both structured harnesses awaited inherited pipe EOF before bounded process-group cleanup, so a descendant could outlive its leader and block teardown and exact-root removal indefinitely.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
] as const;

const correction60ProofRowIds = [
  "audit-terminal-ledger-stage-no-follow",
  "audit-detached-descendant-trust-boundary",
  "audit-controller-wide-deadline-coverage",
  "audit-terminal-ledger-same-filesystem-rename",
  "audit-ci-probe-delivery-reserve",
] as const;

const correction60LedgerLines = [
  '{"id":"audit-terminal-ledger-stage-no-follow","runId":"correction60-verification-20260718","at":"2026-07-18T23:42:49.000Z","classification":"gate","stage":"correction60-verification","elapsedMs":0,"evidence":"Deadline and atomic-publication audit proved the predictable PID-derived terminal ledger stage could be precreated as a symlink; copy and validation followed it, and move installed the symlink as canonical mutable authority.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
  '{"id":"audit-detached-descendant-trust-boundary","runId":"correction60-verification-20260718","at":"2026-07-18T23:42:50.000Z","classification":"gate","stage":"correction60-verification","elapsedMs":0,"evidence":"Deadline and atomic-publication audit proved an adversarial same-UID descendant could clear the cooperative owner token and create a new session, escaping process-group cleanup and token-based owner inspection.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
  '{"id":"audit-controller-wide-deadline-coverage","runId":"correction60-verification-20260718","at":"2026-07-18T23:42:51.000Z","classification":"sla-overrun","stage":"correction60-verification","elapsedMs":0,"evidence":"Deadline and atomic-publication audit proved startup commands plus external clock, temporary-path, owner-scan, cleanup, and logging dependencies could stall outside the deadline controller and prevent bounded finalization.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
  '{"id":"audit-terminal-ledger-same-filesystem-rename","runId":"correction60-verification-20260718","at":"2026-07-18T23:42:52.000Z","classification":"gate","stage":"correction60-verification","elapsedMs":0,"evidence":"Deadline and atomic-publication audit proved the terminal ledger stage could be on a different filesystem from the canonical ledger, allowing move to degrade to interruptible copy-and-unlink and truncate canonical bytes.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
  '{"id":"audit-ci-probe-delivery-reserve","runId":"correction60-verification-20260718","at":"2026-07-18T23:42:53.000Z","classification":"sla-overrun","stage":"correction60-verification","elapsedMs":0,"evidence":"Deadline and atomic-publication audit proved head and CI probes could consume time declared reserved for merge and closure, so slow successful probes could exhaust the reserve and force a pre-merge abort.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
] as const;

const correction61ProofRowIds = [
  "audit-observed-once-residual-ownership",
] as const;

const correction61LedgerLines = [
  '{"id":"audit-observed-once-residual-ownership","runId":"correction61-verification-20260719","at":"2026-07-19T10:04:08.000Z","classification":"gate","stage":"correction61-verification","elapsedMs":0,"evidence":"Correction 60 review proved successful command status changed to 125 whenever a cooperative owner was observed during TERM cleanup even after final bounded inspection proved the owner set empty, contradicting the residual-ownership contract.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"independent-audit:no-monitor","status":"open"}',
] as const;

const correction62ProofRowIds = [
  "audit-controller-capture-signal-deferral",
  "audit-owner-cleanup-status-precedence",
] as const;

const correction62LedgerLines = [
  '{"id":"audit-controller-capture-signal-deferral","runId":"correction62-verification-20260719","at":"2026-07-19T11:39:04.000Z","classification":"gate","stage":"correction62-verification-20260719","elapsedMs":0,"evidence":"Correction 61 successor Audit 1 proved controller_capture_before_deadline ran controller_run_before_deadline inside command substitution, deferring launcher TERM during hanging now_ms and startup git capture and leaving controller residue.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"successor-audit:c61-1","status":"open"}',
  '{"id":"audit-owner-cleanup-status-precedence","runId":"correction62-verification-20260719","at":"2026-07-19T11:39:05.000Z","classification":"gate","stage":"correction62-verification-20260719","elapsedMs":0,"evidence":"Correction 61 successor Audit 1 proved post-command owner cleanup flattened controller timeout 124 and signal 143, 130, and 129 statuses to 125 at scan or caller boundaries, violating cleanup status precedence.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"successor-audit:c61-1","status":"open"}',
] as const;

const correction63ProofRowIds = [
  "audit-finalization-temp-symlink-overwrite",
  "audit-delivery-identity-deadline-bypass",
  "audit-cancellation-failure-settlement",
  "audit-terminal-subprocess-quiescence",
  "audit-reasoning-effort-model-compatibility",
] as const;

const correction63LedgerLines = [
  '{"id":"audit-finalization-temp-symlink-overwrite","runId":"correction63-broad-review-20260719","at":"2026-07-19T18:57:16.000Z","classification":"review","stage":"correction63-broad-review-20260719","elapsedMs":0,"evidence":"Correction 62 broad review proved finalization publication wrote a predictable temporary path through a symlink-following text helper, allowing a precreated symlink to overwrite an external file.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"broad-review:c62","status":"open"}',
  '{"id":"audit-delivery-identity-deadline-bypass","runId":"correction63-broad-review-20260719","at":"2026-07-19T18:57:17.000Z","classification":"review","stage":"correction63-broad-review-20260719","elapsedMs":0,"evidence":"Correction 62 broad review proved delivery identity lowercasing ran external tr pipelines in ordinary command substitutions outside the deadline controller, so capture could exceed its launcher deadline.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"broad-review:c62","status":"open"}',
  '{"id":"audit-cancellation-failure-settlement","runId":"correction63-broad-review-20260719","at":"2026-07-19T18:57:18.000Z","classification":"review","stage":"correction63-broad-review-20260719","elapsedMs":0,"evidence":"Correction 62 broad review proved rejected cancellation cleanup left awaitResult pending because cancellation blocked later success and failure settlement.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"broad-review:c62","status":"open"}',
  '{"id":"audit-terminal-subprocess-quiescence","runId":"correction63-broad-review-20260719","at":"2026-07-19T18:57:19.000Z","classification":"review","stage":"correction63-broad-review-20260719","elapsedMs":0,"evidence":"Correction 62 broad review proved terminal subprocess outcomes could publish before exit and cleanup, while the real spawner signalled only the leader and could leave descendants alive.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"broad-review:c62","status":"open"}',
  '{"id":"audit-reasoning-effort-model-compatibility","runId":"correction63-broad-review-20260719","at":"2026-07-19T18:57:20.000Z","classification":"review","stage":"correction63-broad-review-20260719","elapsedMs":0,"evidence":"Correction 62 broad review proved the documented six-value reasoning-effort union omitted selected-model and Codex CLI compatibility limits, implying universal acceptance.","backend":"codex","worktree":"/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop","branch":"meta/codebase-improvement-loop","monitorPath":"broad-review:c62","status":"open"}',
] as const;

function correction63LedgerInspectionIssues(ledgerBytes: Buffer): string[] {
  const issues: string[] = [];
  if (ledgerBytes.at(-1) !== 0x0a || ledgerBytes.at(-2) === 0x0a) {
    issues.push("Correction 63 ledger must end with exactly one LF");
  }
  const text = ledgerBytes.toString("utf8");
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  if (lines.length < 183) {
    issues.push(`Correction 63 ledger must retain 183 rows, received ${String(lines.length)}`);
  }
  const correction63Lines = lines.slice(0, 183);
  const prefixBytes = Buffer.from(`${correction63Lines.slice(0, 178).join("\n")}\n`);
  if (
    createHash("sha256").update(prefixBytes).digest("hex") !==
    "c196e0aa2c91f87540d1c2187d8b318f58fcacc7d6e319aeac5d9292fb2d338a"
  ) {
    issues.push("Correction 63 ledger first 178 rows changed");
  }
  if (
    correction63Lines.slice(178).join("\n") !==
    correction63LedgerLines.join("\n")
  ) {
    issues.push("Correction 63 appended rows must match exact ordered fields and evidence");
  }
  let rows: Record<string, unknown>[] = [];
  try {
    rows = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    issues.push("Correction 63 ledger rows must be valid JSON");
  }
  const correction63Rows = rows.slice(0, 183);
  if (new Set(correction63Rows.map((row) => row.id)).size !== 183) {
    issues.push("Correction 63 ledger must retain 183 unique IDs");
  }
  const expectedKeys = [
    "id",
    "runId",
    "at",
    "classification",
    "stage",
    "elapsedMs",
    "evidence",
    "backend",
    "worktree",
    "branch",
    "monitorPath",
    "status",
  ];
  if (
    correction63Rows.slice(178).some(
      (row) => JSON.stringify(Object.keys(row)) !== JSON.stringify(expectedKeys),
    )
  ) {
    issues.push("Correction 63 appended rows must preserve exact field order");
  }
  return issues;
}

const correction57ExpectedSection = [
  "## Correction 57",
  "",
  "The required stock-Bash artifact gate and independent Task 1 review exposed three",
  "proof failures after Correction 56:",
  "",
  "- `audit-stock-bash-harness-process-identity`: Explicit macOS Bash 3.2 proof now",
  "  uses portable top-level self-signalling and direct-child parent-PID capture for",
  "  background workers. Early child exit returns structured diagnostics, and exact",
  "  PID, process-group, stream, and temporary-root teardown remains bounded.",
  "- `audit-terminal-ledger-post-commit-signal-recovery`: A caught launcher signal",
  "  no longer decides whether the canonical ledger rename committed. One supervised",
  "  exact terminal-record and full-ledger-hash probe fails before rename and retains",
  "  status 143, or succeeds after an authorized rename and preserves committed",
  "  success. Terminal-commit signals still gate and override recovery.",
  "- `audit-harness-pipe-eof-before-group-cleanup`: Both structured harnesses start",
  "  draining pipes immediately but terminate their exact owned process groups before",
  "  awaiting EOF. A dual inherited-pipe regression proves no fallback kill, live",
  "  group, or exact temporary root remains.",
  "",
  "The unchanged first 167 ledger rows retain SHA-256",
  "`390a6523ffc73ddb04daba2820605115059a4032dd7c78ff32687008e91662ed`.",
  "Three append-only open rows bring the ledger to 170 rows and 170 unique IDs with",
  "SHA-256 `223969995ddcfdef812fe919e3f5a706e059278cfba592e3d8eec00286aae1de`.",
  "",
  "The exact Correction 56 section remains 2,091 UTF-8 bytes with SHA-256",
  "`3122b34df66312a94ed78eb3631bc7e79b442d0e48bfe656f444da444b3e961e`.",
  "No Correction 56 successor manifest or digest was created: its required isolated",
  "artifact gate failed before commit, lock generation, audits, or preflight.",
  "Correction 56 therefore remains historical static evidence and cannot authorize",
  "preflight or live execution.",
  "",
  "Final measured Correction 57 Task 1 verification passed the inherited-pipe test",
  "1/1 with 21 assertions, atomic family 4/4 with 93 assertions, terminal family",
  "5/5 with 61 assertions, and contract family 2/2 with 57 assertions: 12/12 tests",
  "and 232 assertions total. Both Bash syntax checks, exact non-skip flow typecheck,",
  "whitespace checks, protected-byte checks, and residue checks passed. Independent",
  "re-review repeated these gates and approved Task 1 with zero findings.",
  "",
  "The full isolated artifact suite, explicit four-suite aggregate, repository",
  "verification, Correction 57 successor manifest and digest, three sequential",
  "successor audits, fresh simple preflight, live backend run, push, ready PR, CI",
  "wait, unchanged-head proof, and SHA-locked squash merge remain pending. No",
  "preflight, live backend, push, PR, CI wait, merge, or GitHub mutation ran in",
  "Correction 57 Task 1 or Task 2. Fresh authorization remains required for the one",
  "live simple proving run and every GitHub write.",
  "",
].join("\n");

const correction57ExpectedSectionSha256 =
  "c5ef679021a6fdf2275764ea3ca3b94f9b760a9fc8b24f78cea364d9a4198955";

const correction60ExpectedSection = [
  "## Correction 60",
  "",
  "Five deadline and atomic-publication audit findings remained after Correction 59:",
  "",
  "- `audit-terminal-ledger-stage-no-follow`: Terminal-ledger publication now creates",
  "  one private `0600` six-X stage beside the canonical ledger after managed",
  "  children stop. Repeated regular-file, non-symlink, and same-parent checks fail",
  "  closed before copy, hashing, deadline authorization, and rename.",
  "- `audit-detached-descendant-trust-boundary`: Containment explicitly covers",
  "  process-group members and descendants retaining the inherited owner token.",
  "  Bounded inspection must prove that cooperative set empty. Arbitrary same-UID",
  "  hostile processes remain outside the proof, and no kernel isolation is claimed.",
  "- `audit-controller-wide-deadline-coverage`: Safe controller state and traps now",
  "  precede external work. A Bash-3.2-compatible low-level controller bounds startup,",
  "  command execution, owner scans, finalization, and cleanup with fixed descriptors,",
  "  builtin timing, TERM/KILL cutoffs, and fail-closed status. Captured stdout stays",
  "  inside the owned process group: an in-group broker isolates raw bytes from fd 7,",
  "  latches signals, publishes one length-checked typed frame, and leaves no capture",
  "  temporary file even when both owned groups receive SIGKILL.",
  "- `audit-terminal-ledger-same-filesystem-rename`: The terminal stage and canonical",
  "  ledger share one parent. Fresh hashes and boundary checks precede the positive",
  "  exact-deadline decision, followed immediately by same-directory `mv` with no",
  "  fallible operation inserted between authorization and rename.",
  "- `audit-ci-probe-delivery-reserve`: Head checks, CI reads, and pending poll sleep",
  "  use only the allowance remaining after the exact merge-confirmation and issue-",
  "  closure reserves. Non-positive allowance rejects before invocation.",
  "",
  "The unchanged first 170 ledger rows retain SHA-256",
  "`223969995ddcfdef812fe919e3f5a706e059278cfba592e3d8eec00286aae1de`.",
  "Five append-only open rows bring the ledger to 175 rows and 175 unique IDs with",
  "SHA-256 `cfa3814b36f66ffe8d8028e4c332ccb9cdb9a356f368248f3231128635283b67`.",
  "The primary package lock remains SHA-256",
  "`a9f2f75a69a2f247a00536a04d4b5be1cc36330c850c7fd31fdd388f7fd1f8f9`.",
  "",
  "The exact Correction 57 section remains 2,800 UTF-8 bytes with SHA-256",
  "`c5ef679021a6fdf2275764ea3ca3b94f9b760a9fc8b24f78cea364d9a4198955`.",
  "The Correction 59 successor digest",
  "`d6bbe87f4859eed4511017ae3fb465db4aa70f8a4b09a6b525bd2ef1e65a350f`",
  "is invalidated historical evidence and cannot authorize preflight or live",
  "execution.",
  "",
  "Task 1 through Task 4 used focused RED/GREEN, adversarial mutations, syntax or",
  "type checks, and independent review before Task 5 synchronization. Final triage",
  "also binds source probes to the current low-level controller and finalizer",
  "structure, gives detached-child readiness a disjoint margin before active TERM,",
  "uses a block-bodied CI sleep callback, and removes the guarded non-null assertion.",
  "",
  "Task 5a requires focused and adversarial gates, both Bash syntax checks, the",
  "stock-Bash artifact suite, four-suite aggregate, exact flow typecheck, docs gates,",
  "diff check, and repository verification on final bytes before freezing the new",
  "fourteen-file manifest and digest. Static prose and hashes are not execution",
  "evidence; the final Task 5 report records actual command outputs.",
  "",
  "Three sequential successor audits, no-write preflight, live backend proof, push,",
  "ready PR, CI wait, unchanged-head proof, and SHA-locked squash merge remain",
  "outside Task 5a and did not run in this phase. No commit or GitHub mutation ran.",
  "",
].join("\n");

const correction60ExpectedSectionSha256 =
  "7e0b1ceae71372a74841cf7280dbc9c6eb95bf3a9baca3ecc8b263690886511a";

const correction61ExpectedSection = [
  "## Correction 61",
  "",
  "One residual-ownership contract mismatch remained after Correction 60:",
  "",
  "- `audit-observed-once-residual-ownership`: Prior TERM or KILL discovery now",
  "  triggers cleanup without replacing a successful command status. Final bounded",
  "  `NONE` inspection is authoritative: a proven-empty cooperative owner set",
  "  preserves status `0`; inspection failure or residual ownership returns `125`.",
  "  Timeout `124` and signal `143`, `130`, and `129` behavior remains unchanged.",
  "",
  "The launcher, workflow contract, runbook, both plans, design, regression",
  "contracts, ledger, and progress now use final residual ownership rather than",
  "observed-once ownership. The detached-helper proof requires the helper dead,",
  "forbids its late write, and expects a successful leader to return `0`. A durable",
  "source mutation restores the old observed-once `125` branch and must fail that",
  "behavior proof.",
  "",
  "The unchanged first 175 ledger rows retain SHA-256",
  "`cfa3814b36f66ffe8d8028e4c332ccb9cdb9a356f368248f3231128635283b67`.",
  "One append-only open row brings the ledger to 176 rows and 176 unique IDs with",
  "SHA-256 `c1722959c52ce941b8cea542bec7d1f7171baab17387a18226c98baa39a9e2d2`.",
  "The primary package lock remains SHA-256",
  "`a9f2f75a69a2f247a00536a04d4b5be1cc36330c850c7fd31fdd388f7fd1f8f9`.",
  "",
  "The exact Correction 60 section remains 3,554 UTF-8 bytes with SHA-256",
  "`7e0b1ceae71372a74841cf7280dbc9c6eb95bf3a9baca3ecc8b263690886511a`.",
  "The Correction 60 successor digest",
  "`800f96b4aea138a9c26bc0d0d2ef306c4363ae91b4897ec48157197b557ac7b2`",
  "is invalidated historical evidence and cannot authorize successor audits,",
  "preflight, or live execution.",
  "",
  "Task 1 requires witnessed RED and GREEN, explicit old-rule mutation failure,",
  "both Bash syntax checks, exact flow typecheck, stock-Bash artifact gate,",
  "four-suite aggregate, docs gates, diff check, and repository verification on",
  "one final byte set. Static prose and hashes are not execution evidence; the",
  "Task 1 report and raw final-gate transcript record actual command outputs.",
  "",
  "Three sequential successor audits, no-write preflight, live backend proof,",
  "commit, push, ready PR, CI wait, unchanged-head proof, and SHA-locked squash",
  "merge remain outside Correction 61 Task 1 and did not run.",
  "",
].join("\n");

const correction61ExpectedSectionSha256 =
  "25cb9a47b3d40585c7a6ed8b758e25b694981426b2bb340112f519f0e3bfb754";

const correction62Heading =
  "## Correction 62 — controller capture and cleanup status precedence";

const correction62ExpectedSection = [
  correction62Heading,
  "",
  "Correction 61 successor Audit 1 exposed two controller-precedence defects:",
  "",
  "- `audit-controller-capture-signal-deferral`: Controller-side captures now",
  "  compute deadline cutoffs and invoke `controller_run_until --capture` directly",
  "  in the current shell, then assign through `printf -v`. Startup capture no",
  "  longer wraps the deadline controller in command substitution.",
  "- `audit-owner-cleanup-status-precedence`: Every bounded TERM, KILL, and final",
  "  NONE owner scan propagates timeout `124` and signals `143`, `130`, and `129`",
  "  unchanged. Unknown inspection failure or residual cooperative ownership still",
  "  returns `125`; the caller also latches a propagated signal status.",
  "",
  "Cleanup partition is exact: TERM `0` ends cleanup and `42` advances to KILL;",
  "KILL `0` or `42` advances to final NONE; final NONE `0` proves empty and `42`",
  "returns `125`. Each scan propagates `124`, `143`, `130`, or `129` and maps any",
  "other status to `125`.",
  "",
  "Capture protocol framing is fail-closed. Every successful NUL-delimited record",
  "must match typed PID, payload, or status syntax. A successful empty record has",
  "read status `0` but is untyped and returns `125`. The separate Bash 3.2 empty",
  "timed-poll case has read status `1` and continues only while the wrapper lives;",
  "dead-wrapper EOF and nonempty partial records return `125`.",
  "",
  "The real startup harness blocks both `now_ms` and startup Git capture, delivers",
  "TERM only after entry, and requires status `143` within 1,500 ms with no live",
  "controller or process-group residue. The cleanup matrix blocks TERM, KILL, or",
  "NONE inspection after leader exit and requires exact `124`, `143`, `130`, and",
  "`129` results with no controller residue. Executed historical command-substitution",
  "and cleanup-flattening mutations each failed their behavior proof; final restored",
  "bytes passed the focused family 4/4 with 63 assertions.",
  "",
  "The combined review regression injected an empty NUL record before valid frames",
  "and recorded its first read as status:length `0:0`; the old parser returned `0`",
  "instead of `125`. The one-line unconditional fallback passed 1/1 with 6",
  "assertions. Restoring the nonempty-only guard failed the durable contract with",
  "`captured broker must reject every untyped successful record`; restored",
  "behavior plus contract passed 2/2 with 13 assertions. The 11-case controller",
  "neighborhood passed 11/11 with 96 assertions.",
  "",
  "The unchanged first 176 ledger rows retain SHA-256",
  "`c1722959c52ce941b8cea542bec7d1f7171baab17387a18226c98baa39a9e2d2`.",
  "Two append-only open rows bring the ledger to 178 rows and 178 unique IDs with",
  "SHA-256 `c196e0aa2c91f87540d1c2187d8b318f58fcacc7d6e319aeac5d9292fb2d338a`.",
  "The primary package lock remains SHA-256",
  "`a9f2f75a69a2f247a00536a04d4b5be1cc36330c850c7fd31fdd388f7fd1f8f9`.",
  "",
  "The current Correction 62 fourteen-file manifest digest is externalized in",
  "`.superpowers/sdd/correction62-successor-digest.txt`. These proof documents are",
  "themselves manifest payloads, so embedding the numeric digest here would make",
  "the digest recursively depend on itself; the Task 1 report and frozen package",
  "bind the exact value.",
  "",
  "The exact Correction 61 section remains 2,206 UTF-8 bytes with SHA-256",
  "`25cb9a47b3d40585c7a6ed8b758e25b694981426b2bb340112f519f0e3bfb754`.",
  "The Correction 61 fourteen-file successor manifest digest",
  "`6d063971281ca6e6bf505bdc60120833fb52e559872e681fff51380c722aa6ac`",
  "is invalidated historical evidence and cannot authorize successor audits,",
  "preflight, or live execution.",
  "",
  "Final ordered verification passed paired 14/14 manifest checks with one unchanged",
  "digest, the focused Correction 62 family, the stock-Bash artifact suite, the",
  "four-suite aggregate, both Bash syntax checks, exact flow typecheck, docs gates,",
  "diff check, and repository verification. The raw transcript and Task 1 report",
  "record commands, outputs, statuses, durations, hashes, and residue checks.",
  "",
  "Containment remains cooperative: it covers process-group members and descendants",
  "retaining the inherited owner token. Arbitrary same-UID hostile processes remain",
  "outside the proof, and this is not kernel isolation. Successor audits, no-write",
  "preflight, live backend proof, commit, push, PR, CI wait, and merge remain outside",
  "Correction 62 Task 1 and did not run.",
  "",
].join("\n");

const correction62ExpectedSectionSha256 =
  "c30027f085ba22283e3a8816bf06567a441e70eb725d7b56f516b8012b530834";

const correction63Heading = "## Correction 63";

const correction63ExpectedSection = [
  correction63Heading,
  "",
  "Five final broad-review findings remained after Correction 62:",
  "",
  "- `audit-finalization-temp-symlink-overwrite`: Finalization text publication now",
  "  delegates to one runtime publisher. It creates a cryptographically random",
  "  same-directory regular file with `O_CREAT | O_EXCL | O_WRONLY` and mode",
  "  `0600`; write, durability, close, byte-count, and identity checks finish",
  "  before `commitPublication()`, with rename immediately next. Cleanup unlinks",
  "  only the exact created device/inode and never follows the old predictable",
  "  symlink.",
  "- `audit-delivery-identity-deadline-bypass`: Repository parsing assigns through",
  "  a validated output name and `printf -v` in the current shell. Both external",
  "  lowercase operations run through `capture_before_deadline`; timeout `124`,",
  "  fetch/push identity checks, and case-insensitive comparison remain intact.",
  "- `audit-cancellation-failure-settlement`: Failed cancellation cleanup now",
  "  stores one typed `BackendFailed` outcome plus the shared `cancel()` rejection",
  "  under the active outer settlement reservation. An internal completion channel",
  "  lets the run finalizer finish held stdout/stderr iterator teardown without",
  "  awaiting the public cancellation promise; outcome and rejection publish once",
  "  at final release.",
  "- `audit-terminal-subprocess-quiescence`: One terminal finalizer owns timeout,",
  "  cancellation, consumer failure, stream cleanup, bounded TERM-to-KILL, exit,",
  "  and reservation release. POSIX children use process groups and await leader",
  "  close plus group disappearance. The disappearance wait owns one cancellable",
  "  timer; any termination failure rejects the exit wait with the same error and",
  "  clears polling. Windows retains its gated leader fallback.",
  "- `audit-reasoning-effort-model-compatibility`: Both backend references state",
  "  that all six declared values forward to Codex without a local model catalog.",
  "  Acceptance depends on selected model and Codex CLI version; rejected",
  "  combinations return a backend failure.",
  "",
  "Final whole-change review found that cancellation failure still published before",
  "outer release, process-group disappearance polling could continue after bounded",
  "cleanup gave up, and timeout documentation incorrectly said `Conversation.signal`",
  "aborted. All three were repaired without changing runtime timeout signal",
  "semantics.",
  "",
  "A later whole-re-review found that canonical cancellation docs described only",
  "successful cleanup: they promised that `cancel()` resolves and",
  "`awaitResult()` becomes cancelled, but omitted the cleanup-failure path. Both",
  "documentation surfaces now preserve normal successful cancellation and state",
  "that cleanup failure rejects the shared cancellation promise and publishes a",
  "typed `BackendFailed` only after final cleanup and settlement release.",
  "",
  "Strict RED/GREEN and mutation proof preceded synchronization. The finalization",
  "RED changed an external file through the planted predictable symlink; GREEN",
  "passed 2/2 with 62 assertions, and restoring the old publisher failed the",
  "external-byte assertion. The delivery RED entered a PATH-shadowed hanging `tr`",
  "and returned `143` instead of required `124`; GREEN passed 2/2 with 23",
  "assertions, and restoring command substitution reproduced the failure.",
  "",
  "Cancellation, reservation, terminal-consumer, real POSIX group, terminal-family,",
  "and stderr-cleanup REDs all exposed premature or missing settlement. The first",
  "Slice C freeze passed 90/90 with 250 assertions; cancellation, reservation,",
  "immediate-kill, and leader-only historical mutations each failed.",
  "",
  "Final-review REDs then observed cancellation outcome and rejection before outer",
  "release and before held stdout/stderr teardown. A naive public-result deferral",
  "mutation stalled teardown. GREEN passed the reservation unit 1/1 with 5",
  "assertions and held-stream integration 1/1 with 6 assertions. The group-poll RED",
  "scheduled three additional 10 ms timers after termination failure; GREEN passed",
  "1/1 with 4 assertions, proving the exit wait rejected with the same error and",
  "left zero polling timers. Removing registered poll cancellation reproduced a",
  "pending exit. The timeout-doc lock RED missed the actual-signal contract; GREEN",
  "passed 1/1 with 9 assertions, and restoring the false signal-abort claim failed.",
  "",
  "The cancellation-doc lock RED missed the success/failure contract and failed",
  "0/1 after one assertion. GREEN passed 1/1 with 6 assertions. Restoring the",
  "resolve-only claim failed 0/1 with 3 assertions, then exact GREEN bytes were",
  "restored. No runtime semantic changed.",
  "",
  "A later successful-cancel cleanup audit found that subprocess finalization",
  "discarded stdout/stderr cleanup errors after termination had succeeded. The",
  "pending cancellation outcome therefore published as `cancelled` and the shared",
  "`cancel()` promise resolved even though owned stream teardown failed.",
  "",
  "The qualifying RED held both cleanup paths, rejected stdout cleanup, completed",
  "stderr cleanup, and received `{ type: \"cancelled\", reason: \"stop\" }` instead of",
  "a typed `BackendFailed`; the shared cancellation promise resolved. GREEN",
  "registers one internal late-failure handler with the shared promise.",
  "Cancellation cleanup failure has higher settlement priority than successful",
  "cancellation and reports a cleanup error before final release. Outcome remains",
  "pending until both streams finish, then typed failure publishes before the exact",
  "cleanup error rejects the shared promise. Timeout stream cleanup errors likewise",
  "win before timeout settlement. The focused GREEN passed 1/1 with 8 assertions;",
  "restoring discarded `await cleanupStreams()` in both cancellation paths failed",
  "0/1 with the same cancelled outcome. Exact source bytes were restored and GREEN",
  "passed again. A final lifecycle re-review then found that consumer and timeout",
  "cleanup errors still called `conversation.fail` after cancellation had started.",
  "Active cancellation made those calls no-ops, so `cancel()` resolved and a",
  "`cancelled` outcome hid the teardown error. It also found no deadline around",
  "stdout iterator return, line-generator return, stderr cancellation/return, or an",
  "awaited stderr collector result after process exit; any one could retain run or",
  "timeout settlement reservations forever.",
  "",
  "Four real-behavior REDs received two `cancelled` outcomes and two pending",
  "sentinels. GREEN routes consumer and timeout cleanup errors through the registered",
  "cancellation-failure handler only while cancellation owns settlement, preserving",
  "ordinary timeout failure ordering. Finalization starts one absolute",
  "stream-teardown deadline from the configured wall-clock budget. Every awaited",
  "stdout and stderr teardown shares its remaining time; expiry becomes a typed",
  "cleanup failure and every reservation releases.",
  "",
  "The final focused GREEN passed 4/4 with 7 assertions. Disabling cancellation-",
  "failure routing failed 0/2 and again published `cancelled`; disabling deadline",
  "rejection failed 0/2 with both paths still pending. Exact bytes were restored.",
  "",
  "A subsequent whole-review-4 race found that the terminal-error finalizer discarded",
  "cleanup errors returned by `terminateAndCleanup(false)`. When a consumer error",
  "started termination, cancellation began while exit was pending, and stdout",
  "iterator return rejected, the run preserved its primary rejection but `cancel()`",
  "resolved and `awaitResult()` returned `cancelled`.",
  "",
  "The one-test RED recorded exactly those three outcomes. GREEN captures returned",
  "cleanup errors; while cancellation is active it reports the first through the",
  "registered cancellation-failure handler before rethrowing the exact primary",
  "error. Without cancellation, the primary error keeps precedence. Removing only",
  "that routing reproduced the same RED. Exact bytes passed the focused race 1/1",
  "with 4 assertions, the full Codex file 45/45 with 135 assertions, and 20/20",
  "repeated race runs.",
  "",
  "A successor-audit-2 docs review found that the website introduction still",
  "claimed every fallible operation returns a `Result`, contradicting the same",
  "page's typed asynchronous cancellation-cleanup contract. Result-returning",
  "operations now represent expected failures as values, while asynchronous",
  "lifecycle methods retain promise semantics: public `cancel()` resolves after",
  "successful cleanup and rejects when cleanup fails.",
  "",
  "The deterministic wording lock RED passed 20 existing tests and failed the new",
  "claim with 56 assertions. GREEN passed 21/21 with 57 assertions. Restoring the",
  "old absolute wording reproduced the same RED; restoring exact bytes passed the",
  "targeted test, documentation links, and documentation symbols. No runtime",
  "semantic changed.",
  "",
  "The four affected backend/conversation suites passed 98/98 with 280 assertions,",
  "and the regression passed 20/20 repeated runs. Typecheck, lint,",
  "declarations/signatures, facade, and diff checks passed. Independent scoped",
  "review returned Spec PASS, Quality PASS, and zero findings.",
  "",
  "Final Slice C, backend, and reasoning coverage passed 106/106 with 301 assertions.",
  "Reasoning-effort RED passed all six forwarding cases but failed the missing",
  "two-surface contract; its original GREEN passed 7/7 with 8 assertions, and",
  "suppressing `ultra` failed its table row.",
  "",
  "The ledger RED expected 183 rows and received 178. Exact append, prefix, field",
  "order, evidence, uniqueness, and one-LF EOF locks passed 3/3 with 25 assertions;",
  "order, field, semantic, duplicate-ID, and EOF mutations were all rejected. Four",
  "proof documents now carry this byte-identical section once at EOF, with heading,",
  "row-order, count, status, semantics, hash, and post-EOF mutations locked.",
  "",
  "The unchanged first 178 ledger rows retain SHA-256",
  "`c196e0aa2c91f87540d1c2187d8b318f58fcacc7d6e319aeac5d9292fb2d338a`.",
  "Five append-only open rows bring the ledger to 183 rows and 183 unique IDs,",
  "110,097 bytes, and SHA-256",
  "`6544bd11a635893b1f2890b3306fc27d4aac3fbe3724eac0d44bd66fddb63a03`.",
  "The five-row suffix SHA-256 is",
  "`f7bef2e8a82622fe84b2639b32747ac0f977fa53a210d219fd2fb5637da93d5b`.",
  "The primary package lock remains SHA-256",
  "`a9f2f75a69a2f247a00536a04d4b5be1cc36330c850c7fd31fdd388f7fd1f8f9`.",
  "The exact Correction 62 section remains 4,272 UTF-8 bytes with SHA-256",
  "`c30027f085ba22283e3a8816bf06567a441e70eb725d7b56f516b8012b530834`.",
  "",
  "The Correction 62 successor digest is invalidated historical evidence. The",
  "Correction 63 fourteen-file successor digest, separate correction-runtime",
  "manifest, gate-log hash, and package hash are externalized in the Task 1 report",
  "and frozen review package. Protected proof documents are manifest inputs, and",
  "the gate log contains manifest checks, so embedding those values here would",
  "create recursive hash dependencies.",
  "",
  "Final ordered verification on frozen bytes passed affected workflow suites, all",
  "Slice C suites, backend and reasoning tests, cancellation, timeout, and",
  "Result/lifecycle documentation locks, system and Homebrew Bash syntax, exact",
  "flow typecheck, documentation",
  "links and symbols, lint, typecheck, diff check, and `bun run verify`. Paired",
  "pre/post manifest, package-lock, 178-row prefix, HEAD/branch, process, and",
  "temporary-residue checks remained unchanged.",
  "",
  "Correction 62's first ordered aggregate had one load-sensitive existing terminal-",
  "ledger recovery fixture fail once. It then passed unchanged 3/3 alone, the exact",
  "aggregate retry, and the restarted final sequence. That historical timing",
  "concern remains preserved rather than hidden.",
  "",
  "The protected launcher artifact set remains exactly fourteen files; a separate",
  "eleven-file manifest covers correction-only runtime, tests, and backend docs.",
  "Public `Conversation` and package-root exports remain unchanged. Stock Bash 3.2",
  "status",
  "mapping remains `124`, `143`/`130`/`129`, and `125` as documented. Real process-",
  "group behavior ran on macOS; the gated Windows fallback was not runtime-tested.",
  "Candidate worktrees still start from `origin/main`; no history rewrite occurred.",
  "",
  "Live acceptance, successor audit, no-write preflight, live backend, commit, push,",
  "PR, CI wait, merge, and GitHub mutation remain outside Correction 63 Task 1 and",
  "did not run.",
  "",
].join("\n");

const correction63ExpectedSectionSha256 =
  "87612f7ef4aa2cf23d801cd101bb9f610759bd2fab615bca67b8d50ecb73cc59";

test("proof documents preserve one exact Correction 55 section before exact C56", async () => {
  const proofPaths = [
    ".orca/workflows/codebase-improvement.run.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-loop.md",
    "docs/superpowers/plans/2026-07-10-codebase-improvement-scout-correction.md",
    "docs/superpowers/specs/2026-07-10-codebase-improvement-loop-design.md",
  ];
  const rowIds = ["audit-correction-heading-line-terminator-exclusion"];
  const expectedSection = [
    "## Correction 55",
    "",
    "One proof-evidence audit finding remained after Correction 54:",
    "",
    "- `audit-correction-heading-line-terminator-exclusion`: Both correction-heading",
    "  free-text fragments now exclude CR, LF, LINE SEPARATOR, and PARAGRAPH",
    "  SEPARATOR; a Markdown marker cannot borrow a later Correction label across",
    "  any ECMAScript line terminator.",
    "",
    "The unchanged first 164 ledger rows retain SHA-256",
    "`1311cdd92f9177984ccce0f74d3f8c794c13529b86837503b1597502008a723c`.",
    "One append-only open row brings the ledger to 165 rows and 165 unique IDs",
    "with SHA-256 `62f6ed7843676b071f88908dcd82a0b9e64613d06cc1ad44da26a86fe8d862db`.",
    "",
    "Static hashes bind wording and history only. Executed focused and aggregate",
    "gate outputs plus a fresh preflight prove execution. Historical measured-count",
    "prose remains locked documentation, not evidence that those commands ran.",
    "",
    "Final measured Task 1 gate: focused proof document policy, Correction 54, and",
    "Correction 55 verification passes 7/7 with 98 assertions.",
    "The Task 2 aggregate gate, three successor audits, and fresh preflight remain",
    "pending and must execute; their later outputs, not this static section, prove",
    "those actions.",
    "",
    "The Correction 54 successor digest",
    "`7f66b7c0a901ac6ca5632dc93a1f6bf8ab4aeb09d356db5641001d97ba963e6a`",
    "is invalidated historical evidence and cannot authorize preflight or live",
    "execution.",
    "",
    "No C55 successor manifest, successor audit, preflight, live backend, push, PR,",
    "CI wait, or merge ran in Task 1. Fresh authorization remains required for any",
    "live run or GitHub write.",
    "",
  ].join("\n");
  const expectedSha256 =
    "186c083d3f40dd8fd3e39903e794f29ad776802591ffb7b8a690d091ec209f13";
  const sections: string[] = [];

  for (const proofPath of proofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(source, 55, rowIds, 56, {
      next: "exact",
    });
    expect(inspection.issues, proofPath).toEqual([]);
    expect(inspection.section, proofPath).toBe(expectedSection);
    expect(Buffer.byteLength(inspection.section!, "utf8"), proofPath).toBe(1530);
    expect(inspection.sha256, proofPath).toBe(expectedSha256);
    sections.push(inspection.section!);
  }
  expect(new Set(sections).size).toBe(1);

  const source = await Bun.file(proofPaths[0]!).text();
  const semanticNegation = source.replace(
    "## Correction 55",
    "## Correction 55 does not record the repair",
  );
  expect(semanticNegation).not.toBe(source);
  const negatedInspection = inspectCorrectionProofSection(
    semanticNegation,
    55,
    rowIds,
    56,
    { next: "exact" },
  );
  expect(negatedInspection.issues).toEqual([]);
  expect(
    correctionSectionLockIssues(negatedInspection, 55, expectedSha256),
  ).toEqual(["Correction 55 section SHA-256 mismatch"]);

  const boundaryMutations = [
    ["missing", source.replace("## Correction 56", "## Correction 560"), 0],
    [
      "duplicate",
      source.replace("## Correction 56", "## Correction 56\n## Correction 56"),
      2,
    ],
    ["LF-forged", source.replace("## Correction 56", "##\nCorrection 56"), 0],
    ["CR-forged", source.replace("## Correction 56", "##\rCorrection 56"), 0],
    [
      "LINE-SEPARATOR-forged",
      source.replace("## Correction 56", "##\u2028Correction 56"),
      0,
    ],
    [
      "PARAGRAPH-SEPARATOR-forged",
      source.replace("## Correction 56", "##\u2029Correction 56"),
      0,
    ],
    [
      "semantic-negation",
      source.replace(
        "## Correction 56",
        "## Correction 56 does not record the repair",
      ),
      0,
    ],
  ] as const;
  for (const [name, mutation, count] of boundaryMutations) {
    expect(
      inspectCorrectionProofSection(mutation, 55, rowIds, 56, {
        next: "exact",
      }).issues,
      name,
    ).toEqual([
      `Correction 56 boundary heading count must be 1, received ${count}`,
    ]);
  }
});

test("Correction 55 ledger prefix remains exact after C56 append", async () => {
  const ledger = await Bun.file(".orca/improvement-loop/issues.jsonl").text();
  expect(ledger.endsWith("\n")).toBe(true);
  const ledgerLines = ledger.trimEnd().split("\n");
  const correction55Lines = ledgerLines.slice(0, 165);
  const rows = correction55Lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  expect(rows).toHaveLength(165);
  expect(new Set(rows.map((row) => row.id)).size).toBe(165);
  expect(
    createHash("sha256")
      .update(`${ledgerLines.slice(0, 164).join("\n")}\n`)
      .digest("hex"),
  ).toBe(
    "1311cdd92f9177984ccce0f74d3f8c794c13529b86837503b1597502008a723c",
  );
  expect(rows.at(-1)).toEqual({
    id: "audit-correction-heading-line-terminator-exclusion",
    runId: "correction55-verification-20260717",
    at: "2026-07-17T13:09:06.000Z",
    classification: "gate",
    stage: "correction55-verification",
    elapsedMs: 0,
    evidence:
      "Proof/evidence audit proved the correction-heading matcher excluded only LF, so CR, LINE SEPARATOR, and PARAGRAPH SEPARATOR could place a Correction token on a later logical line and forge a section boundary.",
    backend: "codex",
    worktree:
      "/Users/ahmad.ragab/Dev/tools/orca-ts/.worktrees/meta-codebase-improvement-loop",
    branch: "meta/codebase-improvement-loop",
    monitorPath: "independent-audit:no-monitor",
    status: "open",
  });
  expect(
    createHash("sha256")
      .update(`${correction55Lines.join("\n")}\n`)
      .digest("hex"),
  ).toBe(
    "62f6ed7843676b071f88908dcd82a0b9e64613d06cc1ad44da26a86fe8d862db",
  );
});

test("Correction 56 ledger remains exact before C57 append", async () => {
  const ledgerBytes = Buffer.from(
    await Bun.file(".orca/improvement-loop/issues.jsonl").arrayBuffer(),
  );

  let lineCount = 0;
  let correction55End = -1;
  let prefixEnd = -1;
  for (let index = 0; index < ledgerBytes.byteLength; index += 1) {
    if (ledgerBytes[index] !== 0x0a) continue;
    lineCount += 1;
    if (lineCount === 165) correction55End = index + 1;
    if (lineCount === 167) prefixEnd = index + 1;
  }
  expect(lineCount).toBeGreaterThanOrEqual(183);
  expect(correction55End).toBeGreaterThan(0);
  expect(prefixEnd).toBe(99_873);
  const correction56Bytes = ledgerBytes.subarray(0, prefixEnd);
  expect(correction56Bytes.at(-1)).toBe(0x0a);
  expect(correction56Bytes.at(-2)).not.toBe(0x0a);
  expect(
    createHash("sha256")
      .update(correction56Bytes.subarray(0, correction55End))
      .digest("hex"),
  ).toBe(
    "62f6ed7843676b071f88908dcd82a0b9e64613d06cc1ad44da26a86fe8d862db",
  );

  const ledgerText = correction56Bytes.toString("utf8");
  const ledgerLines = ledgerText.slice(0, -1).split("\n");
  expect(ledgerLines).toHaveLength(167);
  expect(ledgerLines.slice(-2)).toEqual(correction56LedgerLines);
  const rows = ledgerLines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  expect(new Set(rows.map((row) => row.id)).size).toBe(167);
  expect(rows.slice(-2).map((row) => row.id)).toEqual(correction56ProofRowIds);
  expect(createHash("sha256").update(correction56Bytes).digest("hex")).toBe(
    "390a6523ffc73ddb04daba2820605115059a4032dd7c78ff32687008e91662ed",
  );
});

test("proof documents preserve exact Correction 56 before exact C57 boundary", async () => {
  expect(Buffer.byteLength(correction56ExpectedSection, "utf8")).toBe(2091);
  expect(
    createHash("sha256").update(correction56ExpectedSection).digest("hex"),
  ).toBe(correction56ExpectedSectionSha256);

  const sections: string[] = [];
  for (const proofPath of correction56ProofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(
      source,
      56,
      correction56ProofRowIds,
      57,
      { current: "exact", next: "exact" },
    );
    expect(inspection.issues, proofPath).toEqual([]);
    if (inspection.section === undefined) continue;
    expect(inspection.section, proofPath).toBe(correction56ExpectedSection);
    expect(Buffer.byteLength(inspection.section, "utf8"), proofPath).toBe(2091);
    expect(inspection.sha256, proofPath).toBe(correction56ExpectedSectionSha256);
    expect(
      source.includes(`${correction56ExpectedSection}## Correction 57\n`),
      proofPath,
    ).toBe(true);
    sections.push(inspection.section);
  }
  expect(sections).toHaveLength(correction56ProofPaths.length);
  expect(new Set(sections).size).toBe(1);
});

test("Correction 56 lock rejects exact C57 boundary and C56 body mutations", () => {
  const source =
    `historical proof\n${correction56ExpectedSection}${correction57ExpectedSection}`;
  const inspect = (candidate: string) =>
    inspectCorrectionProofSection(
      candidate,
      56,
      correction56ProofRowIds,
      57,
      { current: "exact", next: "exact" },
    );
  expect(correctionSectionLockIssues(inspect(source), 56, correction56ExpectedSectionSha256)).toEqual([]);

  const headingMutations = [
    ["missing", source.replace("## Correction 57", "## Correction 570"), 0],
    [
      "duplicate",
      source.replace("## Correction 57", "## Correction 57\n## Correction 57"),
      2,
    ],
    ["LF-forged", source.replace("## Correction 57", "##\nCorrection 57"), 0],
    ["CR-forged", source.replace("## Correction 57", "##\rCorrection 57"), 0],
    [
      "LINE-SEPARATOR-forged",
      source.replace("## Correction 57", "##\u2028Correction 57"),
      0,
    ],
    [
      "PARAGRAPH-SEPARATOR-forged",
      source.replace("## Correction 57", "##\u2029Correction 57"),
      0,
    ],
    [
      "semantic-negation",
      source.replace(
        "## Correction 57",
        "## Correction 57 does not record the repair",
      ),
      0,
    ],
  ] as const;
  for (const [name, mutation, count] of headingMutations) {
    expect(inspect(mutation).issues, name).toEqual([
      `Correction 57 boundary heading count must be 1, received ${count}`,
    ]);
  }

  const reversedAnchors = source
    .replace(correction56ProofRowIds[0], "__C56_FIRST__")
    .replace(correction56ProofRowIds[1], correction56ProofRowIds[0])
    .replace("__C56_FIRST__", correction56ProofRowIds[1]);
  expect(inspect(reversedAnchors).issues).toEqual([
    "Correction 56 order must be heading < ordered row anchors < Correction 57",
  ]);

  const bodyPolarityMutations = [
    source.replace(
      "cannot\n  authorize success after cutoff",
      "can\n  authorize success after cutoff",
    ),
    source.replace(
      "locks fail\n  closed with status 73",
      "locks do not fail\n  closed with status 73",
    ),
    source.replace(
      "is invalidated historical evidence",
      "is valid historical evidence",
    ),
    source.replace(
      "squash merge remain pending",
      "squash merge are complete",
    ),
  ];
  for (const mutation of bodyPolarityMutations) {
    expect(mutation).not.toBe(source);
    expect(
      correctionSectionLockIssues(
        inspect(mutation),
        56,
        correction56ExpectedSectionSha256,
      ),
    ).toEqual(["Correction 56 section SHA-256 mismatch"]);
  }
});

test("Correction 57 ledger remains exact before C60 append", async () => {
  const ledgerBytes = Buffer.from(
    await Bun.file(".orca/improvement-loop/issues.jsonl").arrayBuffer(),
  );
  expect(ledgerBytes.at(-1)).toBe(0x0a);
  expect(ledgerBytes.at(-2)).not.toBe(0x0a);

  let lineCount = 0;
  let correction56End = -1;
  let correction57End = -1;
  for (let index = 0; index < ledgerBytes.byteLength; index += 1) {
    if (ledgerBytes[index] !== 0x0a) continue;
    lineCount += 1;
    if (lineCount === 167) correction56End = index + 1;
    if (lineCount === 170) correction57End = index + 1;
  }
  expect(lineCount).toBeGreaterThanOrEqual(183);
  expect(correction56End).toBe(99_873);
  expect(correction57End).toBe(101_860);
  const prefix = ledgerBytes.subarray(0, correction56End);
  expect(createHash("sha256").update(prefix).digest("hex")).toBe(
    "390a6523ffc73ddb04daba2820605115059a4032dd7c78ff32687008e91662ed",
  );

  const correction57Bytes = ledgerBytes.subarray(0, correction57End);
  const ledgerText = correction57Bytes.toString("utf8");
  const ledgerLines = ledgerText.slice(0, -1).split("\n");
  expect(ledgerLines).toHaveLength(170);
  expect(ledgerLines.slice(-3)).toEqual(correction57LedgerLines);
  const lastThreeBytes = Buffer.from(`${correction57LedgerLines.join("\n")}\n`);
  expect(createHash("sha256").update(lastThreeBytes).digest("hex")).toBe(
    "e19e40fcfa2f88c9167fa49136874722f5317aba09de0abd43d7b39b62e7bf1e",
  );
  const rows = ledgerLines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  expect(new Set(rows.map((row) => row.id)).size).toBe(170);
  expect(rows.slice(-3).map((row) => row.id)).toEqual(correction57ProofRowIds);
  expect(rows.slice(-3).every((row) => row.status === "open")).toBe(true);
  expect(createHash("sha256").update(correction57Bytes).digest("hex")).toBe(
    "223969995ddcfdef812fe919e3f5a706e059278cfba592e3d8eec00286aae1de",
  );
});

test("Correction 60 ledger appends five exact open rows", async () => {
  const ledgerBytes = Buffer.from(
    await Bun.file(".orca/improvement-loop/issues.jsonl").arrayBuffer(),
  );
  expect(ledgerBytes.byteLength).toBeGreaterThanOrEqual(110_097);
  expect(ledgerBytes.at(-1)).toBe(0x0a);
  expect(ledgerBytes.at(-2)).not.toBe(0x0a);

  let lineCount = 0;
  let prefixEnd = -1;
  let correction60End = -1;
  for (let index = 0; index < ledgerBytes.byteLength; index += 1) {
    if (ledgerBytes[index] !== 0x0a) continue;
    lineCount += 1;
    if (lineCount === 170) prefixEnd = index + 1;
    if (lineCount === 175) correction60End = index + 1;
  }
  expect(lineCount).toBeGreaterThanOrEqual(183);
  expect(prefixEnd).toBe(101_860);
  const prefix = ledgerBytes.subarray(0, prefixEnd);
  expect(createHash("sha256").update(prefix).digest("hex")).toBe(
    "223969995ddcfdef812fe919e3f5a706e059278cfba592e3d8eec00286aae1de",
  );

  expect(correction60End).toBe(105_085);
  const correction60Bytes = ledgerBytes.subarray(0, correction60End);
  const ledgerText = correction60Bytes.toString("utf8");
  const ledgerLines = ledgerText.slice(0, -1).split("\n");
  expect(ledgerLines).toHaveLength(175);
  expect(ledgerLines.slice(-5)).toEqual(correction60LedgerLines);
  const lastFiveBytes = Buffer.from(`${correction60LedgerLines.join("\n")}\n`);
  expect(createHash("sha256").update(lastFiveBytes).digest("hex")).toBe(
    "fee139a660415e3d3fc2c65a9ffe4a6dfafca9dd7afa127f69cb66e4025b9a4a",
  );
  const rows = ledgerLines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  expect(new Set(rows.map((row) => row.id)).size).toBe(175);
  expect(rows.slice(-5).map((row) => row.id)).toEqual(correction60ProofRowIds);
  expect(rows.slice(-5).every((row) => row.status === "open")).toBe(true);
  expect(createHash("sha256").update(correction60Bytes).digest("hex")).toBe(
    "cfa3814b36f66ffe8d8028e4c332ccb9cdb9a356f368248f3231128635283b67",
  );
});

test("Correction 61 ledger preserves exact 175-row prefix and appends one open row", async () => {
  const ledgerBytes = Buffer.from(
    await Bun.file(".orca/improvement-loop/issues.jsonl").arrayBuffer(),
  );
  expect(ledgerBytes.byteLength).toBeGreaterThanOrEqual(110_097);
  expect(ledgerBytes.at(-1)).toBe(0x0a);
  expect(ledgerBytes.at(-2)).not.toBe(0x0a);

  let lineCount = 0;
  let prefixEnd = -1;
  let correction61End = -1;
  for (let index = 0; index < ledgerBytes.byteLength; index += 1) {
    if (ledgerBytes[index] !== 0x0a) continue;
    lineCount += 1;
    if (lineCount === 175) prefixEnd = index + 1;
    if (lineCount === 176) correction61End = index + 1;
  }
  expect(lineCount).toBeGreaterThanOrEqual(183);
  expect(prefixEnd).toBe(105_085);
  const prefix = ledgerBytes.subarray(0, prefixEnd);
  expect(createHash("sha256").update(prefix).digest("hex")).toBe(
    "cfa3814b36f66ffe8d8028e4c332ccb9cdb9a356f368248f3231128635283b67",
  );

  expect(correction61End).toBe(105_752);
  const correction61Bytes = ledgerBytes.subarray(0, correction61End);
  const ledgerText = correction61Bytes.toString("utf8");
  const ledgerLines = ledgerText.slice(0, -1).split("\n");
  expect(ledgerLines).toHaveLength(176);
  expect(ledgerLines.slice(-1)).toEqual(correction61LedgerLines);
  const lastRowBytes = Buffer.from(`${correction61LedgerLines[0]}\n`);
  expect(createHash("sha256").update(lastRowBytes).digest("hex")).toBe(
    "79ba5a2968c530dc46e51325730af49f4582aa24c9fa58294557b45dbc4095b0",
  );
  const rows = ledgerLines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  expect(new Set(rows.map((row) => row.id)).size).toBe(176);
  expect(rows.slice(-1).map((row) => row.id)).toEqual(correction61ProofRowIds);
  expect(rows.at(-1)?.status).toBe("open");
  expect(createHash("sha256").update(correction61Bytes).digest("hex")).toBe(
    "c1722959c52ce941b8cea542bec7d1f7171baab17387a18226c98baa39a9e2d2",
  );
});

test("Correction 62 ledger preserves exact 176-row prefix and appends two open rows", async () => {
  const ledgerBytes = Buffer.from(
    await Bun.file(".orca/improvement-loop/issues.jsonl").arrayBuffer(),
  );
  expect(ledgerBytes.at(-1)).toBe(0x0a);
  expect(ledgerBytes.at(-2)).not.toBe(0x0a);

  let lineCount = 0;
  let prefixEnd = -1;
  let correction62End = -1;
  for (let index = 0; index < ledgerBytes.byteLength; index += 1) {
    if (ledgerBytes[index] !== 0x0a) continue;
    lineCount += 1;
    if (lineCount === 176) prefixEnd = index + 1;
    if (lineCount === 178) correction62End = index + 1;
  }
  expect(lineCount).toBeGreaterThanOrEqual(183);
  expect(prefixEnd).toBe(105_752);
  const prefix = ledgerBytes.subarray(0, prefixEnd);
  expect(createHash("sha256").update(prefix).digest("hex")).toBe(
    "c1722959c52ce941b8cea542bec7d1f7171baab17387a18226c98baa39a9e2d2",
  );

  expect(correction62End).toBe(107_058);
  const correction62Bytes = ledgerBytes.subarray(0, correction62End);
  const ledgerText = correction62Bytes.toString("utf8");
  const ledgerLines = ledgerText.slice(0, -1).split("\n");
  expect(ledgerLines).toHaveLength(178);
  expect(ledgerLines.slice(-2)).toEqual(correction62LedgerLines);
  const lastTwoBytes = Buffer.from(`${correction62LedgerLines.join("\n")}\n`);
  expect(createHash("sha256").update(lastTwoBytes).digest("hex")).toBe(
    "dfcc549c64c03b293759bfa8f06d554ab3bdd76cae2d74ae56d29658de88fe00",
  );
  const rows = ledgerLines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  expect(new Set(rows.map((row) => row.id)).size).toBe(178);
  expect(rows.slice(-2).map((row) => row.id)).toEqual(correction62ProofRowIds);
  expect(rows.slice(-2).every((row) => row.status === "open")).toBe(true);
  expect(createHash("sha256").update(correction62Bytes).digest("hex")).toBe(
    "c196e0aa2c91f87540d1c2187d8b318f58fcacc7d6e319aeac5d9292fb2d338a",
  );
});

test("Correction 63 ledger preserves 178 rows and appends five exact open findings", async () => {
  const ledgerBytes = Buffer.from(
    await Bun.file(".orca/improvement-loop/issues.jsonl").arrayBuffer(),
  );
  expect(ledgerBytes.byteLength).toBeGreaterThanOrEqual(110_097);
  expect(correction63LedgerInspectionIssues(ledgerBytes)).toEqual([]);
  const rows = ledgerBytes
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows.slice(178, 183).map((row) => row.id)).toEqual(
    correction63ProofRowIds,
  );
  expect(rows.slice(178, 183).every((row) => row.status === "open")).toBe(
    true,
  );
});

test("Correction 63 ledger lock rejects order field semantics uniqueness and EOF mutations", async () => {
  const current = Buffer.from(
    await Bun.file(".orca/improvement-loop/issues.jsonl").arrayBuffer(),
  );
  let prefixEnd = -1;
  let lines = 0;
  for (let index = 0; index < current.byteLength; index += 1) {
    if (current[index] !== 0x0a) continue;
    lines += 1;
    if (lines === 178) {
      prefixEnd = index + 1;
      break;
    }
  }
  expect(prefixEnd).toBe(107_058);
  const prefix = current.subarray(0, prefixEnd);
  const valid = Buffer.concat([
    prefix,
    Buffer.from(`${correction63LedgerLines.join("\n")}\n`),
  ]);
  expect(correction63LedgerInspectionIssues(valid)).toEqual([]);

  const swapped = [...correction63LedgerLines];
  [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
  const mutations = [
    ["order", Buffer.concat([prefix, Buffer.from(`${swapped.join("\n")}\n`)])],
    [
      "field",
      Buffer.from(valid.toString("utf8").replace('"backend":"codex"', '"backend":"pi"')),
    ],
    [
      "semantics",
      Buffer.from(
        valid
          .toString("utf8")
          .replace(
            "allowing a precreated symlink to overwrite an external file",
            "repair preventing a precreated symlink from overwriting an external file",
          ),
      ),
    ],
    [
      "unique-count",
      Buffer.from(
        valid
          .toString("utf8")
          .replace(
            correction63ProofRowIds[1],
            correction63ProofRowIds[0],
          ),
      ),
    ],
    ["EOF", Buffer.concat([valid, Buffer.from("\n")])],
  ] as const;
  for (const [name, mutation] of mutations) {
    expect(correction63LedgerInspectionIssues(mutation).length, name).toBeGreaterThan(0);
  }
});

test("proof documents preserve exact Correction 57 before exact C60 boundary", async () => {
  expect(Buffer.byteLength(correction57ExpectedSection, "utf8")).toBe(2800);
  expect(
    createHash("sha256").update(correction57ExpectedSection).digest("hex"),
  ).toBe(correction57ExpectedSectionSha256);

  const sections: string[] = [];
  for (const proofPath of correction56ProofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(
      source,
      57,
      correction57ProofRowIds,
      60,
      { current: "exact", next: "exact" },
    );
    expect(inspection.issues, proofPath).toEqual([]);
    if (inspection.section === undefined) continue;
    expect(inspection.section, proofPath).toBe(correction57ExpectedSection);
    expect(Buffer.byteLength(inspection.section, "utf8"), proofPath).toBe(2800);
    expect(inspection.sha256, proofPath).toBe(correction57ExpectedSectionSha256);
    expect(
      source.includes(`${correction57ExpectedSection}## Correction 60\n`),
      proofPath,
    ).toBe(true);
    sections.push(inspection.section);
  }
  expect(sections).toHaveLength(correction56ProofPaths.length);
  expect(new Set(sections).size).toBe(1);
});

test("Correction 57 lock rejects exact C60 boundary and C57 body mutations", () => {
  const source =
    `historical proof\n${correction56ExpectedSection}${correction57ExpectedSection}${correction60ExpectedSection}`;
  const inspect = (candidate: string) =>
    inspectCorrectionProofSection(
      candidate,
      57,
      correction57ProofRowIds,
      60,
      { current: "exact", next: "exact" },
    );
  expect(
    correctionSectionLockIssues(
      inspect(source),
      57,
      correction57ExpectedSectionSha256,
    ),
  ).toEqual([]);

  const headingMutations = [
    ["missing", source.replace("## Correction 57", "## Correction 570"), 0],
    [
      "duplicate",
      source.replace("## Correction 57", "## Correction 57\n## Correction 57"),
      2,
    ],
    ["LF-forged", source.replace("## Correction 57", "##\nCorrection 57"), 0],
    ["CR-forged", source.replace("## Correction 57", "##\rCorrection 57"), 0],
    [
      "LINE-SEPARATOR-forged",
      source.replace("## Correction 57", "##\u2028Correction 57"),
      0,
    ],
    [
      "PARAGRAPH-SEPARATOR-forged",
      source.replace("## Correction 57", "##\u2029Correction 57"),
      0,
    ],
    [
      "semantic-negation",
      source.replace(
        "## Correction 57",
        "## Correction 57 does not record the repair",
      ),
      0,
    ],
  ] as const;
  for (const [name, mutation, count] of headingMutations) {
    expect(inspect(mutation).issues, name).toEqual([
      `Correction 57 heading count must be 1, received ${String(count)}`,
    ]);
  }

  const boundaryMutations = [
    ["missing", source.replace("## Correction 60", "## Correction 600"), 0],
    [
      "duplicate",
      source.replace("## Correction 60", "## Correction 60\n## Correction 60"),
      2,
    ],
    ["LF-forged", source.replace("## Correction 60", "##\nCorrection 60"), 0],
    ["CR-forged", source.replace("## Correction 60", "##\rCorrection 60"), 0],
    [
      "LINE-SEPARATOR-forged",
      source.replace("## Correction 60", "##\u2028Correction 60"),
      0,
    ],
    [
      "PARAGRAPH-SEPARATOR-forged",
      source.replace("## Correction 60", "##\u2029Correction 60"),
      0,
    ],
    [
      "semantic-negation",
      source.replace(
        "## Correction 60",
        "## Correction 60 does not record the repair",
      ),
      0,
    ],
  ] as const;
  for (const [name, mutation, count] of boundaryMutations) {
    expect(inspect(mutation).issues, name).toEqual([
      `Correction 60 boundary heading count must be 1, received ${String(count)}`,
    ]);
  }

  const reversedRows = source
    .replace(correction57ProofRowIds[0], "__C57_FIRST__")
    .replace(correction57ProofRowIds[2], correction57ProofRowIds[0])
    .replace("__C57_FIRST__", correction57ProofRowIds[2]);
  expect(inspect(reversedRows).issues).toEqual([
    "Correction 57 order must be heading < ordered row anchors < Correction 60",
  ]);

  const lockedMutations = [
    [
      "body-polarity",
      source.replace(
        "cannot authorize\npreflight or live execution",
        "can authorize\npreflight or live execution",
      ),
    ],
    [
      "body-polarity-manifest",
      source.replace(
        "No Correction 56 successor manifest or digest was created",
        "A Correction 56 successor manifest or digest was created",
      ),
    ],
    [
      "count",
      source.replace(
        "170 rows and 170 unique IDs",
        "169 rows and 169 unique IDs",
      ),
    ],
    [
      "verification-count",
      source.replace(
        "12/12 tests\nand 232 assertions total",
        "11/12 tests\nand 231 assertions total",
      ),
    ],
    [
      "hash",
      source.replace(
        "223969995ddcfdef812fe919e3f5a706e059278cfba592e3d8eec00286aae1de",
        "390a6523ffc73ddb04daba2820605115059a4032dd7c78ff32687008e91662ed",
      ),
    ],
    [
      "pending-work-polarity",
      source.replace(
        "unchanged-head proof, and SHA-locked squash merge remain pending",
        "unchanged-head proof, and SHA-locked squash merge are complete",
      ),
    ],
  ] as const;
  for (const [name, mutation] of lockedMutations) {
    expect(mutation, name).not.toBe(source);
    expect(
      correctionSectionLockIssues(
        inspect(mutation),
        57,
        correction57ExpectedSectionSha256,
      ),
      name,
    ).toEqual(["Correction 57 section SHA-256 mismatch"]);
  }
});

test("proof documents preserve exact Correction 60 before exact C61 boundary", async () => {
  expect(Buffer.byteLength(correction60ExpectedSection, "utf8")).toBe(3554);
  expect(
    createHash("sha256").update(correction60ExpectedSection).digest("hex"),
  ).toBe(correction60ExpectedSectionSha256);

  const sections: string[] = [];
  for (const proofPath of correction56ProofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(
      source,
      60,
      correction60ProofRowIds,
      61,
      { current: "exact", next: "exact" },
    );
    expect(inspection.issues, proofPath).toEqual([]);
    if (inspection.section === undefined) continue;
    expect(inspection.section, proofPath).toBe(correction60ExpectedSection);
    expect(Buffer.byteLength(inspection.section, "utf8"), proofPath).toBe(3554);
    expect(inspection.sha256, proofPath).toBe(correction60ExpectedSectionSha256);
    expect(
      source.includes(`${correction60ExpectedSection}## Correction 61\n`),
      proofPath,
    ).toBe(true);
    sections.push(inspection.section);
  }
  expect(sections).toHaveLength(correction56ProofPaths.length);
  expect(new Set(sections).size).toBe(1);
});

test("Correction 60 section lock rejects exact C61 boundary and C60 body mutations", () => {
  const source =
    `historical proof\n${correction57ExpectedSection}${correction60ExpectedSection}${correction61ExpectedSection}`;
  const inspect = (candidate: string) =>
    inspectCorrectionProofSection(
      candidate,
      60,
      correction60ProofRowIds,
      61,
      { current: "exact", next: "exact" },
    );
  expect(
    correctionSectionLockIssues(
      inspect(source),
      60,
      correction60ExpectedSectionSha256,
    ),
  ).toEqual([]);

  const headingMutations = [
    ["missing", source.replace("## Correction 60", "## Correction 600"), 0],
    [
      "duplicate",
      source.replace("## Correction 60", "## Correction 60\n## Correction 60"),
      2,
    ],
    ["LF-forged", source.replace("## Correction 60", "##\nCorrection 60"), 0],
    ["CR-forged", source.replace("## Correction 60", "##\rCorrection 60"), 0],
    [
      "LINE-SEPARATOR-forged",
      source.replace("## Correction 60", "##\u2028Correction 60"),
      0,
    ],
    [
      "PARAGRAPH-SEPARATOR-forged",
      source.replace("## Correction 60", "##\u2029Correction 60"),
      0,
    ],
    [
      "semantic-negation",
      source.replace(
        "## Correction 60",
        "## Correction 60 does not record the repair",
      ),
      0,
    ],
  ] as const;
  for (const [name, mutation, count] of headingMutations) {
    expect(inspect(mutation).issues, name).toEqual([
      `Correction 60 heading count must be 1, received ${String(count)}`,
    ]);
  }

  const boundaryMutations = [
    ["missing", source.replace("## Correction 61", "## Correction 610"), 0],
    [
      "duplicate",
      source.replace("## Correction 61", "## Correction 61\n## Correction 61"),
      2,
    ],
    ["LF-forged", source.replace("## Correction 61", "##\nCorrection 61"), 0],
    ["CR-forged", source.replace("## Correction 61", "##\rCorrection 61"), 0],
    [
      "LINE-SEPARATOR-forged",
      source.replace("## Correction 61", "##\u2028Correction 61"),
      0,
    ],
    [
      "PARAGRAPH-SEPARATOR-forged",
      source.replace("## Correction 61", "##\u2029Correction 61"),
      0,
    ],
    [
      "semantic-negation",
      source.replace(
        "## Correction 61",
        "## Correction 61 does not record the repair",
      ),
      0,
    ],
  ] as const;
  for (const [name, mutation, count] of boundaryMutations) {
    expect(inspect(mutation).issues, name).toEqual([
      `Correction 61 boundary heading count must be 1, received ${String(count)}`,
    ]);
  }

  const reversedRows = source
    .replace(correction60ProofRowIds[0], "__C60_FIRST__")
    .replace(correction60ProofRowIds[4], correction60ProofRowIds[0])
    .replace("__C60_FIRST__", correction60ProofRowIds[4]);
  expect(inspect(reversedRows).issues).toEqual([
    "Correction 60 order must be heading < ordered row anchors < Correction 61",
  ]);

  const lockedMutations = [
    [
      "trust-boundary-polarity",
      source.replace(
        "hostile processes remain outside the proof",
        "hostile processes remain inside the proof",
      ),
    ],
    [
      "controller-polarity",
      source.replace("TERM/KILL cutoffs, and fail-closed status", "TERM/KILL cutoffs, and success status"),
    ],
    [
      "count",
      source.replace(
        "175 rows and 175 unique IDs",
        "174 rows and 174 unique IDs",
      ),
    ],
    [
      "invalidated-digest-polarity",
      source.replace(
        "is invalidated historical evidence and cannot authorize preflight or live",
        "is valid historical evidence and can authorize preflight or live",
      ),
    ],
    [
      "execution-evidence-polarity",
      source.replace(
        "Static prose and hashes are not execution\nevidence",
        "Static prose and hashes are execution\nevidence",
      ),
    ],
    [
      "outside-scope-polarity",
      source.replace(
        "SHA-locked squash merge remain\noutside Task 5a",
        "SHA-locked squash merge are complete\ninside Task 5a",
      ),
    ],
  ] as const;
  for (const [name, mutation] of lockedMutations) {
    expect(mutation, name).not.toBe(source);
    expect(
      correctionSectionLockIssues(
        inspect(mutation),
        60,
        correction60ExpectedSectionSha256,
      ),
      name,
    ).toEqual(["Correction 60 section SHA-256 mismatch"]);
  }
});

test("proof documents preserve exact Correction 61 before the C62 boundary", async () => {
  expect(Buffer.byteLength(correction61ExpectedSection, "utf8")).toBe(2206);
  expect(
    createHash("sha256").update(correction61ExpectedSection).digest("hex"),
  ).toBe(correction61ExpectedSectionSha256);

  const sections: string[] = [];
  for (const proofPath of correction56ProofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(
      source,
      61,
      correction61ProofRowIds,
      62,
      { current: "exact" },
    );
    expect(inspection.issues, proofPath).toEqual([]);
    if (inspection.section === undefined) continue;
    expect(inspection.section, proofPath).toBe(correction61ExpectedSection);
    expect(Buffer.byteLength(inspection.section, "utf8"), proofPath).toBe(2206);
    expect(inspection.sha256, proofPath).toBe(correction61ExpectedSectionSha256);
    expect(
      source.includes(`${correction61ExpectedSection}${correction62Heading}\n`),
      proofPath,
    ).toBe(true);
    sections.push(inspection.section);
  }
  expect(sections).toHaveLength(correction56ProofPaths.length);
  expect(new Set(sections).size).toBe(1);
});

test("Correction 61 lock rejects the C62 boundary and C61 body mutations", () => {
  const source =
    `historical proof\n${correction60ExpectedSection}${correction61ExpectedSection}${correction62ExpectedSection}`;
  const inspect = (candidate: string) =>
    inspectCorrectionProofSection(
      candidate,
      61,
      correction61ProofRowIds,
      62,
      { current: "exact" },
    );
  expect(
    correctionSectionLockIssues(
      inspect(source),
      61,
      correction61ExpectedSectionSha256,
    ),
  ).toEqual([]);

  const headingMutations = [
    ["missing", source.replace("## Correction 61", "## Correction 610"), 0],
    [
      "duplicate",
      source.replace("## Correction 61", "## Correction 61\n## Correction 61"),
      2,
    ],
    ["LF-forged", source.replace("## Correction 61", "##\nCorrection 61"), 0],
    ["CR-forged", source.replace("## Correction 61", "##\rCorrection 61"), 0],
    [
      "LINE-SEPARATOR-forged",
      source.replace("## Correction 61", "##\u2028Correction 61"),
      0,
    ],
    [
      "PARAGRAPH-SEPARATOR-forged",
      source.replace("## Correction 61", "##\u2029Correction 61"),
      0,
    ],
    [
      "semantic-negation",
      source.replace(
        "## Correction 61",
        "## Correction 61 does not record the repair",
      ),
      0,
    ],
  ] as const;
  for (const [name, mutation, count] of headingMutations) {
    expect(inspect(mutation).issues, name).toEqual([
      `Correction 61 heading count must be 1, received ${String(count)}`,
    ]);
  }

  const boundaryMutations = [
    [
      "missing",
      source.replace(correction62Heading, correction62Heading.replace("62", "620")),
      0,
    ],
    [
      "duplicate",
      source.replace(correction62Heading, `${correction62Heading}\n${correction62Heading}`),
      2,
    ],
    [
      "LF-forged",
      source.replace(correction62Heading, correction62Heading.replace("## ", "##\n")),
      0,
    ],
    [
      "CR-forged",
      source.replace(correction62Heading, correction62Heading.replace("## ", "##\r")),
      0,
    ],
    [
      "LINE-SEPARATOR-forged",
      source.replace(correction62Heading, correction62Heading.replace("## ", "##\u2028")),
      0,
    ],
    [
      "PARAGRAPH-SEPARATOR-forged",
      source.replace(correction62Heading, correction62Heading.replace("## ", "##\u2029")),
      0,
    ],
  ] as const;
  for (const [name, mutation, count] of boundaryMutations) {
    expect(inspect(mutation).issues, name).toEqual([
      `Correction 62 boundary heading count must be 1, received ${String(count)}`,
    ]);
  }

  const rowAnchor = "- `audit-observed-once-residual-ownership`:";
  const missingRow = source.replace(
    rowAnchor,
    "- `audit-observed-once-residual-ownership-missing`:",
  );
  expect(inspect(missingRow).issues).toEqual([
    "Correction 61 row anchor audit-observed-once-residual-ownership count must be 1, received 0",
  ]);
  const duplicatedRow = source.replace(rowAnchor, `${rowAnchor}\n${rowAnchor}`);
  expect(inspect(duplicatedRow).issues).toEqual([
    "Correction 61 row anchor audit-observed-once-residual-ownership count must be 1, received 2",
  ]);

  const lockedMutations = [
    [
      "residual-ownership-polarity",
      source.replace(
        "a proven-empty cooperative owner set\n  preserves status `0`",
        "a proven-empty cooperative owner set\n  returns status `125`",
      ),
    ],
    [
      "count",
      source.replace(
        "176 rows and 176 unique IDs",
        "175 rows and 175 unique IDs",
      ),
    ],
    ["status", source.replace("One append-only open row", "One append-only closed row")],
    [
      "invalidated-digest-polarity",
      source.replace(
        "is invalidated historical evidence and cannot authorize successor audits,\npreflight",
        "is valid historical evidence and can authorize successor audits,\npreflight",
      ),
    ],
    [
      "execution-evidence-polarity",
      source.replace(
        "Static prose and hashes are not execution evidence",
        "Static prose and hashes are execution evidence",
      ),
    ],
    [
      "outside-scope-polarity",
      source.replace(
        "merge remain outside Correction 61 Task 1 and did not run",
        "merge are complete inside Correction 61 Task 1",
      ),
    ],
  ] as const;
  for (const [name, mutation] of lockedMutations) {
    expect(mutation, name).not.toBe(source);
    expect(
      correctionSectionLockIssues(
        inspect(mutation),
        61,
        correction61ExpectedSectionSha256,
      ),
      name,
    ).toEqual(["Correction 61 section SHA-256 mismatch"]);
  }
});

test("proof documents preserve one exact Correction 62 section before C63", async () => {
  expect(Buffer.byteLength(correction62ExpectedSection, "utf8")).toBe(4_272);
  expect(
    createHash("sha256").update(correction62ExpectedSection).digest("hex"),
  ).toBe(correction62ExpectedSectionSha256);

  const sections: string[] = [];
  for (const proofPath of correction56ProofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(
      source,
      62,
      correction62ProofRowIds,
      63,
      { next: "exact" },
    );
    expect(inspection.issues, proofPath).toEqual([]);
    if (inspection.section === undefined) continue;
    expect(inspection.section, proofPath).toBe(correction62ExpectedSection);
    expect(Buffer.byteLength(inspection.section, "utf8"), proofPath).toBe(4_272);
    expect(inspection.sha256, proofPath).toBe(correction62ExpectedSectionSha256);
    expect(
      source.includes(`${correction62ExpectedSection}${correction63Heading}\n`),
      proofPath,
    ).toBe(true);
    sections.push(inspection.section);
  }
  expect(sections).toHaveLength(correction56ProofPaths.length);
  expect(new Set(sections).size).toBe(1);
});

test("Correction 62 lock rejects heading rows semantics count status and EOF mutations", () => {
  const source =
    `historical proof\n${correction61ExpectedSection}${correction62ExpectedSection}`;
  const inspect = (candidate: string) =>
    inspectCorrectionProofSection(candidate, 62, correction62ProofRowIds);
  expect(
    correctionSectionLockIssues(
      inspect(source),
      62,
      correction62ExpectedSectionSha256,
    ),
  ).toEqual([]);

  const headingMutations = [
    [
      "missing",
      source.replace(correction62Heading, correction62Heading.replace("62", "620")),
      0,
    ],
    [
      "duplicate",
      source.replace(correction62Heading, `${correction62Heading}\n${correction62Heading}`),
      2,
    ],
    [
      "LF-forged",
      source.replace(correction62Heading, correction62Heading.replace("## ", "##\n")),
      0,
    ],
    [
      "CR-forged",
      source.replace(correction62Heading, correction62Heading.replace("## ", "##\r")),
      0,
    ],
    [
      "LINE-SEPARATOR-forged",
      source.replace(correction62Heading, correction62Heading.replace("## ", "##\u2028")),
      0,
    ],
    [
      "PARAGRAPH-SEPARATOR-forged",
      source.replace(correction62Heading, correction62Heading.replace("## ", "##\u2029")),
      0,
    ],
  ] as const;
  for (const [name, mutation, count] of headingMutations) {
    expect(inspect(mutation).issues, name).toEqual([
      `Correction 62 heading count must be 1, received ${String(count)}`,
    ]);
  }

  for (const rowId of correction62ProofRowIds) {
    const rowAnchor = `- \`${rowId}\`:`;
    const missingRow = source.replace(rowAnchor, `- \`${rowId}-missing\`:`);
    expect(inspect(missingRow).issues, rowId).toEqual([
      `Correction 62 row anchor ${rowId} count must be 1, received 0`,
    ]);
    const duplicatedRow = source.replace(rowAnchor, `${rowAnchor}\n${rowAnchor}`);
    expect(inspect(duplicatedRow).issues, rowId).toEqual([
      `Correction 62 row anchor ${rowId} count must be 1, received 2`,
    ]);
  }

  const reversedRows = source
    .replace(correction62ProofRowIds[0], "__C62_FIRST__")
    .replace(correction62ProofRowIds[1], correction62ProofRowIds[0])
    .replace("__C62_FIRST__", correction62ProofRowIds[1]);
  expect(inspect(reversedRows).issues).toEqual([
    "Correction 62 order must be heading < ordered row anchors < EOF",
  ]);

  const lockedMutations = [
    [
      "heading-title",
      source.replace("cleanup status precedence", "cleanup status priority"),
    ],
    [
      "capture-polarity",
      source.replace(
        "invoke `controller_run_until --capture` directly\n  in the current shell",
        "invoke `controller_run_until --capture` indirectly\n  in command substitution",
      ),
    ],
    [
      "cleanup-polarity",
      source.replace(
        "propagates timeout `124` and signals `143`, `130`, and `129`\n  unchanged",
        "flattens timeout `124` and signals `143`, `130`, and `129`\n  to status `125`",
      ),
    ],
    [
      "cleanup-partition-polarity",
      source.replace(
        "TERM `0` ends cleanup and `42` advances to KILL",
        "TERM `0` advances to KILL and `42` ends cleanup",
      ),
    ],
    [
      "successful-empty-frame-polarity",
      source.replace(
        "A successful empty record has\nread status `0` but is untyped and returns `125`.",
        "A successful empty record has\nread status `0` and may be ignored.",
      ),
    ],
    [
      "manifest-digest-binding-polarity",
      source.replace(
        "manifest digest is externalized in",
        "manifest digest is embedded in",
      ),
    ],
    [
      "count",
      source.replace(
        "178 rows and 178 unique IDs",
        "177 rows and 177 unique IDs",
      ),
    ],
    [
      "status",
      source.replace("Two append-only open rows", "Two append-only closed rows"),
    ],
    [
      "mutation-proof-polarity",
      source.replace(
        "mutations each failed their behavior proof",
        "mutations each passed their behavior proof",
      ),
    ],
    [
      "gate-polarity",
      source.replace(
        "Final ordered verification passed paired 14/14 manifest checks",
        "Final ordered verification skipped paired 14/14 manifest checks",
      ),
    ],
    [
      "trust-boundary-polarity",
      source.replace(
        "hostile processes remain\noutside the proof, and this is not kernel isolation",
        "hostile processes remain\ninside the proof, and this is kernel isolation",
      ),
    ],
    [
      "outside-scope-polarity",
      source.replace(
        "Correction 62 Task 1 and did not run",
        "Correction 62 Task 1 and all ran",
      ),
    ],
    ["post-EOF", `${source}post-EOF text\n`],
  ] as const;
  for (const [name, mutation] of lockedMutations) {
    expect(mutation, name).not.toBe(source);
    expect(
      correctionSectionLockIssues(
        inspect(mutation),
        62,
        correction62ExpectedSectionSha256,
      ),
      name,
    ).toEqual(["Correction 62 section SHA-256 mismatch"]);
  }
});

test("proof documents record one exact Correction 63 section at EOF", async () => {
  expect(Buffer.byteLength(correction63ExpectedSection, "utf8")).toBe(11_950);
  expect(
    createHash("sha256").update(correction63ExpectedSection).digest("hex"),
  ).toBe(correction63ExpectedSectionSha256);

  const sections: string[] = [];
  for (const proofPath of correction56ProofPaths) {
    const source = await Bun.file(proofPath).text();
    const inspection = inspectCorrectionProofSection(
      source,
      63,
      correction63ProofRowIds,
      undefined,
      { current: "exact" },
    );
    expect(inspection.issues, proofPath).toEqual([]);
    if (inspection.section === undefined) continue;
    expect(inspection.section, proofPath).toBe(correction63ExpectedSection);
    expect(inspection.sha256, proofPath).toBe(correction63ExpectedSectionSha256);
    expect(source.endsWith(correction63ExpectedSection), proofPath).toBe(true);
    expect(source.endsWith("\n"), proofPath).toBe(true);
    expect(source.endsWith("\n\n"), proofPath).toBe(false);
    sections.push(inspection.section);
  }
  expect(sections).toHaveLength(correction56ProofPaths.length);
  expect(new Set(sections).size).toBe(1);
});

test("Correction 63 lock rejects heading rows order semantics status hash and EOF mutations", () => {
  const source =
    `historical proof\n${correction62ExpectedSection}${correction63ExpectedSection}`;
  const inspect = (candidate: string) =>
    inspectCorrectionProofSection(
      candidate,
      63,
      correction63ProofRowIds,
      undefined,
      { current: "exact" },
    );
  expect(
    correctionSectionLockIssues(
      inspect(source),
      63,
      correction63ExpectedSectionSha256,
    ),
  ).toEqual([]);

  const headingMutations = [
    ["missing", source.replace(correction63Heading, `${correction63Heading}0`), 0],
    [
      "duplicate",
      source.replace(correction63Heading, `${correction63Heading}\n${correction63Heading}`),
      2,
    ],
    ["LF-forged", source.replace(correction63Heading, correction63Heading.replace("## ", "##\n")), 0],
    ["CR-forged", source.replace(correction63Heading, correction63Heading.replace("## ", "##\r")), 0],
  ] as const;
  for (const [name, mutation, count] of headingMutations) {
    expect(inspect(mutation).issues, name).toEqual([
      `Correction 63 heading count must be 1, received ${String(count)}`,
    ]);
  }

  for (const rowId of correction63ProofRowIds) {
    const rowAnchor = `- \`${rowId}\`:`;
    const missingRow = source.replace(rowAnchor, `- \`${rowId}-missing\`:`);
    expect(inspect(missingRow).issues, rowId).toEqual([
      `Correction 63 row anchor ${rowId} count must be 1, received 0`,
    ]);
    const duplicatedRow = source.replace(rowAnchor, `${rowAnchor}\n${rowAnchor}`);
    expect(inspect(duplicatedRow).issues, rowId).toEqual([
      `Correction 63 row anchor ${rowId} count must be 1, received 2`,
    ]);
  }

  const reversedRows = source
    .replace(correction63ProofRowIds[0], "__C63_FIRST__")
    .replace(correction63ProofRowIds[4], correction63ProofRowIds[0])
    .replace("__C63_FIRST__", correction63ProofRowIds[4]);
  expect(inspect(reversedRows).issues).toEqual([
    "Correction 63 order must be heading < ordered row anchors < EOF",
  ]);

  const lockedMutations = [
    [
      "publication-polarity",
      source.replace(
        "never follows the old predictable\n  symlink",
        "follows the old predictable\n  symlink",
      ),
    ],
    [
      "deadline-polarity",
      source.replace(
        "timeout `124`,\n  fetch/push identity checks",
        "timeout `143`,\n  fetch/push identity checks",
      ),
    ],
    [
      "settlement-polarity",
      source.replace(
        "stores one typed `BackendFailed` outcome plus the shared `cancel()` rejection",
        "publishes a typed outcome and shared rejection before outer release",
      ),
    ],
    [
      "quiescence-polarity",
      source.replace(
        "await leader\n  close plus group disappearance",
        "return before leader\n  close or group disappearance",
      ),
    ],
    [
      "reasoning-catalog-polarity",
      source.replace(
        "without a local model catalog",
        "through a local model catalog",
      ),
    ],
    [
      "count",
      source.replace("183 rows and 183 unique IDs", "182 rows and 182 unique IDs"),
    ],
    [
      "status",
      source.replace("Five append-only open rows", "Five append-only closed rows"),
    ],
    [
      "timing-concern-polarity",
      source.replace(
        "concern remains preserved rather than hidden",
        "concern was discarded and hidden",
      ),
    ],
    [
      "gate-polarity",
      source.replace(
        "Final ordered verification on frozen bytes passed",
        "Final ordered verification on frozen bytes skipped",
      ),
    ],
    [
      "timeout-signal-polarity",
      source.replace(
        "timeout documentation incorrectly said `Conversation.signal`\naborted",
        "timeout documentation correctly said `Conversation.signal`\naborted",
      ),
    ],
    [
      "cancellation-doc-failure-polarity",
      source.replace(
        "cleanup failure rejects the shared cancellation promise and publishes a\ntyped `BackendFailed` only after final cleanup and settlement release",
        "cleanup failure resolves the shared cancellation promise and publishes a\ncancelled outcome before final cleanup and settlement release",
      ),
    ],
    [
      "successful-cleanup-error-polarity",
      source.replace(
        "then typed failure publishes before the exact\ncleanup error rejects the shared promise",
        "then a cancelled outcome publishes before the exact\ncleanup error resolves the shared promise",
      ),
    ],
    [
      "active-cancellation-cleanup-polarity",
      source.replace(
        "routes consumer and timeout cleanup errors through the registered\ncancellation-failure handler only while cancellation owns settlement",
        "routes consumer and timeout cleanup errors through conversation.fail\neven while cancellation owns settlement",
      ),
    ],
    [
      "terminal-error-cleanup-polarity",
      source.replace(
        "while cancellation is active it reports the first through the\nregistered cancellation-failure handler",
        "while cancellation is active it discards the first instead of the\nregistered cancellation-failure handler",
      ),
    ],
    [
      "result-lifecycle-polarity",
      source.replace(
        "operations now represent expected failures as values, while asynchronous\nlifecycle methods retain promise semantics",
        "operations claim every fallible action returns a value, while asynchronous\nlifecycle methods cannot reject",
      ),
    ],
    [
      "teardown-deadline-polarity",
      source.replace(
        "Finalization starts one absolute\nstream-teardown deadline",
        "Finalization starts no bounded\nstream-teardown deadline",
      ),
    ],
    [
      "focused-count",
      source.replace(
        "focused GREEN passed 4/4 with 7 assertions",
        "focused GREEN passed 2/4 with 4 assertions",
      ),
    ],
    [
      "race-focused-count",
      source.replace(
        "focused race 1/1\nwith 4 assertions",
        "focused race 0/1\nwith 1 assertion",
      ),
    ],
    [
      "codex-count",
      source.replace(
        "full Codex file 45/45 with 135 assertions",
        "full Codex file 44/45 with 131 assertions",
      ),
    ],
    [
      "affected-count",
      source.replace(
        "suites passed 98/98 with 280 assertions",
        "suites passed 97/98 with 278 assertions",
      ),
    ],
    [
      "slice-count",
      source.replace(
        "coverage passed 106/106 with 301 assertions",
        "coverage passed 105/106 with 299 assertions",
      ),
    ],
    [
      "windows-claim",
      source.replace(
        "the gated Windows fallback was not runtime-tested",
        "the Windows process-group path was runtime-tested",
      ),
    ],
    [
      "outside-scope-polarity",
      source.replace(
        "GitHub mutation remain outside Correction 63 Task 1 and\ndid not run",
        "GitHub mutation are inside Correction 63 Task 1 and\nall ran",
      ),
    ],
    ["post-EOF", `${source}post-EOF text\n`],
  ] as const;
  for (const [name, mutation] of lockedMutations) {
    expect(mutation, name).not.toBe(source);
    expect(
      correctionSectionLockIssues(
        inspect(mutation),
        63,
        correction63ExpectedSectionSha256,
      ),
      name,
    ).toEqual(["Correction 63 section SHA-256 mismatch"]);
  }
});

test("runbook records rank-one control provenance and scout-only effort", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.run.md").text();
  for (const required of [
    "three candidate seeds",
    "selectedControl",
    "hydrated selected candidate",
    'reasoningEffort: "low"',
    "Codex scout only",
  ]) {
    expect(source).toContain(required);
  }
});

test("runbook requires isolated self-verified red proof", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.run.md").text();
  for (const required of [
    "reproduction agent runs both commands",
    "incidental runner, stack, or source text",
    "parent independently repeats both gates",
    "allowed repository paths",
    "stop immediately with no changes",
    "same exported production entrypoint",
    "different export from the same allowed production file",
  ]) {
    expect(source).toContain(required);
  }
});

test("runbook documents terminal ranked fallback and retained rejection proof", async () => {
  const runbook = await Bun.file(
    ".orca/workflows/codebase-improvement.run.md",
  ).text();
  const launcher = await Bun.file(
    ".orca/workflows/codebase-improvement.sh",
  ).text();
  for (const required of [
    "git show",
    "--first-parent",
    "terminal outcome",
    "usage",
    "shared 65-second reproduce budget",
    "invalid reproduction proof",
    "later-ranked control",
    "tool-free",
    "10 seconds",
    "byte-for-byte",
    "exact git status",
    "binary diff",
    "signal-killed",
    "Never rename, repurpose, delete, or weaken an existing test",
    ".orca/improvement-loop/runs/<run-id>/workflow/rejected/*.json",
  ]) {
    expect(runbook).toContain(required);
  }
  expect(launcher).toContain(
    'cp -R "$worktree/.orca/improvement-loop/runs/$run_id" "$run_dir/workflow"',
  );
});

test("scout timing reserves one exact active-ready allocation", async () => {
  const source = await Bun.file(".orca/workflows/codebase-improvement.ts").text();
  expect(source).toContain("const SCOUT_GATHER_LIMIT_MS = 15_000;");
  expect(source).toContain("const SCOUT_MODEL_LIMIT_MS = 120_000;");
  expect(source).toContain("const SCOUT_VALIDATION_LIMIT_MS = 20_000;");
  expect(source).not.toContain("SCOUT_ATTEMPT_LIMIT_MS");
  expect(source).toContain("runScopedScoutFanout");
});

async function runDeliveryContinuationLauncher(
  record: string | undefined,
  options: {
    readonly args?: readonly string[];
    readonly unreadable?: boolean;
    readonly backend?: string;
  } = {},
): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly spawnLog: string | undefined;
}> {
  const runId = `task5-continuation-${String(Date.now())}-${String(globalThis.process.pid)}`;
  const recordDirectory = join(".orca/improvement-loop/runs", runId);
  const recordPath = join(recordDirectory, "delivery.json");
  const root = await mkdtemp(join(tmpdir(), "orcats-continuation-launcher-"));
  const fakeBin = join(root, "bin");
  const fakeBash = join(fakeBin, "bash");
  const spawnLogPath = join(root, "flow-spawn.log");
  const launcher = resolve(".orca/workflows/codebase-improvement.sh");
  await mkdir(fakeBin, { recursive: true });
  await Bun.write(
    fakeBash,
    [
      "#!/bin/sh",
      `printf '%s\\n' \"$*\" >> ${JSON.stringify(spawnLogPath)}`,
      "exit 0",
    ].join("\n"),
  );
  await chmod(fakeBash, 0o755);
  if (record !== undefined) {
    await mkdir(recordDirectory, { recursive: true });
    await Bun.write(recordPath, record);
    if (options.unreadable === true) await chmod(recordPath, 0o000);
  }
  try {
    const process = Bun.spawn(
      ["/bin/bash", launcher, ...(options.args ?? [`--continue-delivery=${runId}`])],
      {
        cwd: resolve("."),
        env: {
          ...globalThis.process.env,
          ORCA_BACKEND: options.backend ?? "",
          PATH: `${fakeBin}:${globalThis.process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    return {
      exitCode,
      stderr,
      spawnLog: (await Bun.file(spawnLogPath).exists())
        ? await Bun.file(spawnLogPath).text()
        : undefined,
    };
  } finally {
    if (options.unreadable === true && (await Bun.file(recordPath).exists())) {
      await chmod(recordPath, 0o600);
    }
    await rm(recordDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

function continuationDeliveryRecord(runId: string): string {
  return JSON.stringify({
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
  });
}

test("continue-delivery rejects mixed arguments before a TypeScript flow spawn", async () => {
  const run = await runDeliveryContinuationLauncher(undefined, {
    args: ["--continue-delivery=task5-mixed", "--complexity=simple"],
  });
  expect(run.exitCode).toBe(64);
  expect(run.stderr).toContain("--continue-delivery must be used alone");
  expect(run.spawnLog).toBeUndefined();
});

test("missing delivery record blocks the continuation before a TypeScript flow spawn", async () => {
  const run = await runDeliveryContinuationLauncher(undefined);
  expect(run.exitCode).toBe(66);
  expect(run.stderr).toContain("delivery record is missing or unreadable");
  expect(run.spawnLog).toBeUndefined();
});

test("unreadable delivery record blocks the continuation before a TypeScript flow spawn", async () => {
  const run = await runDeliveryContinuationLauncher("{}", { unreadable: true });
  expect(run.exitCode).toBe(66);
  expect(run.stderr).toContain("delivery record is missing or unreadable");
  expect(run.spawnLog).toBeUndefined();
});

test("malformed delivery record blocks the continuation before a TypeScript flow spawn", async () => {
  const run = await runDeliveryContinuationLauncher("{not-json");
  expect(run.exitCode).toBe(66);
  expect(run.stderr).toContain("delivery record failed strict validation");
  expect(run.spawnLog).toBeUndefined();
});

test("schema-invalid delivery record blocks the continuation before a TypeScript flow spawn", async () => {
  const run = await runDeliveryContinuationLauncher('{"version":1}');
  expect(run.exitCode).toBe(66);
  expect(run.stderr).toContain("delivery record failed strict validation");
  expect(run.spawnLog).toBeUndefined();
});

test("continue-delivery executes the strict DeliveryRecordV1 validator before flow spawn", async () => {
  const runId = "task5-unknown-field";
  const record = JSON.parse(continuationDeliveryRecord(runId)) as Record<string, unknown>;
  record.unexpected = true;
  const root = await mkdtemp(join(tmpdir(), "orcats-continuation-schema-"));
  await rm(root, { recursive: true, force: true });
  const originalNow = Date.now;
  try {
    Date.now = () => Number(runId.replace(/\D/g, "").slice(-6)) || 1;
    const run = await runDeliveryContinuationLauncher(JSON.stringify(record));
    expect(run.exitCode).toBe(66);
    expect(run.stderr).toContain("delivery record failed strict validation");
    expect(run.spawnLog).toBeUndefined();
  } finally {
    Date.now = originalNow;
  }
});

test("active ready delivery reloads into its isolated continuation without backend selection", async () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1_234_567_890;
    const runId = `task5-continuation-${String(Date.now())}-${String(globalThis.process.pid)}`;
    const run = await runDeliveryContinuationLauncher(continuationDeliveryRecord(runId), {
      backend: "opencode",
    });
    expect(run.exitCode).toBe(0);
    expect(run.spawnLog).toContain(`--continue-delivery=${runId}`);
    expect(run.spawnLog).toContain("codebase-improvement.ts");
  } finally {
    Date.now = originalNow;
  }
});
