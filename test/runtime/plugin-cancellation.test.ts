import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

const root = join(import.meta.dir, "../..");

test.skipIf(process.platform === "win32").each(["signal", "timeout"] as const)(
  "a stalled marketplace add releases its native lock on %s and allows the next add", async kind => {
    const home = await mkdtemp(join(tmpdir(), "zcode-plugin-cancel-"));
    let started!: () => void;
    const downloading = new Promise<void>(resolve => { started = resolve; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (new URL(request.url).pathname === "/stalled.json") {
        started();
        return await new Promise<Response>(() => {});
      }
      return Response.json({ name: "recovered-marketplace", plugins: [] });
    } });
    const env = { ...runtimeTestEnv(home),
      http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", all_proxy: "", ALL_PROXY: "",
      ZCODE_PLUGIN_REQUEST_TIMEOUT_MS: kind === "timeout" ? "5000" : "15000" };
    const launch = (path: string) => Bun.spawn([
      Bun.which("node")!, join(root, "bin/zcode.js"), "plugins", "marketplace", "add", `${server.url.origin}/${path}`, "--yes", "--json"
    ], { cwd: home, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let child = launch("stalled.json");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const lock = join(home, ".zcode/cli/plugins/installed_plugins.json.lock");
    try {
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      // The request starts after the runtime acquires the real mutation lock.
      await Promise.race([downloading, child.exited.then(() => { throw new Error("Add exited before starting the download."); })]);
      expect((await readdir(lock)).some(name => name.startsWith("owner-"))).toBe(true);
      if (kind === "signal") child.kill("SIGTERM");
      const code = await child.exited;
      const [stdout, stderr] = await output;
      expect(code, `${stdout}\n${stderr}`).toBe(kind === "signal" ? 143 : 1);
      expect(stderr).toContain(kind === "signal" ? "App-server request cancelled." : "timed out after 5000ms");
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });

      child = launch("healthy.json");
      const [nextCode, nextOut, nextErr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ]);
      expect(nextCode, nextErr).toBe(0);
      expect(JSON.parse(nextOut)).toMatchObject({ marketplace: { id: "recovered-marketplace" }, diagnostics: [] });
      await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  }, 25_000
);
