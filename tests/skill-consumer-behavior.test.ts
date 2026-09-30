import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectExitZero, runCliProcess } from "./helpers/cli-process.ts";

const doctor = resolve("skills/orcats-setup/scripts/orca-doctor.sh");
const checker = resolve("skills/orcats-author/scripts/orca-typecheck-flow.sh");
const transports = [
  ["claude", "stream-json"],
  ["codex", "subprocess"],
  ["opencode", "http-sse"],
  ["pi", "subprocess"]
] as const;

type DoctorReport = {
  pass: boolean;
  backends: { backend: string; transport: string; status: string }[];
};

describe.skipIf(process.platform === "win32")("consumer skill script behavior", () => {
  let root: string;
  let bin: string;
  let env: Record<string, string>;

  async function executable(name: string, body: string): Promise<void> {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orca-skill-consumer-"));
    bin = join(root, "bin");
    await mkdir(bin);
    env = {
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: root,
      ORCA_REAL_BACKEND_SMOKE: "0",
      ORCA_CLAUDE_TRANSPORT: "stream-json",
      ORCA_CLAUDE_ACP_COMMAND: join(root, "missing-adapter"),
      ORCA_TEST_TRACE: join(root, "trace")
    };
    for (const [backend] of transports) {
      await executable(backend, `case "$*" in
  --version) printf 'stub 1.0\\n' ;;
  'login status') printf 'Logged in\\n' ;;
  'auth list') printf 'oauth\\n' ;;
  *) exit 90 ;;
esac`);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("all static backend probes remain unverified without spending", async () => {
    await executable("orcats", "exit 90");
    const result = await runCliProcess("/bin/bash", [doctor, "--all", "--json"], {
      cwd: root, env, timeoutMs: 5_000
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as DoctorReport;
    expect(report.pass).toBe(false);
    expect(report.backends.map(({ backend, transport }) => [backend, transport]))
      .toEqual(transports.map(([backend, transport]) => [backend, transport]));
    for (const row of report.backends) expect(row.status).toBe("unverified");
  });

  test("selected Claude ACP requires its adapter before readiness can be verified", async () => {
    const args = [doctor, "--backend", "claude", "--transport", "acp", "--json"];
    const missing = await runCliProcess("/bin/bash", args, { cwd: root, env, timeoutMs: 5_000 });
    expect(missing.timedOut).toBe(false);
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      pass: false, backends: [{ backend: "claude", transport: "acp", status: "missing" }]
    });

    await executable("adapter", "exit 0");
    const installed = await runCliProcess("/bin/bash", args, {
      cwd: root, env: { ...env, ORCA_CLAUDE_ACP_COMMAND: join(bin, "adapter") }, timeoutMs: 5_000
    });
    expect(installed.timedOut).toBe(false);
    expect(installed.exitCode).toBe(1);
    expect(JSON.parse(installed.stdout)).toMatchObject({
      pass: false, backends: [{ backend: "claude", transport: "acp", status: "unverified" }]
    });
  });

  test("only a successful gated smoke promotes the selected backend and transport", async () => {
    await executable("adapter", "exit 0");
    await executable("orcats", `printf '%s\\n' "$ORCA_CLAUDE_TRANSPORT" "$@" > "$ORCA_TEST_TRACE"
case "$ORCA_TEST_SMOKE_MODE" in
  success) printf 'orcats-smoke-ok\\n' ;;
  no-marker) printf 'turn failed\\n' ;;
  nonzero) printf 'orcats-smoke-ok\\n'; exit 7 ;;
  *) exit 90 ;;
esac`);
    for (const [backend, transport] of [...transports, ["claude", "acp"] as const]) {
      const modes = backend === "claude" && transport === "acp"
        ? ["success", "no-marker", "nonzero"]
        : ["success"];
      for (const mode of modes) {
        const envGate = backend === "claude" && transport === "acp" && mode === "success";
        const result = await runCliProcess("/bin/bash", [
          doctor, "--backend", backend, "--transport", transport,
          ...(envGate ? [] : ["--smoke"]), "--json"
        ], {
          cwd: root,
          env: {
            ...env,
            ORCA_REAL_BACKEND_SMOKE: envGate ? "1" : "0",
            ORCA_CLAUDE_ACP_COMMAND: join(bin, "adapter"),
            ORCA_TEST_SMOKE_MODE: mode
          },
          timeoutMs: 5_000
        });
        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(mode === "success" ? 0 : 1);
        const report = JSON.parse(result.stdout) as DoctorReport;
        expect(report.pass).toBe(mode === "success");
        expect(report.backends).toMatchObject([{ backend, transport }]);
        expect(report.backends[0]?.status === "ready").toBe(mode === "success");
        const trace = await readFile(join(root, "trace"), "utf8");
        expect(trace.split("\n")[0]).toBe(transport);
        expect(trace).toContain(`--backend\n${backend}\n`);
      }
    }
  }, 20_000);

  test("author checking runs orcats check without a tsconfig and propagates failure", async () => {
    const artifact = join(root, "consumer flow.ts");
    await writeFile(artifact, "export const ready = true;\n");
    await executable("orcats", `printf '%s\\n' "$@" > "$ORCA_TEST_TRACE"
if [ "\${ORCA_TEST_CHECK_FAIL:-0}" = 1 ]; then
  printf 'artifact check failed\\n' >&2
  exit 23
fi`);
    expect(existsSync(join(root, "tsconfig.json"))).toBe(false);
    const accepted = await runCliProcess("/bin/bash", [checker, artifact], {
      cwd: root, env, timeoutMs: 5_000
    });
    expectExitZero(accepted);
    expect((await readFile(join(root, "trace"), "utf8")).trimEnd().split("\n")).toEqual(["check", artifact]);

    const rejected = await runCliProcess("/bin/bash", [checker, artifact], {
      cwd: root, env: { ...env, ORCA_TEST_CHECK_FAIL: "1" }, timeoutMs: 5_000
    });
    expect(rejected.timedOut).toBe(false);
    expect(rejected.exitCode).toBe(23);
    expect(rejected.stderr).toContain("artifact check failed");
  });
});
