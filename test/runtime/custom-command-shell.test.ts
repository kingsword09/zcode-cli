import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cliSettingsPath, ensureCliSettings } from "../../src/model-access.ts";
import { writeProviderFixture } from "../fixtures/provider-config.ts";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

test.each([false, true])("custom command shell blocks reach the model without executing (launcher: %s)", async (launcher) => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-command-shell-"));
  const root = join(import.meta.dir, "../..");
  const env = runtimeTestEnv(directory);
  const prompts: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages: { role: string; content: unknown }[] };
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "Command fixture" }, finish_reason: "stop" }] });
    prompts.push(JSON.stringify(body.messages.filter(message => message.role === "user")));
    return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"COMMAND_HANDOFF_COMPLETE"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { "content-type": "text/event-stream" }
    });
  } });
  try {
    const workspace = join(directory, "workspace");
    const commands = join(directory, ".zcode", "commands");
    await mkdir(workspace);
    await mkdir(commands, { recursive: true });
    await ensureCliSettings(env);
    const settings = JSON.parse(await readFile(cliSettingsPath(env), "utf8"));
    settings.plugins.enabled = false;
    settings.memory = { use: false, write: false, autoConsolidate: false };
    settings.features = { compact: false, rewind: false, subagent: false, memory: false, skill: false, mcp: false };
    await writeFile(cliSettingsPath(env), JSON.stringify(settings));
    await writeProviderFixture(env, { apiKey: "fixture-key", modelId: "fixture", baseUrl: `${server.url.origin}/v1` });
    await writeFile(join(commands, "shell-fixture.md"), [
      "---", "description: Shell handoff regression", "---",
      "Inspect !`printf inline > inline-marker.txt`.",
      "```!", "printf fenced > fenced-marker.txt", "```",
      "Inspect !`cat ${ZCODE_SKILL_DIR}/unresolved.txt`.",
      "Arguments: $ARGUMENTS"
    ].join("\n"));
    const child = Bun.spawn([
      Bun.which("node")!, join(root, launcher ? "bin/zcode.js" : "vendor/zcode.cjs"),
      launcher ? "-p" : "--prompt", "/shell-fixture literal-argument",
      "--cwd", workspace, "--mode", "build", "--no-color"
    ], { cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ]);
      expect({ code, stderr }).toMatchObject({ code: 0 });
      expect(stdout).toContain("COMMAND_HANDOFF_COMPLETE");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("printf inline > inline-marker.txt");
      expect(prompts[0]).toContain("printf fenced > fenced-marker.txt");
      expect(prompts[0]).toContain("Bash tool");
      expect(prompts[0]).toContain("was not run");
      expect(prompts[0]).toContain("literal-argument");
      for (const marker of ["inline-marker.txt", "fenced-marker.txt"]) {
        await expect(stat(join(workspace, marker))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
