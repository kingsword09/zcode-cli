interface PackageCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  timeoutMs: number;
}

/** Bound each install check and stop its descendants before removing the temporary package. */
export async function runPackageCommand(
  command: string,
  args: string[],
  { cwd, env = process.env, label, timeoutMs }: PackageCommandOptions
): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn([command, ...args], {
    cwd, env,
    detached: process.platform !== "win32",
    stdin: "ignore", stdout: "pipe", stderr: "inherit"
  });
  const reader = child.stdout.getReader();
  const output = (async () => {
    const decoder = new TextDecoder();
    let stdout = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return stdout + decoder.decode();
      stdout += decoder.decode(value, { stream: true });
    }
  })();
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    try {
      if (process.platform === "win32") {
        const killer = Bun.spawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
          stdin: "ignore", stdout: "ignore", stderr: "ignore",
          timeout: 5_000, killSignal: "SIGKILL"
        });
        await killer.exited;
      } else {
        try {
          // The group can still contain descendants after its leader exits.
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await reader.cancel().catch(() => {});
      await child.exited;
    }
  })();
  const timeoutError = new Error(`${label} timed out after ${timeoutMs} ms.`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void stop().then(() => reject(timeoutError), reject);
    }, timeoutMs);
  });
  try {
    const [code, stdout] = await Promise.race([Promise.all([child.exited, output]), deadline]);
    if (stopping) {
      await stopping;
      throw timeoutError;
    }
    return { code, stdout };
  } finally {
    clearTimeout(timer);
    if (stopping || child.exitCode === null) await stop();
    reader.releaseLock();
  }
}
