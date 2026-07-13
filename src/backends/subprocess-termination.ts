import type { SubprocessProcess } from "./subprocess-run.ts";

const DefaultSubprocessTerminationGraceMs = 1_000;
const DefaultSubprocessForceGraceMs = 1_000;

export async function terminateSubprocess(
  process: SubprocessProcess,
  gracefulMs = DefaultSubprocessTerminationGraceMs,
  forceMs = DefaultSubprocessForceGraceMs
): Promise<void> {
  process.kill("SIGTERM");
  if (await exitsWithin(process.exit, gracefulMs)) {
    return;
  }

  process.kill("SIGKILL");
  if (!(await exitsWithin(process.exit, forceMs))) {
    throw new Error("subprocess did not exit after SIGKILL");
  }
}

async function exitsWithin(
  exit: Promise<number | null>,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, Math.max(timeoutMs, 0));
  });
  try {
    return await Promise.race([exit.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
