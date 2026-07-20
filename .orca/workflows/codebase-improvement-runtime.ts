import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import type {
  CommandLog,
  CommandTool,
  ConversationEvent,
  Usage,
} from "@twelvehart/orcats";
import {
  isGenericExpectedFailurePattern,
  normalizeFailure,
} from "./codebase-improvement-lib.ts";

interface ToolFreeConversation {
  events(): AsyncIterable<ConversationEvent>;
  cancel(reason?: string): Promise<void>;
}

export interface BoundedConversation<T> {
  awaitResult(): Promise<T>;
  cancel(reason?: string): Promise<void>;
}

export type TerminalSettlement<T> =
  | {
      readonly status: "fulfilled";
      readonly value: T;
      readonly completedAtMs: number;
    }
  | {
      readonly status: "rejected";
      readonly reason: unknown;
      readonly completedAtMs: number;
    };

export class ConversationTimeoutError extends Error {
  readonly stage: string;
  readonly timeoutMs: number;
  readonly terminal: TerminalSettlement<unknown> | undefined;

  constructor(
    stage: string,
    timeoutMs: number,
    terminal?: TerminalSettlement<unknown>,
  ) {
    super(`${stage} exceeded ${String(timeoutMs)}ms`);
    this.name = "ConversationTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
    this.terminal = terminal;
  }
}

export class ConversationSettlementTimeoutError extends Error {
  readonly stage: string;
  readonly settlementTimeoutMs: number;

  constructor(stage: string, settlementTimeoutMs: number) {
    super(
      `${stage} cancellation did not settle within ${String(settlementTimeoutMs)}ms`,
    );
    this.name = "ConversationSettlementTimeoutError";
    this.stage = stage;
    this.settlementTimeoutMs = settlementTimeoutMs;
  }
}

interface TimeoutRetryOutcome {
  readonly type: string;
  readonly reason?: string;
}

export interface TimeoutRetryAttempt {
  readonly attempt: 1 | 2;
  readonly timeoutMs: number;
  readonly settlementTimeoutMs: number;
  readonly label: string;
}

export interface TimeoutRetryRecord extends TimeoutRetryAttempt {
  readonly durationMs: number;
  readonly outcomeType: string;
  readonly timedOut: boolean;
  readonly terminal?: TimeoutRetryTerminalEvidence;
}

export type TimeoutRetryTerminalEvidence =
  | {
      readonly status: "fulfilled";
      readonly completedAtMs: number;
      readonly outcomeType: string;
      readonly usage?: Usage;
    }
  | {
      readonly status: "rejected";
      readonly completedAtMs: number;
      readonly reason: string;
    };

interface TimeoutRetryOptions {
  readonly stage: string;
  readonly totalTimeoutMs: number;
  readonly attemptTimeoutMs: number;
  readonly settlementTimeoutMs: number;
  readonly now?: () => number;
}

interface TimeoutRetryResult<T> {
  readonly outcome: T;
  readonly attempts: readonly TimeoutRetryRecord[];
}

export type ExpectedFileChangeState = "none" | "unconfirmed" | "applied";

type ExpectedFileChangeResult<T> = {
  readonly expectedFileChangeState: ExpectedFileChangeState;
  readonly outcome: T;
};

interface FailedCommandOutput {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
}

interface GateCommandOutput extends FailedCommandOutput {
  readonly status: "passed" | "failed";
  readonly exitCode?: number | null;
}

export interface GateIssue {
  readonly message: string;
  readonly fixable: true;
}

export type InvalidReproductionProofKind =
  | "control-failed"
  | "control-skipped"
  | "control-count"
  | "target-passed"
  | "target-wrong-pattern"
  | "no-change"
  | "empty-diff";

export class InvalidReproductionProofError extends Error {
  readonly kind: InvalidReproductionProofKind;

  constructor(kind: InvalidReproductionProofKind, message: string) {
    super(message);
    this.name = "InvalidReproductionProofError";
    this.kind = kind;
  }
}

export interface ExactSnapshotOperations {
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly readStatus: () => Promise<string>;
  readonly readDiff: () => Promise<string>;
}

export interface ExactFileSnapshot {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly baselineStatus: string;
  readonly baselineDiff: string;
}

export interface ExactRestorationEvidence {
  readonly snapshotSha256: string;
  readonly status: string;
  readonly diff: string;
}

export interface GitManifestEntry {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
}

export interface FileContentManifestOptions {
  readonly maxTotalBytes: number;
  readonly maxEntries: number;
  readonly maxTotalPathBytes: number;
  readonly remainingMs?: () => number;
  readonly now?: () => number;
  readonly operations?: FileContentManifestOperations;
}

export interface FileContentManifestOperations {
  readonly lstat: typeof lstat;
  readonly readlink: (path: string) => Promise<Uint8Array>;
  readonly readChunks: (path: string) => AsyncIterable<Uint8Array>;
}

export interface GitWorktreeManifestOptions {
  readonly root: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly hashFile: (path: string) => Promise<string>;
  readonly remainingMs?: () => number;
  readonly now?: () => number;
}

function observeTerminal<T>(
  operation: () => Promise<T>,
  now: () => number,
): Promise<TerminalSettlement<T>> {
  return Promise.resolve()
    .then(operation)
    .then(
      (value) => ({
        status: "fulfilled" as const,
        value,
        completedAtMs: now(),
      }),
      (reason: unknown) => ({
        status: "rejected" as const,
        reason,
        completedAtMs: now(),
      }),
    );
}

function compareManifestPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function positiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function manifestRemaining(
  remainingMs: (() => number) | undefined,
  deadlineAt: number | undefined,
  path: string,
  now: () => number,
): void {
  if (
    (remainingMs !== undefined && remainingMs() <= 0) ||
    (deadlineAt !== undefined && deadlineAt - now() <= 0)
  ) {
    throw new Error(`content manifest exceeded deadline at ${path}`);
  }
}

function manifestDeadlineError(
  path: string,
  label: string,
  cause?: unknown,
): Error {
  const message = `content manifest exceeded deadline during ${label} at ${path}`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

async function awaitManifestOperation<T>(
  remainingMs: (() => number) | undefined,
  deadlineAt: number | undefined,
  path: string,
  label: string,
  operation: () => Promise<T>,
  now: () => number,
): Promise<T> {
  manifestRemaining(remainingMs, deadlineAt, path, now);
  if (remainingMs === undefined || deadlineAt === undefined) {
    return await operation();
  }
  const available = Math.min(remainingMs(), deadlineAt - now());
  if (available <= 0) {
    throw new Error(`content manifest exceeded deadline at ${path}`);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const terminal = observeTerminal(operation, now);
  try {
    const first = await Promise.race([
      terminal,
      new Promise<{ readonly status: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), available);
      }),
    ]);
    if (first.status === "timeout") {
      throw manifestDeadlineError(path, label);
    }
    if (first.completedAtMs >= deadlineAt || remainingMs() <= 0) {
      throw manifestDeadlineError(
        path,
        label,
        first.status === "rejected" ? first.reason : undefined,
      );
    }
    if (first.status === "rejected") throw first.reason;
    return first.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const defaultFileContentManifestOperations: FileContentManifestOperations = {
  lstat,
  readlink: async (path) =>
    new Uint8Array(await readlink(path, { encoding: "buffer" })),
  readChunks: (path) => Bun.file(path).stream(),
};

export async function captureFileContentManifest(
  paths: readonly string[],
  options: FileContentManifestOptions,
): Promise<GitManifestEntry[]> {
  positiveSafeInteger(options.maxTotalBytes, "content manifest byte limit");
  positiveSafeInteger(options.maxEntries, "content manifest entry limit");
  positiveSafeInteger(
    options.maxTotalPathBytes,
    "content manifest path byte limit",
  );
  if (paths.length > options.maxEntries) {
    throw new Error(
      `content manifest exceeds entry limit: ${String(paths.length)} > ${String(options.maxEntries)}`,
    );
  }
  const sortedPaths = [...paths].sort(compareManifestPath);
  if (
    sortedPaths.some((path) => path === "" || path.includes("\0")) ||
    new Set(sortedPaths).size !== sortedPaths.length
  ) {
    throw new Error("content manifest paths must be unique");
  }
  const totalPathBytes = sortedPaths.reduce(
    (total, path) => total + Buffer.byteLength(path),
    0,
  );
  if (totalPathBytes > options.maxTotalPathBytes) {
    throw new Error(
      `content manifest exceeds path byte limit: ${String(totalPathBytes)} > ${String(options.maxTotalPathBytes)}`,
    );
  }
  const operations = options.operations ?? defaultFileContentManifestOperations;
  const now = options.now ?? Date.now;
  const initialRemaining = options.remainingMs?.();
  if (initialRemaining !== undefined && initialRemaining <= 0) {
    throw new Error("content manifest exceeded deadline before capture");
  }
  const deadlineAt =
    initialRemaining === undefined ? undefined : now() + initialRemaining;
  const manifest: GitManifestEntry[] = [];
  let totalBytes = 0;
  for (const path of sortedPaths) {
    manifestRemaining(options.remainingMs, deadlineAt, path, now);
    const metadata = await awaitManifestOperation(
      options.remainingMs,
      deadlineAt,
      path,
      "metadata read",
      async () => await operations.lstat(path),
      now,
    );
    const mode = metadata.isSymbolicLink()
      ? "120000"
      : metadata.isFile()
        ? (metadata.mode & 0o111) === 0
          ? "100644"
          : "100755"
        : undefined;
    if (mode === undefined) {
      throw new Error(`content manifest path is not a file or symlink: ${path}`);
    }
    const hash = createHash("sha256");
    let entryBytes = 0;
    if (metadata.isSymbolicLink()) {
      const target = await awaitManifestOperation(
        options.remainingMs,
        deadlineAt,
        path,
        "symbolic-link read",
        async () => await operations.readlink(path),
        now,
      );
      entryBytes = target.byteLength;
      totalBytes += entryBytes;
      if (totalBytes > options.maxTotalBytes) {
        throw new Error(`content manifest exceeds byte limit at ${path}`);
      }
      hash.update(target);
    } else {
      if (
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0 ||
        totalBytes + metadata.size > options.maxTotalBytes
      ) {
        throw new Error(`content manifest exceeds byte limit at ${path}`);
      }
      const iterator = operations.readChunks(path)[Symbol.asyncIterator]();
      while (true) {
        const next = await awaitManifestOperation(
          options.remainingMs,
          deadlineAt,
          path,
          "content read",
          async () => await iterator.next(),
          now,
        );
        if (next.done) break;
        const chunk = next.value;
        entryBytes += chunk.byteLength;
        totalBytes += chunk.byteLength;
        if (totalBytes > options.maxTotalBytes) {
          throw new Error(`content manifest exceeds byte limit at ${path}`);
        }
        hash.update(chunk);
      }
      if (entryBytes !== metadata.size) {
        throw new Error(`content manifest size changed while reading ${path}`);
      }
    }
    manifestRemaining(options.remainingMs, deadlineAt, path, now);
    manifest.push({ path, mode, oid: hash.digest("hex") });
  }
  return manifest;
}

function requireExactGitPaths(
  expectedPaths: readonly string[],
  actualPaths: readonly string[],
  label: string,
): string[] {
  const expected = [...expectedPaths].sort(compareManifestPath);
  const actual = [...actualPaths].sort(compareManifestPath);
  if (
    expected.length === 0 ||
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((path, index) => path !== actual[index])
  ) {
    throw new Error(
      `${label} manifest paths changed: expected ${expected.join(", ")}; received ${actual.join(", ")}`,
    );
  }
  return actual;
}

function requireExactGitManifestPaths(
  expectedPaths: readonly string[],
  manifest: readonly GitManifestEntry[],
  label: string,
): GitManifestEntry[] {
  const actual = [...manifest].sort((left, right) =>
    compareManifestPath(left.path, right.path),
  );
  requireExactGitPaths(
    expectedPaths,
    actual.map((entry) => entry.path),
    label,
  );
  return actual;
}

function strictNullRecords(value: string, label: string): string[] {
  if (value === "" || !value.endsWith("\0")) {
    throw new Error(`${label} returned invalid NUL framing`);
  }
  const records = value.slice(0, -1).split("\0");
  if (records.some((record) => record === "")) {
    throw new Error(`${label} returned invalid NUL framing`);
  }
  return records;
}

const GIT_BLOB_OID = "(?:[0-9a-f]{40}|[0-9a-f]{64})";
const GIT_BLOB_MODE = "(?:100644|100755|120000)";

export function parseExactGitPathList(
  value: string,
  expectedPaths: readonly string[],
  label: string,
): string[] {
  return requireExactGitPaths(
    expectedPaths,
    strictNullRecords(value, `${label} path list`),
    label,
  );
}

export function parseGitIndexManifest(
  value: string,
  expectedPaths: readonly string[],
): GitManifestEntry[] {
  const manifest = strictNullRecords(value, "staged candidate manifest")
    .map((record): GitManifestEntry => {
      const match = new RegExp(
        `^(${GIT_BLOB_MODE}) (${GIT_BLOB_OID}) ([0-3])\\t([\\s\\S]+)$`,
      ).exec(record);
      if (match === null || match[3] !== "0") {
        throw new Error(
          `staged candidate manifest returned invalid entry: ${JSON.stringify(record)}`,
        );
      }
      return { mode: match[1]!, oid: match[2]!, path: match[4]! };
    });
  return requireExactGitManifestPaths(expectedPaths, manifest, "staged candidate");
}

export function parseGitCommitManifest(
  value: string,
  expectedPaths: readonly string[],
): GitManifestEntry[] {
  const manifest = strictNullRecords(value, "committed candidate manifest")
    .map((record): GitManifestEntry => {
      const match = new RegExp(
        `^(${GIT_BLOB_MODE}) ([a-z]+) (${GIT_BLOB_OID})\\t([\\s\\S]+)$`,
      ).exec(record);
      if (match === null || match[2] !== "blob") {
        throw new Error(
          `committed candidate manifest returned invalid entry: ${JSON.stringify(record)}`,
        );
      }
      return { mode: match[1]!, oid: match[3]!, path: match[4]! };
    });
  return requireExactGitManifestPaths(
    expectedPaths,
    manifest,
    "committed candidate",
  );
}

function gitBlobOid(
  bytes: Uint8Array,
  objectFormat: "sha1" | "sha256",
): string {
  return createHash(objectFormat)
    .update(`blob ${String(bytes.byteLength)}\0`)
    .update(bytes)
    .digest("hex");
}

export async function captureGitWorktreeManifest(
  paths: readonly string[],
  options: GitWorktreeManifestOptions,
): Promise<GitManifestEntry[]> {
  const now = options.now ?? Date.now;
  const initialRemaining = options.remainingMs?.();
  if (initialRemaining !== undefined && initialRemaining <= 0) {
    throw new Error("candidate worktree manifest exceeded deadline before capture");
  }
  const deadlineAt =
    initialRemaining === undefined ? undefined : now() + initialRemaining;
  const manifest: GitManifestEntry[] = [];
  for (const path of [...paths].sort(compareManifestPath)) {
    const absolutePath = resolve(options.root, path);
    const metadata = await awaitManifestOperation(
      options.remainingMs,
      deadlineAt,
      path,
      "candidate metadata read",
      async () => await lstat(absolutePath),
      now,
    );
    const mode = metadata.isSymbolicLink()
      ? "120000"
      : metadata.isFile()
        ? (metadata.mode & 0o111) === 0
          ? "100644"
          : "100755"
        : undefined;
    if (mode === undefined) {
      throw new Error(
        `candidate worktree manifest path is not a file or symbolic link: ${path}`,
      );
    }
    const oid = metadata.isSymbolicLink()
      ? gitBlobOid(
          await awaitManifestOperation(
            options.remainingMs,
            deadlineAt,
            path,
            "candidate symbolic-link read",
            async () =>
              new Uint8Array(
                await readlink(absolutePath, { encoding: "buffer" }),
              ),
            now,
          ),
          options.objectFormat,
        )
      : await awaitManifestOperation(
          options.remainingMs,
          deadlineAt,
          path,
          "candidate file hash",
          async () => await options.hashFile(path),
          now,
        );
    const expectedOidLength = options.objectFormat === "sha1" ? 40 : 64;
    if (
      oid.length !== expectedOidLength ||
      !/^[0-9a-f]+$/.test(oid)
    ) {
      throw new Error(
        `candidate worktree manifest returned invalid object ID for ${path}: ${JSON.stringify(oid)}`,
      );
    }
    manifest.push({ path, mode, oid });
  }
  return requireExactGitManifestPaths(paths, manifest, "candidate worktree");
}

function canonicalGitManifest(
  manifest: readonly GitManifestEntry[],
): string {
  return JSON.stringify(
    [...manifest].sort(
      (left, right) =>
        compareManifestPath(left.path, right.path) ||
        compareManifestPath(left.mode, right.mode) ||
        compareManifestPath(left.oid, right.oid),
    ).map((entry) => [entry.path, entry.mode, entry.oid]),
  );
}

export function assertGitManifestUnchanged(
  expected: readonly GitManifestEntry[],
  actual: readonly GitManifestEntry[],
  label = "Git",
): void {
  if (canonicalGitManifest(expected) !== canonicalGitManifest(actual)) {
    throw new Error(
      `${label} manifest changed: expected ${String(expected.length)} entries, received ${String(actual.length)}`,
    );
  }
}

export async function withGitManifestGuard<T>(
  readManifest: () => Promise<readonly GitManifestEntry[]>,
  operation: () => Promise<T>,
): Promise<T> {
  const baseline = await readManifest();
  const operationResult = await Promise.resolve().then(operation).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
  assertGitManifestUnchanged(baseline, await readManifest());
  if (operationResult.status === "rejected") throw operationResult.reason;
  return operationResult.value;
}

export async function captureExactFileSnapshot(
  path: string,
  operations: ExactSnapshotOperations,
): Promise<ExactFileSnapshot> {
  const bytes = await operations.readBytes(path);
  const [baselineStatus, baselineDiff] = await Promise.all([
    operations.readStatus(),
    operations.readDiff(),
  ]);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    baselineStatus,
    baselineDiff,
  };
}

export async function restoreExactFileSnapshot(
  path: string,
  snapshot: ExactFileSnapshot,
  operations: ExactSnapshotOperations,
): Promise<ExactRestorationEvidence> {
  await operations.writeBytes(path, snapshot.bytes);
  const restoredBytes = await operations.readBytes(path);
  const snapshotSha256 = createHash("sha256")
    .update(restoredBytes)
    .digest("hex");
  if (snapshotSha256 !== snapshot.sha256) {
    throw new Error(
      `restored snapshot hash mismatch for ${path}: ${snapshotSha256} != ${snapshot.sha256}`,
    );
  }
  const [status, diff] = await Promise.all([
    operations.readStatus(),
    operations.readDiff(),
  ]);
  if (
    status !== snapshot.baselineStatus ||
    diff !== snapshot.baselineDiff
  ) {
    throw new Error(`exact restoration verification failed for ${path}`);
  }
  return { snapshotSha256, status, diff };
}

export interface FinalizationContext {
  readonly signal: AbortSignal;
  readonly attempt: 1 | 2;
  readonly remainingMs: () => number;
  readonly isCurrent: () => boolean;
  readonly commitPublication: () => FinalizationCommitDecision;
}

export interface FinalizationCommitDecision {
  readonly remainingMs: number;
}

export interface FinalizationAction {
  readonly label: string;
  readonly run: (
    context: FinalizationContext,
  ) => Promise<void | FinalizationCommitDecision>;
}

export function rethrowAfterFinalizationCleanup(
  primaryError: unknown,
  cleanup: () => void,
  label: string,
): never {
  try {
    cleanup();
  } catch (cleanupError) {
    const primaryMessage =
      primaryError instanceof Error ? primaryError.message : String(primaryError);
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new AggregateError(
      [primaryError, cleanupError],
      `${primaryMessage}; ${label} cleanup also failed: ${cleanupMessage}`,
      { cause: primaryError },
    );
  }
  throw primaryError;
}

interface FinalizationPublicationIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface FinalizationPublicationStatus {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function assertRealFinalizationDirectory(path: string): void {
  const status = lstatSync(path, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${path} is not a real owner-only directory`);
  }
}

function prepareFinalizationPublicationParent(destination: string): void {
  const root = resolve(process.cwd());
  const parent = resolve(dirname(destination));
  const suffix = relative(root, parent);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
    throw new Error(`${parent} is outside its publication root`);
  }
  assertRealFinalizationDirectory(root);
  let component = root;
  for (const segment of suffix.split(sep).filter(Boolean)) {
    component = join(component, segment);
    let created = false;
    try {
      lstatSync(component, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(component, { mode: 0o700 });
      created = true;
    }
    assertRealFinalizationDirectory(component);
    if (created && (lstatSync(component, { bigint: true }).mode & 0o777n) !== 0o700n) {
      throw new Error(`${component} is not a real owner-only directory`);
    }
  }
}

export async function publishFinalizationText(
  destination: string,
  value: string,
  context: FinalizationContext,
): Promise<FinalizationCommitDecision> {
  const temporaryPath = `${destination}.tmp-${randomBytes(24).toString("hex")}`;
  let descriptor: number | undefined;
  let identity: FinalizationPublicationIdentity | undefined;
  try {
    prepareFinalizationPublicationParent(destination);
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink()) {
      throw new Error(`${temporaryPath} is not a regular file`);
    }
    identity = { device: opened.dev, inode: opened.ino };
    fchmodSync(descriptor, 0o600);
    assertFinalizationPublicationStatus(
      lstatSync(temporaryPath, { bigint: true }),
      identity,
      temporaryPath,
    );
    writeFileSync(descriptor, value, { encoding: "utf8" });
    fsyncSync(descriptor);
    const written = fstatSync(descriptor, { bigint: true });
    assertFinalizationPublicationStatus(written, identity, temporaryPath);
    if (written.size !== BigInt(Buffer.byteLength(value))) {
      throw new Error(`${temporaryPath} byte-length validation failed`);
    }
    const closingDescriptor = descriptor;
    descriptor = undefined;
    closeSync(closingDescriptor);
    const closed = lstatSync(temporaryPath, { bigint: true });
    assertFinalizationPublicationStatus(closed, identity, temporaryPath);
    if (closed.size !== BigInt(Buffer.byteLength(value))) {
      throw new Error(`${temporaryPath} byte-length validation failed after close`);
    }
    const commit = context.commitPublication();
    renameSync(temporaryPath, destination);
    return commit;
  } catch (error) {
    rethrowAfterFinalizationCleanup(
      error,
      () => {
        const cleanupErrors: unknown[] = [];
        if (descriptor !== undefined) {
          const closingDescriptor = descriptor;
          descriptor = undefined;
          try {
            closeSync(closingDescriptor);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (identity !== undefined) {
          try {
            removeExactFinalizationTemporaryFile(temporaryPath, identity);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length === 1) throw cleanupErrors[0];
        if (cleanupErrors.length > 1) {
          throw new AggregateError(
            cleanupErrors,
            `${destination} temporary cleanup failed`,
          );
        }
      },
      destination,
    );
  }
}

function assertFinalizationPublicationStatus(
  status: FinalizationPublicationStatus,
  identity: FinalizationPublicationIdentity,
  path: string,
): void {
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.dev !== identity.device ||
    status.ino !== identity.inode
  ) {
    throw new Error(`${path} regular-file identity validation failed`);
  }
  if ((status.mode & 0o777n) !== 0o600n) {
    throw new Error(`${path} mode validation failed`);
  }
}

function removeExactFinalizationTemporaryFile(
  path: string,
  identity: FinalizationPublicationIdentity,
): void {
  let status: FinalizationPublicationStatus;
  try {
    status = lstatSync(path, { bigint: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  assertFinalizationPublicationStatus(status, identity, path);
  unlinkSync(path);
}

class FinalizationDeadlineError extends Error {
  readonly actionLabel: string;
  readonly timeoutMs: number;

  constructor(actionLabel: string, timeoutMs: number) {
    super(
      `${actionLabel} exceeded shared deadline after ${String(timeoutMs)}ms`,
    );
    this.name = "FinalizationDeadlineError";
    this.actionLabel = actionLabel;
    this.timeoutMs = timeoutMs;
  }
}

class FinalizationActionError extends Error {
  override readonly cause: unknown;

  constructor(label: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`${label} failed: ${message}`);
    this.name = "FinalizationActionError";
    this.cause = cause;
  }
}

interface FinalizeWorkflowEvidenceOptions {
  readonly bodyFailed: boolean;
  readonly remainingMs: () => number;
  readonly shutdown: FinalizationAction;
  readonly artifacts: readonly FinalizationAction[];
  readonly report: FinalizationAction;
  readonly failureArtifactReserveMs?: number;
  readonly enterFailureState: (errors: readonly Error[]) => void;
}

export interface SemanticPositiveControlOptions {
  readonly expectedTestName: string;
  readonly testPath: string;
  readonly allowedProductionPaths: readonly string[];
  readonly candidateRedMarker: string;
  readonly baselineSource?: string | undefined;
}

export interface SemanticPositiveControlEvidence {
  readonly sourceSha256: string;
  readonly productionPath: string;
  readonly candidateRedTestName?: string;
}

export function createWorkflowStatusWriter(
  write: (text: string) => unknown,
): (line: string) => void {
  return (line) => {
    write(`${line}\n`);
  };
}

export function commandFailureMessage(log: FailedCommandOutput): string {
  return [
    log.command,
    ...(log.stdout === "" ? [] : [`stdout:\n${log.stdout.trimEnd()}`]),
    ...(log.stderr === "" ? [] : [`stderr:\n${log.stderr.trimEnd()}`]),
  ].join("\n");
}

export function gateIssuesFromLogs(
  logs: readonly CommandLog[],
): GateIssue[] {
  return logs
    .filter((log) => log.status === "failed")
    .map((log) => ({
      message: commandFailureMessage(log),
      fixable: true as const,
    }));
}

export async function runRequiredCommand(
  commandTool: CommandTool,
  commandName: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandLog> {
  if (timeoutMs <= 0) {
    throw new Error(
      `sla-overrun before ${[commandName, ...args].join(" ")}`,
    );
  }
  const result = await commandTool.run({
    command: commandName,
    args,
    timeoutMs,
  });
  const log: CommandLog = {
    command: [commandName, ...args].join(" "),
    status: result.type === "success" ? "passed" : "failed",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
  if (result.type !== "success") {
    throw new Error(
      `${log.command} failed\n${result.stderr || result.stdout}`,
    );
  }
  return log;
}

export function remainingTimeout(
  requestedMs: number,
  remainingMs: number,
  operation: string,
): number {
  const bounded = Math.min(requestedMs, remainingMs);
  if (bounded <= 0) throw new Error(`sla-overrun before ${operation}`);
  return bounded;
}

export async function finalizeWorkflowEvidence(
  options: FinalizeWorkflowEvidenceOptions,
): Promise<readonly Error[]> {
  const failureArtifactReserveMs = options.failureArtifactReserveMs ?? 0;
  if (!Number.isFinite(failureArtifactReserveMs) || failureArtifactReserveMs < 0) {
    throw new Error("failure artifact reserve must be a non-negative finite number");
  }
  const generation = { current: 0 };
  const errors = await runFinalizationActions(
    [options.shutdown],
    options.remainingMs,
    1,
    generation,
  );
  let failureStateEntered = options.bodyFailed;

  const enterFailureState = (): void => {
    if (failureStateEntered) return;
    failureStateEntered = true;
    try {
      options.enterFailureState([...errors]);
    } catch (error) {
      errors.push(finalizationError("failure state", error));
    }
  };

  if (errors.length > 0) enterFailureState();
  if (errors.some(isFinalizationDeadlineFailure)) return errors;

  const firstArtifactErrors = await runFinalizationActions(
    options.artifacts,
    options.remainingMs,
    1,
    generation,
  );
  errors.push(...firstArtifactErrors);
  if (!options.bodyFailed && firstArtifactErrors.length > 0) {
    enterFailureState();
    errors.push(
      ...(await runFinalizationActions(
        options.artifacts,
        options.remainingMs,
        2,
        generation,
      )),
    );
  }

  const reportErrors = await runFinalizationActions(
    [options.report],
    options.remainingMs,
    1,
    generation,
    failureArtifactReserveMs,
  );
  errors.push(...reportErrors);
  if (!options.bodyFailed && reportErrors.length > 0) {
    enterFailureState();
    if (
      failureArtifactReserveMs > 0 ||
      !reportErrors.some(isFinalizationDeadlineFailure)
    ) {
      errors.push(
        ...(await runFinalizationActions(
          options.artifacts,
          options.remainingMs,
          2,
          generation,
        )),
      );
    }
  }

  return errors;
}

async function runFinalizationActions(
  actions: readonly FinalizationAction[],
  remainingMs: () => number,
  attempt: 1 | 2,
  generation: { current: number },
  reserveMs = 0,
): Promise<Error[]> {
  const errors: Error[] = [];
  for (const action of actions) {
    try {
      await runFinalizationAction(
        action,
        remainingMs,
        attempt,
        generation,
        reserveMs,
      );
    } catch (error) {
      errors.push(finalizationError(action.label, error));
    }
  }
  return errors;
}

async function runFinalizationAction(
  action: FinalizationAction,
  remainingMs: () => number,
  attempt: 1 | 2,
  generationState: { current: number },
  reserveMs = 0,
): Promise<void> {
  const timeoutMs = remainingMs() - reserveMs;
  if (timeoutMs <= 0) {
    throw new FinalizationDeadlineError(action.label, timeoutMs);
  }

  const controller = new AbortController();
  const generation = ++generationState.current;
  const invalidate = (): void => {
    if (generationState.current === generation) generationState.current += 1;
  };
  let commitAttempted = false;
  let committedDecision: FinalizationCommitDecision | undefined;
  const context: FinalizationContext = {
    signal: controller.signal,
    attempt,
    remainingMs,
    isCurrent: () =>
      generationState.current === generation && !controller.signal.aborted,
    commitPublication: () => {
      if (commitAttempted) {
        throw new Error(`${action.label} publication commit was already attempted`);
      }
      commitAttempted = true;
      const committedRemainingMs = remainingMs();
      if (
        controller.signal.aborted ||
        generationState.current !== generation ||
        committedRemainingMs <= reserveMs
      ) {
        throw new FinalizationDeadlineError(action.label, timeoutMs);
      }
      committedDecision = Object.freeze({ remainingMs: committedRemainingMs });
      return committedDecision;
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      invalidate();
      reject(new FinalizationDeadlineError(action.label, timeoutMs));
    }, timeoutMs);
  });

  try {
    let result: void | FinalizationCommitDecision;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => action.run(context)),
        deadline,
      ]);
    } catch (error) {
      if (
        error instanceof FinalizationDeadlineError ||
        remainingMs() > reserveMs
      ) {
        throw error;
      }
      throw new FinalizationDeadlineError(action.label, timeoutMs);
    }
    if (result !== undefined && result === committedDecision) return;
    if (remainingMs() <= 0) {
      throw new FinalizationDeadlineError(action.label, timeoutMs);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    invalidate();
  }
}

function finalizationError(label: string, error: unknown): Error {
  return new FinalizationActionError(label, error);
}

function isFinalizationDeadlineFailure(error: Error): boolean {
  return (
    error instanceof FinalizationActionError &&
    error.cause instanceof FinalizationDeadlineError
  );
}

export function assertPositiveControlEvidence(
  control: GateCommandOutput,
  expectedControlName: string,
): void {
  assertCommandDidNotTimeOut(control);
  if (control.status !== "passed") {
    throw new InvalidReproductionProofError(
      "control-failed",
      `positive control failed before implementation:\n${commandFailureMessage(control)}`,
    );
  }
  const escapedControlName = expectedControlName.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const controlOutput = `${control.stdout}\n${control.stderr}`;
  if (
    new RegExp(
      `^\\((?:skip|todo)\\) ${escapedControlName}(?: \\[.*\\])?$`,
      "m",
    ).test(controlOutput)
  ) {
    throw new InvalidReproductionProofError(
      "control-skipped",
      `positive control ${expectedControlName} may not skip or todo`,
    );
  }
  const passingControls = controlOutput
    .split("\n")
    .filter((line) =>
      new RegExp(`^\\(pass\\) ${escapedControlName}(?: \\[.*\\])?$`).test(line),
    );
  if (passingControls.length !== 1) {
    throw new InvalidReproductionProofError(
      "control-count",
      `expected exactly one passing positive control ${expectedControlName}`,
    );
  }
  const summaryPatterns = [
    /^bun test v\d+\.\d+\.\d+ \([0-9a-f]+\)$/m,
    /^\s*1 pass\s*$/m,
    /^\s*0 fail\s*$/m,
    /^\s*[1-9]\d* expect\(\) calls\s*$/m,
    /^Ran 1 test across 1 file\. \[[^\]\r\n]+\]$/m,
  ];
  if (
    !/^bun test(?:\s|$)/.test(control.command) ||
    summaryPatterns.some((pattern) => !pattern.test(controlOutput))
  ) {
    throw new InvalidReproductionProofError(
      "control-count",
      `positive control ${expectedControlName} lacks a Bun one-test summary`,
    );
  }
}

interface SemanticProductionBinding {
  readonly symbol: ts.Symbol;
  readonly namespace: boolean;
  readonly productionPath: string;
  readonly entrypoint: string | undefined;
}

interface SemanticProductionOrigin {
  readonly productionPath: string;
  readonly entrypoint: string;
}

type SemanticProductionState =
  | { readonly kind: "untainted" }
  | { readonly kind: "exact"; readonly origin: SemanticProductionOrigin }
  | { readonly kind: "ambiguous" };

interface SemanticSourceAnalysis {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
}

const UNTAINTED_PRODUCTION_STATE: SemanticProductionState = Object.freeze({
  kind: "untainted",
});
const AMBIGUOUS_PRODUCTION_STATE: SemanticProductionState = Object.freeze({
  kind: "ambiguous",
});

export function decodeUtf8Source(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${normalizeFailure(error)}`);
  }
}

function createSemanticSourceAnalysis(
  source: string,
  testPath: string,
): SemanticSourceAnalysis {
  const fileName = resolve(testPath);
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  host.fileExists = (candidate) => resolve(candidate) === fileName;
  host.readFile = (candidate) =>
    resolve(candidate) === fileName ? source : undefined;
  host.getSourceFile = (candidate) =>
    resolve(candidate) === fileName ? sourceFile : undefined;
  host.getCurrentDirectory = () => dirname(fileName);
  const program = ts.createProgram({
    rootNames: [fileName],
    options: compilerOptions,
    host,
  });
  if (program.getSourceFile(fileName) !== sourceFile) {
    throw new Error("semantic positive control binder source mismatch");
  }
  return { sourceFile, checker: program.getTypeChecker() };
}

export function assertSemanticPositiveControl(
  source: string,
  options: SemanticPositiveControlOptions,
): SemanticPositiveControlEvidence {
  const { sourceFile, checker } = createSemanticSourceAnalysis(
    source,
    options.testPath,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {
      readonly parseDiagnostics: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    throw new Error(
      `positive control source is not valid TypeScript: ${ts.flattenDiagnosticMessageText(
        parseDiagnostics[0]!.messageText,
        "\n",
      )}`,
    );
  }

  const bunTestImports = importedNamedBindings(sourceFile, "bun:test");
  if (!bunTestImports.has("test") || !bunTestImports.has("expect")) {
    throw new Error(
      "semantic positive control must directly import test and expect from bun:test",
    );
  }
  const allNamedTests: ts.CallExpression[] = [];
  const collectNamedTests = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "test" &&
      staticString(node.arguments[0]) === options.expectedTestName
    ) {
      allNamedTests.push(node);
    }
    ts.forEachChild(node, collectNamedTests);
  };
  collectNamedTests(sourceFile);
  const topLevelNamedTests = sourceFile.statements.flatMap((statement) => {
    if (!ts.isExpressionStatement(statement)) return [];
    const expression = statement.expression;
    if (
      !ts.isCallExpression(expression) ||
      !ts.isIdentifier(expression.expression) ||
      expression.expression.text !== "test" ||
      staticString(expression.arguments[0]) !== options.expectedTestName
    ) {
      return [];
    }
    return [expression];
  });
  if (
    allNamedTests.length !== 1 ||
    topLevelNamedTests.length !== 1 ||
    allNamedTests[0] !== topLevelNamedTests[0]
  ) {
    throw new Error(
      `semantic positive control requires one exact top-level test ${options.expectedTestName}`,
    );
  }
  if (
    options.baselineSource !== undefined &&
    containsExactMarker(
      options.baselineSource,
      options.candidateRedMarker,
    )
  ) {
    throw new Error(
      "candidate RED marker must be absent from baseline source",
    );
  }
  const candidateRedTest =
    options.baselineSource === undefined
      ? undefined
      : assertOneAdditiveTopLevelTest(
          sourceFile,
          options.baselineSource,
          options,
        );
  const testCall = topLevelNamedTests[0]!;
  const callback = testCall.arguments[1];
  if (
    callback === undefined ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))
  ) {
    throw new Error("semantic positive control test requires a function body");
  }

  const productionBindings = directProductionBindings(
    sourceFile,
    options,
    checker,
  );
  if (productionBindings.length === 0) {
    throw new Error(
      "semantic positive control must directly import an allowed production path",
    );
  }
  const callbackDeclarations = declaredNames(callback);
  if (
    callbackDeclarations.has("test") ||
    callbackDeclarations.has("expect")
  ) {
    throw new Error("semantic positive control may not shadow test or expect");
  }
  const observedProductionOrigin = observeProductionOrigin(
    callback.body,
    productionBindings,
    checker,
  );
  if (observedProductionOrigin === undefined) {
    throw new Error(
      "semantic positive control requires a production call result to flow through expect into one reachable genuine Bun matcher",
    );
  }
  const candidateRedTestName =
    candidateRedTest === undefined
      ? undefined
      : assertCandidateRedTest(
          candidateRedTest,
          options,
          productionBindings,
          observedProductionOrigin,
          checker,
        );
  assertBunTestExpectIsUnmodified(sourceFile, checker);

  return {
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    productionPath: observedProductionOrigin.productionPath,
    ...(candidateRedTestName === undefined ? {} : { candidateRedTestName }),
  };
}

function assertOneAdditiveTopLevelTest(
  candidate: ts.SourceFile,
  baselineSource: string,
  options: SemanticPositiveControlOptions,
): ts.CallExpression {
  const baseline = ts.createSourceFile(
    options.testPath,
    baselineSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const baselineDiagnostics = (
    baseline as ts.SourceFile & {
      readonly parseDiagnostics: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics;
  if (baselineDiagnostics.length > 0) {
    throw new Error(
      "semantic positive control baseline is not valid TypeScript",
    );
  }

  const baselineTestNames = new Set(
    baseline.statements.flatMap((statement) => {
      const call = topLevelTestCall(statement);
      const name =
        call === undefined ? undefined : staticString(call.arguments[0]);
      return name === undefined ? [] : [name];
    }),
  );
  const addedStatements: Array<{
    readonly call: ts.CallExpression;
    readonly statement: ts.ExpressionStatement;
  }> = [];
  for (const statement of candidate.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const call = topLevelTestCall(statement);
    const name = call === undefined ? undefined : staticString(call.arguments[0]);
    if (
      call !== undefined &&
      name !== undefined &&
      name !== options.expectedTestName &&
      !baselineTestNames.has(name)
    ) {
      addedStatements.push({ call, statement });
    }
  }
  if (addedStatements.length !== 1) {
    throw new Error(
      "semantic positive control requires exactly one additive top-level test",
    );
  }
  const { call: addedTest, statement: addedStatement } = addedStatements[0]!;
  assertContiguousStatementInsertion(
    candidate.text,
    baselineSource,
    addedStatement,
  );
  assertNoDisablingDirective(
    candidate.text.slice(
      addedStatement.getStart(candidate),
      addedStatement.getEnd(),
    ),
  );
  return addedTest;
}

function assertContiguousStatementInsertion(
  candidate: string,
  baseline: string,
  statement: ts.ExpressionStatement,
): void {
  const insertionLength = candidate.length - baseline.length;
  if (insertionLength <= 0) {
    throw new Error(
      "semantic positive control requires exactly one additive top-level test",
    );
  }
  let commonPrefix = 0;
  while (
    commonPrefix < baseline.length &&
    candidate[commonPrefix] === baseline[commonPrefix]
  ) {
    commonPrefix += 1;
  }
  let commonSuffix = 0;
  while (
    commonSuffix < baseline.length &&
    candidate[candidate.length - commonSuffix - 1] ===
      baseline[baseline.length - commonSuffix - 1]
  ) {
    commonSuffix += 1;
  }
  const statementStart = statement.getStart();
  const statementEnd = statement.getEnd();
  const earliestStart = Math.max(
    0,
    baseline.length - commonSuffix,
    statementEnd - insertionLength,
  );
  const latestStart = Math.min(
    baseline.length,
    commonPrefix,
    statementStart,
  );
  for (
    let insertionStart = earliestStart;
    insertionStart <= latestStart;
    insertionStart += 1
  ) {
    const insertionEnd = insertionStart + insertionLength;
    if (
      insertionEnd < statementEnd ||
      !/^\s*$/u.test(candidate.slice(insertionStart, statementStart)) ||
      !/^\s*$/u.test(candidate.slice(statementEnd, insertionEnd))
    ) {
      continue;
    }
    return;
  }
  throw new Error(
    "semantic positive control requires exactly one additive top-level test",
  );
}

function assertNoDisablingDirective(statementSource: string): void {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    statementSource,
  );
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    if (
      /\beslint-disable\b|@ts-(?:nocheck|ignore|expect-error)\b/iu.test(
        scanner.getTokenText(),
      )
    ) {
      throw new Error(
        "candidate RED test may not contain a disabling directive",
      );
    }
  }
}

function assertCandidateRedTest(
  testCall: ts.CallExpression,
  options: SemanticPositiveControlOptions,
  productionBindings: readonly SemanticProductionBinding[],
  controlOrigin: SemanticProductionOrigin,
  checker: ts.TypeChecker,
): string {
  const testName = staticString(testCall.arguments[0]);
  if (
    testName === undefined ||
    !containsExactMarker(testName, options.candidateRedMarker)
  ) {
    throw new Error(
      `candidate RED test name must contain exact marker ${options.candidateRedMarker}`,
    );
  }
  assertSingleLineValue(testName, "candidate RED test name");
  const callback = testCall.arguments[1];
  if (
    callback === undefined ||
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    !ts.isBlock(callback.body)
  ) {
    throw new Error("candidate RED test requires a function block");
  }
  const callbackDeclarations = declaredNames(callback);
  if (
    callbackDeclarations.has("test") ||
    callbackDeclarations.has("expect")
  ) {
    throw new Error("candidate RED test may not shadow test or expect");
  }
  const bindings = productionBindings;

  const assertionStatements: ts.ExpressionStatement[] = [];
  for (const statement of callback.body.statements) {
    if (ts.isVariableStatement(statement)) {
      continue;
    }
    if (ts.isExpressionStatement(statement)) {
      assertionStatements.push(statement);
      continue;
    }
    throw new Error(
      "candidate RED test may contain only variable setup and one causal expect",
    );
  }
  if (assertionStatements.length !== 1) {
    throw new Error(
      "candidate RED test may contain only variable setup and one causal expect",
    );
  }

  const expectCalls: ts.CallExpression[] = [];
  const collectExpectCalls = (node: ts.Node): void => {
    if (node !== callback.body && isFunctionBoundary(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "expect"
    ) {
      expectCalls.push(node);
    }
    ts.forEachChild(node, collectExpectCalls);
  };
  collectExpectCalls(callback.body);
  const assertionExpect = assertionExpectCall(
    assertionStatements[0]!.expression,
  );
  if (
    expectCalls.length !== 1 ||
    assertionExpect === undefined ||
    assertionExpect !== expectCalls[0]
  ) {
    throw new Error(
      "candidate RED test requires exactly one genuine Bun matcher assertion",
    );
  }
  const receivedOrigin = observeProductionOrigin(
    callback.body,
    bindings,
    checker,
  );
  if (receivedOrigin === undefined) {
    throw new Error(
      "candidate RED test expect value must be causally production-bound",
    );
  }
  if (
    receivedOrigin.productionPath !== controlOrigin.productionPath ||
    receivedOrigin.entrypoint !== controlOrigin.entrypoint
  ) {
    throw new Error(
      "candidate RED test must use the same production entrypoint as the positive control",
    );
  }
  const assertionCalls = assertionCallChain(
    assertionStatements[0]!.expression,
  );
  let unrelatedFailure = false;
  const inspectFailurePaths = (node: ts.Node): void => {
    if (ts.isThrowStatement(node)) {
      unrelatedFailure = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      !assertionCalls.has(node) &&
      directProductionCallOrigin(node, bindings, checker) === undefined
    ) {
      unrelatedFailure = true;
      return;
    }
    ts.forEachChild(node, inspectFailurePaths);
  };
  inspectFailurePaths(callback.body);
  if (unrelatedFailure) {
    throw new Error(
      "candidate RED test may not throw or call unrelated failure paths",
    );
  }
  return testName;
}

const unsafeSingleLineValue =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function assertSingleLineValue(value: string, label: string): void {
  if (value === "" || unsafeSingleLineValue.test(value)) {
    throw new Error(
      `${label} must be a non-empty single-line value without control characters`,
    );
  }
}

function containsExactMarker(value: string, marker: string): boolean {
  let offset = value.indexOf(marker);
  while (offset >= 0) {
    const before = value[offset - 1];
    const after = value[offset + marker.length];
    if (
      (before === undefined || !/[A-Za-z0-9_-]/.test(before)) &&
      (after === undefined || !/[A-Za-z0-9_-]/.test(after))
    ) {
      return true;
    }
    offset = value.indexOf(marker, offset + 1);
  }
  return false;
}

export const MATCHER_PROOF_PRELOAD_SOURCE = [
  'import { expect } from "bun:test";',
  "Object.defineProperty(expect, \"extend\", {",
  "  value: () => {",
  '    throw new Error("expect.extend disabled during causal proof");',
  "  },",
  "  writable: false,",
  "  configurable: false,",
  "});",
  "Object.freeze(expect.prototype);",
  "Object.freeze(expect);",
  "",
].join("\n");

export function matcherProofArgs(
  args: readonly string[],
  preloadPath: string,
): string[] {
  return ["--preload", preloadPath, ...args];
}

const BUN_CAUSAL_MATCHERS = new Set([
  "lastCalledWith",
  "nthCalledWith",
  "toBe",
  "toBeArray",
  "toBeArrayOfSize",
  "toBeBoolean",
  "toBeCalled",
  "toBeCalledTimes",
  "toBeCalledWith",
  "toBeCloseTo",
  "toBeDate",
  "toBeDefined",
  "toBeEmpty",
  "toBeEmptyObject",
  "toBeEven",
  "toBeFalse",
  "toBeFalsy",
  "toBeFinite",
  "toBeFunction",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeInstanceOf",
  "toBeInteger",
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeNaN",
  "toBeNegative",
  "toBeNil",
  "toBeNull",
  "toBeNumber",
  "toBeObject",
  "toBeOdd",
  "toBePositive",
  "toBeString",
  "toBeSymbol",
  "toBeTrue",
  "toBeTruthy",
  "toBeTypeOf",
  "toBeUndefined",
  "toBeValidDate",
  "toBeWithin",
  "toContain",
  "toContainAllKeys",
  "toContainAllValues",
  "toContainAnyKeys",
  "toContainAnyValues",
  "toContainEqual",
  "toContainKey",
  "toContainKeys",
  "toContainValue",
  "toContainValues",
  "toEndWith",
  "toEqual",
  "toEqualIgnoringWhitespace",
  "toHaveBeenCalled",
  "toHaveBeenCalledTimes",
  "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toHaveLastReturnedWith",
  "toHaveLength",
  "toHaveNthReturnedWith",
  "toHaveProperty",
  "toHaveReturned",
  "toHaveReturnedTimes",
  "toHaveReturnedWith",
  "toInclude",
  "toIncludeRepeated",
  "toMatch",
  "toMatchInlineSnapshot",
  "toMatchObject",
  "toMatchSnapshot",
  "toStartWith",
  "toStrictEqual",
  "toThrow",
  "toThrowError",
  "toThrowErrorMatchingInlineSnapshot",
  "toThrowErrorMatchingSnapshot",
]);

const BUN_EXPECT_MODIFIERS = new Set(["not", "rejects", "resolves"]);

function assertionExpectCall(
  expression: ts.Expression,
): ts.CallExpression | undefined {
  const current = unwrapExpression(expression);
  if (ts.isAwaitExpression(current)) {
    return assertionExpectCall(current.expression);
  }
  if (!ts.isCallExpression(current)) return undefined;
  const callee = unwrapExpression(current.expression);
  if (
    !ts.isPropertyAccessExpression(callee) &&
    !ts.isElementAccessExpression(callee)
  ) {
    return undefined;
  }
  const matcherName = accessName(callee);
  if (matcherName === undefined || !BUN_CAUSAL_MATCHERS.has(matcherName)) {
    return undefined;
  }
  return matcherReceiverExpectCall(callee.expression);
}

function matcherReceiverExpectCall(
  expression: ts.Expression,
): ts.CallExpression | undefined {
  const current = unwrapExpression(expression);
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    const modifier = accessName(current);
    return modifier !== undefined && BUN_EXPECT_MODIFIERS.has(modifier)
      ? matcherReceiverExpectCall(current.expression)
      : undefined;
  }
  if (!ts.isCallExpression(current)) return undefined;
  const callee = unwrapExpression(current.expression);
  return ts.isIdentifier(callee) && callee.text === "expect"
    ? current
    : undefined;
}

function accessName(
  expression: ts.Expression,
): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return ts.isElementAccessExpression(expression)
    ? staticString(expression.argumentExpression)
    : undefined;
}

function assertionCallChain(expression: ts.Expression): Set<ts.CallExpression> {
  const calls = new Set<ts.CallExpression>();
  const visit = (node: ts.Expression): void => {
    const current = unwrapExpression(node);
    if (ts.isAwaitExpression(current)) {
      visit(current.expression);
      return;
    }
    if (ts.isPropertyAccessExpression(current)) {
      visit(current.expression);
      return;
    }
    if (ts.isElementAccessExpression(current)) {
      visit(current.expression);
      return;
    }
    if (!ts.isCallExpression(current)) return;
    calls.add(current);
    const callee = unwrapExpression(current.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      visit(callee.expression);
    } else if (ts.isElementAccessExpression(callee)) {
      visit(callee.expression);
    }
  };
  visit(expression);
  return calls;
}

function topLevelTestCall(
  statement: ts.Statement,
): ts.CallExpression | undefined {
  if (!ts.isExpressionStatement(statement)) return undefined;
  const expression = statement.expression;
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== "test"
  ) {
    return undefined;
  }
  const callback = expression.arguments[1];
  return callback !== undefined &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ? expression
    : undefined;
}

function importedNamedBindings(
  sourceFile: ts.SourceFile,
  moduleName: string,
): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    const importClause = ts.isImportDeclaration(statement)
      ? statement.importClause
      : undefined;
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName ||
      importClause === undefined ||
      importClause.isTypeOnly ||
      importClause.namedBindings === undefined ||
      !ts.isNamedImports(importClause.namedBindings)
    ) {
      continue;
    }
    for (const specifier of importClause.namedBindings.elements) {
      if (specifier.isTypeOnly) continue;
      names.add(specifier.name.text);
    }
  }
  return names;
}

function assertBunTestExpectIsUnmodified(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): void {
  let expectSymbol: ts.Symbol | undefined;
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "bun:test"
    ) {
      continue;
    }
    const importClause = statement.importClause;
    if (
      importClause === undefined ||
      importClause.name !== undefined ||
      importClause.namedBindings === undefined ||
      ts.isNamespaceImport(importClause.namedBindings)
    ) {
      throw new Error(
        "semantic positive control may not mutate or alias bun:test expect",
      );
    }
    for (const specifier of importClause.namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      if (importedName === "expect" && specifier.name.text !== "expect") {
        throw new Error(
          "semantic positive control may not mutate or alias bun:test expect",
        );
      }
      if (
        !specifier.isTypeOnly &&
        specifier.name.text === "expect" &&
        importedName === "expect"
      ) {
        expectSymbol = checker.getSymbolAtLocation(specifier.name);
      }
    }
  }
  if (expectSymbol === undefined) {
    throw new Error(
      "semantic positive control must directly import expect from bun:test",
    );
  }

  const allowedExpectCalls = new Set<ts.CallExpression>();
  const collectAssertions = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expectCall = assertionExpectCall(node);
      if (expectCall !== undefined) allowedExpectCalls.add(expectCall);
    }
    ts.forEachChild(node, collectAssertions);
  };
  collectAssertions(sourceFile);

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) &&
      node.text === "bun:test" &&
      (!ts.isImportDeclaration(node.parent) ||
        node.parent.moduleSpecifier !== node)
    ) {
      throw new Error(
        "semantic positive control may not mutate or alias bun:test expect",
      );
    }
    if (
      ts.isIdentifier(node) &&
      checker.getSymbolAtLocation(node) === expectSymbol
    ) {
      const parent = node.parent;
      const directImport =
        ts.isImportSpecifier(parent) && parent.name === node;
      const directExpectCall =
        ts.isCallExpression(parent) &&
        parent.expression === node &&
        allowedExpectCalls.has(parent);
      const staticRead =
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === node &&
        accessName(parent) !== undefined &&
        accessName(parent) !== "extend" &&
        accessName(parent) !== "prototype";
      if (!directImport && !directExpectCall && !staticRead) {
        throw new Error(
          "semantic positive control may not mutate or alias bun:test expect",
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function directProductionBindings(
  sourceFile: ts.SourceFile,
  options: SemanticPositiveControlOptions,
  checker: ts.TypeChecker,
): SemanticProductionBinding[] {
  const allowed = new Map(
    options.allowedProductionPaths.map((path) => [resolve(path), path] as const),
  );
  const bindings: SemanticProductionBinding[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".") ||
      statement.importClause === undefined ||
      statement.importClause.isTypeOnly
    ) {
      continue;
    }
    const productionPath = allowed.get(
      resolve(dirname(options.testPath), statement.moduleSpecifier.text),
    );
    if (productionPath === undefined) continue;
    if (statement.importClause.name !== undefined) {
      const symbol = checker.getSymbolAtLocation(statement.importClause.name);
      if (symbol !== undefined) {
        bindings.push({
          symbol,
          namespace: false,
          productionPath,
          entrypoint: "default",
        });
      }
    }
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings === undefined) continue;
    if (ts.isNamespaceImport(namedBindings)) {
      const symbol = checker.getSymbolAtLocation(namedBindings.name);
      if (symbol !== undefined) {
        bindings.push({
          symbol,
          namespace: true,
          productionPath,
          entrypoint: undefined,
        });
      }
    } else if (ts.isNamedImports(namedBindings)) {
      for (const specifier of namedBindings.elements) {
        if (specifier.isTypeOnly) continue;
        const symbol = checker.getSymbolAtLocation(specifier.name);
        if (symbol !== undefined) {
          bindings.push({
            symbol,
            namespace: false,
            productionPath,
            entrypoint: specifier.propertyName?.text ?? specifier.name.text,
          });
        }
      }
    }
  }
  return bindings;
}

function staticString(node: ts.Node | undefined): string | undefined {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function declaredNames(root: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node)
    ) {
      recordBindingName(node.name, names);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return names;
}

function recordBindingName(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) recordBindingName(element.name, names);
  }
}

function recordBindingState(
  name: ts.BindingName,
  state: SemanticProductionState,
  states: Map<ts.Symbol, SemanticProductionState>,
  checker: ts.TypeChecker,
): void {
  if (ts.isIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol !== undefined) states.set(symbol, state);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      recordBindingState(
        element.name,
        AMBIGUOUS_PRODUCTION_STATE,
        states,
        checker,
      );
    }
  }
}

function recordAssignmentState(
  target: ts.Expression,
  state: SemanticProductionState,
  states: Map<ts.Symbol, SemanticProductionState>,
  checker: ts.TypeChecker,
): void {
  const current = unwrapExpression(target);
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (symbol !== undefined) states.set(symbol, state);
    return;
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined) states.set(symbol, AMBIGUOUS_PRODUCTION_STATE);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(current);
}

function invalidateExactProductionStates(
  states: Map<ts.Symbol, SemanticProductionState>,
): void {
  for (const [symbol, state] of states) {
    if (state.kind === "exact") {
      states.set(symbol, AMBIGUOUS_PRODUCTION_STATE);
    }
  }
}

function immutableConstBindingInitializer(
  symbol: ts.Symbol,
): ts.Expression | undefined {
  const declarations = symbol.declarations;
  if (declarations === undefined || declarations.length !== 1) {
    return undefined;
  }
  const declaration = declarations[0]!;
  if (
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    declaration.initializer === undefined ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  return declaration.initializer;
}

function expressionIsProvenPassive(
  node: ts.Node,
  states: ReadonlyMap<ts.Symbol, SemanticProductionState>,
  checker: ts.TypeChecker,
  rejectExactReferences: boolean,
  seenBindings: ReadonlySet<ts.Symbol> = new Set(),
): boolean {
  if (
    isFunctionBoundary(node) ||
    ts.isCallExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isYieldExpression(node) ||
    ts.isTaggedTemplateExpression(node) ||
    ts.isTemplateExpression(node) ||
    ts.isComputedPropertyName(node) ||
    ts.isSpreadElement(node) ||
    ts.isSpreadAssignment(node) ||
    isAmbiguousControlFlow(node) ||
    isUpdateExpression(node) ||
    (ts.isBinaryExpression(node) &&
      node.operatorToken.kind !== ts.SyntaxKind.CommaToken)
  ) {
    return false;
  }
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    if (
      node.text === "undefined" &&
      (symbol === undefined || (symbol.declarations?.length ?? 0) === 0)
    ) {
      return true;
    }
    if (
      symbol === undefined ||
      seenBindings.has(symbol) ||
      (rejectExactReferences && states.get(symbol)?.kind === "exact")
    ) {
      return false;
    }
    const initializer = immutableConstBindingInitializer(symbol);
    if (initializer === undefined) return false;
    const nextSeen = new Set(seenBindings);
    nextSeen.add(symbol);
    return expressionResolvesToPrimitive(
      initializer,
      checker,
      nextSeen,
    );
  }
  if (ts.isPropertyAssignment(node)) {
    return (
      !ts.isComputedPropertyName(node.name) &&
      expressionIsProvenPassive(
        node.initializer,
        states,
        checker,
        rejectExactReferences,
        seenBindings,
      )
    );
  }
  let passive = true;
  ts.forEachChild(node, (child) => {
    if (
      passive &&
      !expressionIsProvenPassive(
        child,
        states,
        checker,
        rejectExactReferences,
        seenBindings,
      )
    ) {
      passive = false;
    }
  });
  return passive;
}

function matcherArgumentsAreIndependent(
  matcher: ts.CallExpression,
  states: ReadonlyMap<ts.Symbol, SemanticProductionState>,
  checker: ts.TypeChecker,
): boolean {
  return matcher.arguments.every((argument) =>
    expressionIsProvenPassive(argument, states, checker, true),
  );
}

function hasExactProductionState(
  states: ReadonlyMap<ts.Symbol, SemanticProductionState>,
): boolean {
  for (const state of states.values()) {
    if (state.kind === "exact") return true;
  }
  return false;
}

function expressionResolvesToPrimitive(
  node: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol> = new Set(),
): boolean {
  const current = unwrapExpression(node);
  if (
    ts.isStringLiteral(current) ||
    ts.isNumericLiteral(current) ||
    ts.isBigIntLiteral(current) ||
    ts.isNoSubstitutionTemplateLiteral(current) ||
    current.kind === ts.SyntaxKind.TrueKeyword ||
    current.kind === ts.SyntaxKind.FalseKeyword ||
    current.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(current) &&
    (current.operator === ts.SyntaxKind.PlusToken ||
      current.operator === ts.SyntaxKind.MinusToken) &&
    (ts.isNumericLiteral(current.operand) || ts.isBigIntLiteral(current.operand))
  ) {
    return true;
  }
  if (!ts.isIdentifier(current)) return false;
  const symbol = checker.getSymbolAtLocation(current);
  if (
    current.text === "undefined" &&
    (symbol === undefined || (symbol.declarations?.length ?? 0) === 0)
  ) {
    return true;
  }
  if (symbol === undefined || seen.has(symbol)) return false;
  seen.add(symbol);
  for (const declaration of symbol.declarations ?? []) {
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      (declaration.parent.flags & ts.NodeFlags.Const) === 0
    ) {
      continue;
    }
    if (expressionResolvesToPrimitive(declaration.initializer, checker, seen)) {
      return true;
    }
  }
  return false;
}

function productionCallArgumentsArePassive(
  call: ts.CallExpression,
  states: ReadonlyMap<ts.Symbol, SemanticProductionState>,
  checker: ts.TypeChecker,
): boolean {
  return (
    !hasExactProductionState(states) ||
    call.arguments.every((argument) =>
      expressionResolvesToPrimitive(argument, checker),
    )
  );
}

function matcherReceivedProductionState(
  node: ts.Expression,
  states: ReadonlyMap<ts.Symbol, SemanticProductionState>,
  bindings: readonly SemanticProductionBinding[],
  checker: ts.TypeChecker,
): SemanticProductionState {
  if (ts.isOptionalChain(node)) return AMBIGUOUS_PRODUCTION_STATE;
  const current = unwrapExpression(node);
  if (ts.isAwaitExpression(current)) {
    return matcherReceivedProductionState(
      current.expression,
      states,
      bindings,
      checker,
    );
  }
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    if (
      ts.isElementAccessExpression(current) &&
      current.argumentExpression !== undefined &&
      !expressionIsProvenPassive(
        current.argumentExpression,
        states,
        checker,
        false,
      )
    ) {
      return AMBIGUOUS_PRODUCTION_STATE;
    }
    return matcherReceivedProductionState(
      current.expression,
      states,
      bindings,
      checker,
    );
  }
  return expressionProductionState(current, states, bindings, checker);
}

function observeProductionOrigin(
  root: ts.Node,
  bindings: readonly SemanticProductionBinding[],
  checker: ts.TypeChecker,
): SemanticProductionOrigin | undefined {
  type Completion =
    | { readonly kind: "normal" }
    | { readonly kind: "blocked" }
    | { readonly kind: "function-exit" }
    | { readonly kind: "break"; readonly label: string | undefined }
    | { readonly kind: "continue"; readonly label: string | undefined };
  const normal: Completion = { kind: "normal" };
  const blocked: Completion = { kind: "blocked" };
  const functionExit: Completion = { kind: "function-exit" };
  const states = new Map<ts.Symbol, SemanticProductionState>();
  let observed: SemanticProductionOrigin | undefined;
  const visit = (node: ts.Node): Completion => {
    if (observed !== undefined) return normal;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      invalidateExactProductionStates(states);
      return normal;
    }
    if (node !== root && isFunctionBoundary(node)) return normal;
    if (ts.isOptionalChain(node)) {
      invalidateExactProductionStates(states);
      markAmbiguousWrites(node, states, checker);
      return normal;
    }
    if (isAmbiguousControlFlow(node)) {
      invalidateExactProductionStates(states);
      markAmbiguousWrites(node, states, checker);
      return blocked;
    }
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) {
      return functionExit;
    }
    if (ts.isBreakStatement(node)) {
      return { kind: "break", label: node.label?.text };
    }
    if (ts.isContinueStatement(node)) {
      return { kind: "continue", label: node.label?.text };
    }
    if (ts.isLabeledStatement(node)) {
      const completion = visit(node.statement);
      return completion.kind === "break" &&
        completion.label === node.label.text
        ? normal
        : completion;
    }
    if (ts.isVariableDeclaration(node)) {
      if (node.initializer !== undefined) {
        const completion = visit(node.initializer);
        if (completion.kind !== "normal") return completion;
      }
      const state =
        node.initializer === undefined
          ? UNTAINTED_PRODUCTION_STATE
          : expressionProductionState(
              node.initializer,
              states,
              bindings,
              checker,
            );
      if (ts.isIdentifier(node.name)) {
        recordBindingState(node.name, state, states, checker);
      } else {
        invalidateExactProductionStates(states);
        recordBindingState(
          node.name,
          AMBIGUOUS_PRODUCTION_STATE,
          states,
          checker,
        );
      }
      return normal;
    }
    if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperatorKind(node.operatorToken.kind)
    ) {
      let completion: Completion = normal;
      if (!ts.isIdentifier(unwrapExpression(node.left))) {
        completion = visit(node.left);
      }
      if (completion.kind === "normal") completion = visit(node.right);
      if (completion.kind !== "normal") return completion;
      const state =
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrapExpression(node.left))
          ? expressionProductionState(node.right, states, bindings, checker)
          : AMBIGUOUS_PRODUCTION_STATE;
      if (state.kind === "ambiguous") {
        invalidateExactProductionStates(states);
      }
      recordAssignmentState(node.left, state, states, checker);
      return normal;
    }
    if (isUpdateExpression(node)) {
      const completion = visit(node.operand);
      if (completion.kind !== "normal") return completion;
      invalidateExactProductionStates(states);
      recordAssignmentState(
        node.operand,
        AMBIGUOUS_PRODUCTION_STATE,
        states,
        checker,
      );
      return normal;
    }
    if (ts.isNewExpression(node)) {
      let completion = visit(node.expression);
      for (const argument of node.arguments ?? []) {
        if (completion.kind === "normal") completion = visit(argument);
      }
      invalidateExactProductionStates(states);
      return completion;
    }
    if (ts.isCallExpression(node)) {
      const assertionExpect = assertionExpectCall(node);
      if (assertionExpect !== undefined) {
        const received = assertionExpect.arguments[0];
        if (received === undefined) return normal;
        const state = matcherReceivedProductionState(
          received,
          states,
          bindings,
          checker,
        );
        if (state.kind !== "exact") {
          const completion = visit(received);
          if (completion.kind !== "normal") return completion;
        }
        const independentArguments = matcherArgumentsAreIndependent(
          node,
          states,
          checker,
        );
        if (state.kind === "exact" && independentArguments) {
          observed = state.origin;
        } else if (!independentArguments) {
          invalidateExactProductionStates(states);
        }
        return normal;
      }

      const direct = directProductionCallOrigin(node, bindings, checker);
      const passiveArguments = productionCallArgumentsArePassive(
        node,
        states,
        checker,
      );
      let completion: Completion = normal;
      if (direct === undefined) completion = visit(node.expression);
      for (const argument of node.arguments) {
        if (completion.kind === "normal") completion = visit(argument);
      }
      if (direct === undefined || !passiveArguments) {
        invalidateExactProductionStates(states);
      }
      return completion;
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      let completion = visit(node.expression);
      if (
        completion.kind === "normal" &&
        ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined
      ) {
        completion = visit(node.argumentExpression);
      }
      invalidateExactProductionStates(states);
      return completion;
    }
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
      const completion = visit(node.expression);
      invalidateExactProductionStates(states);
      return completion;
    }
    if (
      ts.isIdentifier(node) ||
      ts.isLiteralExpression(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      node.kind === ts.SyntaxKind.ThisKeyword
    ) {
      return normal;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      return visit(node.expression);
    }
    let completion: Completion = normal;
    ts.forEachChild(node, (child) => {
      if (completion.kind === "normal" && observed === undefined) {
        completion = visit(child);
      }
    });
    if (ts.isExpression(node)) invalidateExactProductionStates(states);
    return completion;
  };
  visit(root);
  return observed;
}

function isAmbiguousControlFlow(node: ts.Node): boolean {
  if (
    ts.isIfStatement(node) ||
    ts.isIterationStatement(node, false) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isConditionalExpression(node)
  ) {
    return true;
  }
  return (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  );
}

function markAmbiguousWrites(
  root: ts.Node,
  states: Map<ts.Symbol, SemanticProductionState>,
  checker: ts.TypeChecker,
): void {
  const visit = (node: ts.Node): void => {
    if (node !== root && isFunctionBoundary(node)) return;
    if (ts.isVariableDeclaration(node)) {
      recordBindingState(
        node.name,
        AMBIGUOUS_PRODUCTION_STATE,
        states,
        checker,
      );
    } else if (
      ts.isBinaryExpression(node) &&
      isAssignmentOperatorKind(node.operatorToken.kind)
    ) {
      recordAssignmentState(
        node.left,
        AMBIGUOUS_PRODUCTION_STATE,
        states,
        checker,
      );
    } else if (isUpdateExpression(node)) {
      recordAssignmentState(
        node.operand,
        AMBIGUOUS_PRODUCTION_STATE,
        states,
        checker,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function isAssignmentOperatorKind(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function isUpdateExpression(
  node: ts.Node,
): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression {
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

function isFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

function expressionProductionState(
  node: ts.Node,
  states: ReadonlyMap<ts.Symbol, SemanticProductionState>,
  bindings: readonly SemanticProductionBinding[],
  checker: ts.TypeChecker,
): SemanticProductionState {
  if (ts.isOptionalChain(node)) return AMBIGUOUS_PRODUCTION_STATE;
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol === undefined
      ? UNTAINTED_PRODUCTION_STATE
      : (states.get(symbol) ?? UNTAINTED_PRODUCTION_STATE);
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node)
  ) {
    return expressionProductionState(node.expression, states, bindings, checker);
  }
  if (ts.isCallExpression(node)) {
    const direct = directProductionCallOrigin(node, bindings, checker);
    if (direct !== undefined) {
      return productionCallArgumentsArePassive(node, states, checker)
        ? { kind: "exact", origin: direct }
        : AMBIGUOUS_PRODUCTION_STATE;
    }
  }
  return UNTAINTED_PRODUCTION_STATE;
}

function directProductionCallOrigin(
  call: ts.CallExpression,
  bindings: readonly SemanticProductionBinding[],
  checker: ts.TypeChecker,
): SemanticProductionOrigin | undefined {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    const symbol = checker.getSymbolAtLocation(callee);
    const binding = bindings.find(
      (binding) => !binding.namespace && binding.symbol === symbol,
    );
    return binding?.entrypoint === undefined
      ? undefined
      : {
          productionPath: binding.productionPath,
          entrypoint: binding.entrypoint,
        };
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression)
  ) {
    const symbol = checker.getSymbolAtLocation(callee.expression);
    const binding = bindings.find(
      (binding) => binding.namespace && binding.symbol === symbol,
    );
    return binding === undefined
      ? undefined
      : {
          productionPath: binding.productionPath,
          entrypoint: callee.name.text,
        };
  }
  return undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function assertCommandDidNotTimeOut(command: GateCommandOutput): void {
  if (/Command timed out after \d+ms$/m.test(command.stderr)) {
    throw new Error(
      `${command.command} timed out before reproduction proof:\n${commandFailureMessage(command)}`,
    );
  }
  if (command.exitCode === null) {
    throw new Error(
      `${command.command} terminated without an exit code before reproduction proof:\n${commandFailureMessage(command)}`,
    );
  }
}

export async function runTargetAfterPositiveControl<T>(
  control: GateCommandOutput,
  expectedControlName: string,
  runTarget: () => Promise<T>,
): Promise<T> {
  assertPositiveControlEvidence(control, expectedControlName);
  return await runTarget();
}

export function assertRedGateEvidence(
  control: GateCommandOutput,
  expectedControlName: string,
  red: GateCommandOutput,
  expectedTargetName: string,
  expectedPattern: string,
): void {
  assertPositiveControlEvidence(control, expectedControlName);
  assertCommandDidNotTimeOut(red);
  if (red.status !== "failed") {
    throw new InvalidReproductionProofError(
      "target-passed",
      `${red.command} unexpectedly passed before implementation`,
    );
  }
  assertSingleLineValue(expectedPattern, "candidate RED marker");
  const marker = expectedPattern;
  if (isGenericExpectedFailurePattern(marker)) {
    throw new Error(
      `generic expected failure pattern is not allowed: ${expectedPattern}`,
    );
  }
  assertSingleLineValue(expectedTargetName, "candidate RED target name");
  if (!containsExactMarker(expectedTargetName, marker)) {
    throw new InvalidReproductionProofError(
      "target-wrong-pattern",
      `${red.command} exact target name ${expectedTargetName} is without expected pattern ${expectedPattern}`,
    );
  }
  const output = `${red.stdout}\n${red.stderr}`.replaceAll("\r\n", "\n");
  if (output.includes("\r")) {
    throw new InvalidReproductionProofError(
      "target-wrong-pattern",
      `${red.command} contains a non-canonical carriage return`,
    );
  }
  const lines = output.split("\n");
  const reporterRecords = lines.filter((line) =>
    /^\((?:pass|fail|skip|todo)\)(?:\s|$)/u.test(line),
  );
  const escapedTargetName = expectedTargetName.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const exactFailureRecord = new RegExp(
    `^\\(fail\\) ${escapedTargetName} \\[[^\\]\\r\\n]+\\]$`,
    "u",
  );
  if (
    reporterRecords.length !== 1 ||
    !exactFailureRecord.test(reporterRecords[0]!)
  ) {
    throw new InvalidReproductionProofError(
      "target-wrong-pattern",
      `${red.command} expected exactly one Bun reporter record for the marker-bound target failing Bun test ${expectedTargetName}`,
    );
  }
  const exactCount = (pattern: RegExp): number =>
    lines.filter((line) => pattern.test(line)).length;
  const canonicalSummary =
    /^bun test(?:\s|$)/u.test(red.command) &&
    exactCount(/^bun test v\d+\.\d+\.\d+ \([0-9a-f]+\)$/u) === 1 &&
    exactCount(/^\s*\d+ pass\s*$/u) === 1 &&
    exactCount(/^\s*0 pass\s*$/u) === 1 &&
    exactCount(/^\s*\d+ fail\s*$/u) === 1 &&
    exactCount(/^\s*1 fail\s*$/u) === 1 &&
    exactCount(/^\s*\d+ expect\(\) calls\s*$/u) === 1 &&
    exactCount(/^\s*[1-9]\d* expect\(\) calls\s*$/u) === 1 &&
    exactCount(/^Ran \d+ tests? across \d+ files?\. \[[^\]\r\n]+\]$/u) ===
      1 &&
    exactCount(/^Ran 1 test across 1 file\. \[[^\]\r\n]+\]$/u) === 1;
  if (!canonicalSummary) {
    throw new InvalidReproductionProofError(
      "target-wrong-pattern",
      `${red.command} lacks a canonical Bun one-test failing summary`,
    );
  }
}

export function reserveConversationTimeouts(
  availableMs: number,
  requestedActiveMs: number,
  settlementReserveMs: number,
  stage: string,
): {
  readonly activeTimeoutMs: number;
  readonly settlementTimeoutMs: number;
} {
  const available = Math.floor(availableMs);
  const requestedActive = Math.floor(requestedActiveMs);
  const requestedSettlement = Math.floor(settlementReserveMs);
  if (
    !Number.isFinite(available) ||
    !Number.isFinite(requestedActive) ||
    !Number.isFinite(requestedSettlement) ||
    available < 2 ||
    requestedActive <= 0 ||
    requestedSettlement <= 0
  ) {
    throw new Error(`sla-overrun before ${stage} conversation`);
  }
  const settlementTimeoutMs = Math.min(
    requestedSettlement,
    Math.floor(available / 2),
  );
  const activeTimeoutMs = Math.min(
    requestedActive,
    available - settlementTimeoutMs,
  );
  return { activeTimeoutMs, settlementTimeoutMs };
}

export async function awaitBounded<T>(
  conversation: BoundedConversation<T>,
  timeoutMs: number,
  stage: string,
  settlementTimeoutMs = timeoutMs,
  now: () => number = Date.now,
): Promise<T> {
  if (timeoutMs <= 0) throw new Error(`sla-overrun before ${stage}`);
  if (settlementTimeoutMs <= 0) {
    throw new Error(`sla-overrun before ${stage} cancellation settlement`);
  }
  const deadlineAtMs = now() + timeoutMs;
  let activeTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new ConversationTimeoutError(stage, timeoutMs);
  const terminal = observeTerminal(() => conversation.awaitResult(), now);
  const activeDeadline = new Promise<{ readonly type: "timeout" }>((resolve) => {
    activeTimer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
  });
  const first = await Promise.race([
    terminal,
    activeDeadline,
  ]);
  if (activeTimer !== undefined) clearTimeout(activeTimer);
  if (!("type" in first)) {
    if (first.completedAtMs >= deadlineAtMs) {
      throw new ConversationTimeoutError(stage, timeoutMs, first);
    }
    if (first.status === "rejected") throw first.reason;
    return first.value;
  }

  const cancellation = Promise.resolve().then(() =>
    conversation.cancel(timeoutError.message),
  );
  const settlementDeadlineAtMs = now() + settlementTimeoutMs;
  const terminalSettlement = observeTerminal(async () => {
    await Promise.allSettled([terminal, cancellation]);
  }, now);
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  const settlementDeadline = new Promise<{ readonly status: "timeout" }>((resolve) => {
    settlementTimer = setTimeout(
      () => resolve({ status: "timeout" }),
      settlementTimeoutMs,
    );
  });
  const settled = await Promise.race([
    terminalSettlement,
    settlementDeadline,
  ]);
  if (settlementTimer !== undefined) clearTimeout(settlementTimer);
  if (
    settled.status === "timeout" ||
    settled.completedAtMs >= settlementDeadlineAtMs
  ) {
    throw new ConversationSettlementTimeoutError(stage, settlementTimeoutMs);
  }
  throw new ConversationTimeoutError(stage, timeoutMs, await terminal);
}

function timeoutRetryUsage(outcome: TimeoutRetryOutcome): Usage | undefined {
  return (
    outcome as TimeoutRetryOutcome & {
      readonly result?: { readonly usage?: Usage };
    }
  ).result?.usage;
}

function timeoutRetryTerminal(
  terminal: TerminalSettlement<unknown> | undefined,
): TimeoutRetryTerminalEvidence | undefined {
  if (terminal === undefined) return undefined;
  if (terminal.status === "rejected") {
    return {
      status: "rejected",
      completedAtMs: terminal.completedAtMs,
      reason: normalizeFailure(terminal.reason),
    };
  }
  const outcome = terminal.value as TimeoutRetryOutcome;
  const usage = timeoutRetryUsage(outcome);
  return {
    status: "fulfilled",
    completedAtMs: terminal.completedAtMs,
    outcomeType: outcome.type,
    ...(usage === undefined ? {} : { usage }),
  };
}

export async function awaitOneTimeoutRetry<T extends TimeoutRetryOutcome>(
  runAttempt: (attempt: TimeoutRetryAttempt) => Promise<T>,
  options: TimeoutRetryOptions,
): Promise<TimeoutRetryResult<T>> {
  const now = options.now ?? Date.now;
  const deadlineMs = now() + options.totalTimeoutMs;
  const records: TimeoutRetryRecord[] = [];
  let lastTimeout: T | undefined;

  for (const attempt of [1, 2] as const) {
    const startedAtMs = now();
    const availableMs = deadlineMs - startedAtMs;
    if (attempt === 2 && availableMs < 2) {
      if (lastTimeout === undefined) {
        throw new Error(`unreachable ${options.stage} retry state`);
      }
      return { outcome: lastTimeout, attempts: records };
    }
    const label = `${options.stage} attempt ${String(attempt)}`;
    const timeouts = reserveConversationTimeouts(
      availableMs,
      options.attemptTimeoutMs,
      options.settlementTimeoutMs,
      label,
    );
    const timeoutMs = timeouts.activeTimeoutMs;
    const settlementTimeoutMs = timeouts.settlementTimeoutMs;
    const attemptDeadlineMs = startedAtMs + timeoutMs;
    const terminal = await observeTerminal(
      () => runAttempt({
        attempt,
        timeoutMs,
        settlementTimeoutMs,
        label,
      }),
      now,
    );
    if (terminal.status === "rejected") {
      const error = terminal.reason;
      const timedOut =
        error instanceof ConversationTimeoutError &&
        error.stage === label &&
        error.timeoutMs === timeoutMs;
      if (!timedOut) throw error;
      const cancelled = {
        type: "cancelled",
        reason: error.message,
      } as unknown as T;
      const retainedTerminal = timeoutRetryTerminal(error.terminal);
      records.push({
        attempt,
        timeoutMs,
        settlementTimeoutMs,
        label,
        durationMs: Math.max(0, terminal.completedAtMs - startedAtMs),
        outcomeType: cancelled.type,
        timedOut: true,
        ...(retainedTerminal === undefined
          ? {}
          : { terminal: retainedTerminal }),
      });
      lastTimeout = cancelled;
      if (attempt === 1 && deadlineMs - terminal.completedAtMs >= 2) continue;
      return { outcome: cancelled, attempts: records };
    }
    const outcome = terminal.value;
    const completedLate =
      outcome.type === "success" &&
      (terminal.completedAtMs >= attemptDeadlineMs ||
        terminal.completedAtMs >= deadlineMs);
    if (completedLate) {
      const cancelled = {
        type: "cancelled",
        reason: `${label} exceeded ${String(timeoutMs)}ms`,
      } as unknown as T;
      records.push({
        attempt,
        timeoutMs,
        settlementTimeoutMs,
        label,
        durationMs: Math.max(0, terminal.completedAtMs - startedAtMs),
        outcomeType: cancelled.type,
        timedOut: true,
        terminal: timeoutRetryTerminal(terminal)!,
      });
      lastTimeout = cancelled;
      if (attempt === 1 && deadlineMs - terminal.completedAtMs >= 2) continue;
      return { outcome: cancelled, attempts: records };
    }
    const timedOut =
      outcome.type === "cancelled" &&
      outcome.reason === `${label} exceeded ${String(timeoutMs)}ms`;
    records.push({
      attempt,
      timeoutMs,
      settlementTimeoutMs,
      label,
      durationMs: Math.max(0, terminal.completedAtMs - startedAtMs),
      outcomeType: outcome.type,
      timedOut,
    });
    if (timedOut) lastTimeout = outcome;
    if (
      attempt === 1 &&
      timedOut &&
      deadlineMs - terminal.completedAtMs >= 2
    ) {
      continue;
    }
    return { outcome, attempts: records };
  }

  throw new Error(`unreachable ${options.stage} retry state`);
}

export async function awaitWithinDeadline<T>(
  label: string,
  remainingMs: () => number,
  operation: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const startedAtMs = now();
  const timeoutMs = remainingMs();
  if (timeoutMs <= 0) {
    throw new Error(
      `${label} exceeded shared deadline after ${String(timeoutMs)}ms`,
    );
  }
  const deadlineAtMs = startedAtMs + timeoutMs;
  const message = `${label} exceeded shared deadline after ${String(timeoutMs)}ms`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly status: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  const terminal = observeTerminal(operation, now);
  try {
    const first = await Promise.race([terminal, deadline]);
    if (first.status === "timeout") throw new Error(message);
    if (first.completedAtMs >= deadlineAtMs) {
      throw first.status === "rejected"
        ? new Error(message, { cause: first.reason })
        : new Error(message);
    }
    if (first.status === "rejected") throw first.reason;
    return first.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function assertRemainingBudget(
  remainingMs: number,
  operation: string,
): void {
  if (remainingMs <= 0) {
    throw new Error(`sla-overrun after ${operation}`);
  }
}

export function hasConfirmedExpectedFileChange(
  state: ExpectedFileChangeState,
  changedPaths: readonly string[],
  expectedPath: string,
): boolean {
  return (
    state !== "unconfirmed" &&
    changedPaths.length === 1 &&
    resolve(changedPaths[0]!) === resolve(expectedPath)
  );
}

type SettledOutcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

function cancelBestEffort(
  conversation: { cancel(reason?: string): Promise<void> },
  reason: string,
): void {
  try {
    void Promise.resolve(conversation.cancel(reason)).catch(() => {});
  } catch {}
}

function closeIteratorBestEffort(
  iterator: AsyncIterator<ConversationEvent>,
): void {
  try {
    const closing = iterator.return?.();
    if (closing !== undefined) {
      void Promise.resolve(closing).catch(() => {});
    }
  } catch {}
}

async function observeEventsUntilOutcome<T>(
  conversation: ToolFreeConversation,
  awaitOutcome: () => Promise<T>,
  onEvent: (event: ConversationEvent) => void,
): Promise<T> {
  const outcome: Promise<SettledOutcome<T>> = Promise.resolve()
    .then(awaitOutcome)
    .then(
      (value): SettledOutcome<T> => ({ status: "fulfilled", value }),
      (reason: unknown): SettledOutcome<T> => ({ status: "rejected", reason }),
    );
  const iterator = conversation.events()[Symbol.asyncIterator]();
  let eventFailure: { readonly reason: unknown } | undefined;

  while (eventFailure === undefined) {
    const next = Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => ({ kind: "event" as const, result }),
        (reason: unknown) => ({ kind: "event-error" as const, reason }),
      );
    let winner = await Promise.race([
      next,
      outcome.then((settled) => ({ kind: "outcome" as const, settled })),
    ]);
    if (winner.kind === "outcome") {
      const settled = winner.settled;
      await Promise.resolve();
      const buffered = await Promise.race([
        next,
        Promise.resolve({ kind: "no-buffered-event" as const }),
      ]);
      if (buffered.kind === "no-buffered-event") {
        closeIteratorBestEffort(iterator);
        if (settled.status === "rejected") throw settled.reason;
        return settled.value;
      }
      winner = buffered;
    }
    if (winner.kind === "event-error") {
      eventFailure = { reason: winner.reason };
      closeIteratorBestEffort(iterator);
      break;
    }
    if (winner.result.done) break;
    try {
      onEvent(winner.result.value);
    } catch (error) {
      eventFailure = { reason: error };
      closeIteratorBestEffort(iterator);
    }
  }

  const settled = await outcome;
  if (eventFailure !== undefined) throw eventFailure.reason;
  if (settled.status === "rejected") throw settled.reason;
  return settled.value;
}

export async function awaitExpectedFileChange<T>(
  conversation: ToolFreeConversation,
  expectedPath: string,
  awaitOutcome: () => Promise<T>,
): Promise<ExpectedFileChangeResult<T>> {
  const expectedCallIds = new Set<string>();
  let expectedFileChangeState: ExpectedFileChangeState = "none";
  const outcome = await observeEventsUntilOutcome(
    conversation,
    awaitOutcome,
    (event) => {
      if (
        event.type === "assistant_tool_call" &&
        event.name === "file_change"
      ) {
        const paths = fileChangePaths(event.input);
        const unexpectedPath = paths?.find(
          (path) => resolve(path) !== resolve(expectedPath),
        );
        if (paths === undefined || unexpectedPath !== undefined) {
          cancelBestEffort(
            conversation,
            "reproduce attempted unexpected file change",
          );
          throw new Error(
            `unexpected file change: ${unexpectedPath ?? "<unknown>"}`,
          );
        }
        expectedCallIds.add(event.id);
        if (expectedFileChangeState === "none") {
          expectedFileChangeState = "unconfirmed";
        }
        return;
      }
      if (
        event.type === "tool_result" &&
        expectedCallIds.delete(event.toolCallId) &&
        event.isError !== true &&
        expectedFileChangeState !== "applied"
      ) {
        expectedFileChangeState = "applied";
      }
    },
  );
  return { expectedFileChangeState, outcome };
}

function fileChangePaths(input: unknown): readonly string[] | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const paths: string[] = [];
  if ("path" in input) {
    if (typeof input.path !== "string") return undefined;
    paths.push(input.path);
  }
  if ("changes" in input) {
    if (!Array.isArray(input.changes) || input.changes.length === 0) {
      return undefined;
    }
    const nestedPaths: string[] = [];
    for (const change of input.changes) {
      if (
        typeof change !== "object" ||
        change === null
      ) {
        return undefined;
      }
      if ("path" in change) {
        if (typeof change.path !== "string") return undefined;
        nestedPaths.push(change.path);
      }
    }
    if (nestedPaths.length === input.changes.length) {
      paths.push(...nestedPaths);
    } else if (paths.length === 0 || nestedPaths.length > 0) {
      return undefined;
    }
  }
  return paths.length > 0 ? paths : undefined;
}

export async function awaitToolFreeOutcome<T>(
  conversation: ToolFreeConversation,
  awaitOutcome: () => Promise<T>,
): Promise<T> {
  return await observeEventsUntilOutcome(
    conversation,
    awaitOutcome,
    (event) => {
      if (
        (event.type === "assistant_tool_call" || event.type === "tool_result")
      ) {
        cancelBestEffort(conversation, "scout attempted tool use");
        throw new Error(`scout attempted tool use: ${event.type}`);
      }
    },
  );
}
