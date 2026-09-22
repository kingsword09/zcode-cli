import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackageCommand } from "../scripts/package-command.ts";

const node = Bun.which("node")!;

test("package commands preserve stdout and nonzero exit codes", async () => {
  const result = await runPackageCommand(node, ["--eval", "console.log('检查完成');process.exitCode=7"], {
    cwd: process.cwd(), label: "Fixture check", timeoutMs: 5_000
  });
  expect(result).toEqual({ code: 7, stdout: "检查完成\n" });
});

test("package command timeouts terminate the process", async () => {
  await expect(runPackageCommand(node, ["--eval", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
    cwd: process.cwd(), label: "Fixture initialization", timeoutMs: 500
  })).rejects.toThrow("Fixture initialization timed out after 500 ms.");
}, 10_000);

test.skipIf(process.platform === "win32").each([false, true])(
  "package timeouts kill descendants holding stdout open (leader exits: %p)",
  async (leaderExits) => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-command-timeout-"));
    const heartbeat = join(directory, "heartbeat"), pidsPath = join(directory, "pids.json");
    const descendant = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {});
      let tick = 0;
      setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++tick)), 20);
    `;
    const script = `
      const fs = require("node:fs");
      const child = require("node:child_process").spawn(process.execPath, ["--eval", ${JSON.stringify(descendant)}], {
        stdio: ["ignore", "inherit", "ignore"]
      });
      fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, child.pid]));
      if (${leaderExits}) { child.unref(); process.exit(0); }
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    try {
      await expect(runPackageCommand(node, ["--eval", script], {
        cwd: directory, label: "Descendant fixture", timeoutMs: 1_500
      })).rejects.toThrow("Descendant fixture timed out after 1500 ms.");
      const stopped = await readFile(heartbeat, "utf8");
      await Bun.sleep(100);
      expect(await readFile(heartbeat, "utf8")).toBe(stopped);
    } finally {
      if (await Bun.file(pidsPath).exists()) {
        for (const pid of JSON.parse(await readFile(pidsPath, "utf8")) as number[]) {
          try { process.kill(pid, "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000
);
