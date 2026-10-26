import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

test("searches nested files with the extracted runtime's native provider and filesystem", async () => {
  const root = join(import.meta.dir, "../..");
  const directory = await mkdtemp(join(tmpdir(), "zcode-runtime-workspace-paths-"));
  try {
    const child = Bun.spawn(["node", join(root, "test/fixtures/workspace-path-runtime.cjs")], {
      cwd: directory, env: runtimeTestEnv(directory), stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ]);
      expect(code, stderr || stdout).toBe(0);
      expect(stdout).toContain("Native workspace search passed");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
