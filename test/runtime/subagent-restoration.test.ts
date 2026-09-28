import { expect, test } from "bun:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeSubagentQueryBridge } from "../../scripts/sync-runtime.ts";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

test("restores subagents with the extracted runtime's native query and reducer", async () => {
  const root = join(import.meta.dir, "../..");
  const source = await readFile(join(root, "vendor/zcode.cjs"), "utf8");
  const queryBridge = runtimeSubagentQueryBridge(source);
  const directory = await mkdtemp(join(tmpdir(), "zcode-subagent-restore-"));
  try {
    const child = Bun.spawn(["node", join(root, "test/fixtures/subagent-restoration.cjs"), queryBridge], {
      cwd: directory, env: runtimeTestEnv(directory), stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ]);
      expect(code, stderr || stdout).toBe(0);
      expect(stdout).toContain("Native subagent restoration passed");
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
