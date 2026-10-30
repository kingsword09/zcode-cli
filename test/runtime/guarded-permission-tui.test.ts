import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { cliSettingsPath, ensureCliSettings } from "../../src/model-access.ts";
import { writeProviderFixture } from "../fixtures/provider-config.ts";
import { runtimeStartupTimeoutMs, runtimeTestEnv } from "../fixtures/runtime-env.ts";
import { ScenarioWorkspace } from "../tui/harness/scenario-workspace.ts";
import { TerminalSession } from "../tui/harness/terminal-session.ts";

test.skipIf(process.platform === "win32")("native guarded commands require single-use approval before execution", async () => {
  await using workspace = await ScenarioWorkspace.create({
    prefix: "zcode-native-guarded-",
    files: { "scratch/keep.txt": "preserve until approved\n" }
  });
  const root = join(import.meta.dir, "../..");
  const env = runtimeTestEnv(workspace.home);
  await ensureCliSettings(env);
  const settings = JSON.parse(await readFile(cliSettingsPath(env), "utf8"));
  settings.plugins.enabled = false;
  settings.ui.locale = "en-US";
  settings.memory = { use: false, write: false, autoConsolidate: false };
  settings.features = { compact: false, rewind: false, subagent: false, memory: false, skill: false, mcp: false };
  await writeFile(cliSettingsPath(env), JSON.stringify(settings));
  let requestedCommands = 0;
  let completedCommands = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages: { role: string }[] };
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "Guarded permission test" }, finish_reason: "stop" }] });
    const finished = body.messages.at(-1)?.role === "tool";
    const delta = finished
      ? { role: "assistant", content: `GUARDED_COMPLETE_${++completedCommands}` }
      : { role: "assistant", tool_calls: [{
        index: 0,
        id: `guarded_${++requestedCommands}`,
        type: "function",
        function: { name: "Bash", arguments: JSON.stringify({ command: "rm -rf scratch", description: "Delete only the isolated scratch directory" }) }
      }] };
    const chunks = [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] }
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" }
    });
  } });
  try {
    const { path: providerPath } = await writeProviderFixture(env, {
      apiKey: "fixture-key", modelId: "fixture", baseUrl: `${server.url.origin}/v1`
    });
    const providerBefore = await readFile(providerPath, "utf8");
    await using session = TerminalSession.start({
      command: [Bun.which("node")!, join(root, "bin/zcode.js"), "--mode", "guarded"],
      workspace,
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      timeoutMilliseconds: 35_000
    });
    await session.waitForScreen("guarded CLI startup", /◉ guarded/u, runtimeStartupTimeoutMs);
    for (const decision of ["deny", "allow"] as const) {
      await session.sendAndWait(`Request the isolated deletion (${decision}).\r`, "native risk confirmation", /Dangerous command requires your approval/u);
      expect(await workspace.read("scratch/keep.txt")).toBe("preserve until approved\n");
      expect(session.screenText()).toContain("Allow once");
      expect(session.screenText()).toContain("Deny");
      await session.assertScreenExcludes("persistent approval", /Always allow|Deny and tell/u);
      const completed = completedCommands + 1;
      await session.sendAndWait(decision === "allow" ? "1" : "2", "tool result", new RegExp(`GUARDED_COMPLETE_${completed}`, "u"));
      if (decision === "deny") expect(await workspace.read("scratch/keep.txt")).toBe("preserve until approved\n");
      else await expect(stat(join(workspace.directory, "scratch"))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(requestedCommands).toBe(2);
    expect(JSON.parse(await readFile(cliSettingsPath(env), "utf8"))).toEqual(settings);
    expect(await readFile(providerPath, "utf8")).toBe(providerBefore);
    await session.exit();
  } finally {
    server.stop(true);
  }
}, 40_000);
