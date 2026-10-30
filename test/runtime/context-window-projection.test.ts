import { terminalOutputText as plainText } from "../../scripts/terminal-output.ts";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cliSettingsPath, ensureCliSettings } from "../../src/model-access.ts";
import { writeProviderFixture } from "../fixtures/provider-config.ts";
import { runtimeStartupTimeoutMs, runtimeTestEnv } from "../fixtures/runtime-env.ts";

const root = join(import.meta.dir, "../..");
const node = Bun.which("node")!;
const configuredContextWindow = 1_000_000;
const fixtureReply = "CONTEXT_WINDOW_REPLY";


/** A real runtime and session store; only the model HTTP endpoint is mocked. */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "zcode-context-window-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 });
    const body = await request.json() as { model: string; stream?: boolean };
    if (!body.stream) return Response.json({ id: "fixture", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: fixtureReply }, finish_reason: "stop" }] });
    const chunks = [{ role: "assistant", content: fixtureReply }, {}].map((delta, index) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model,
        choices: [{ index: 0, delta, finish_reason: index ? "stop": null }],
        ...index ? { usage: { prompt_tokens: 1_234, completion_tokens: 5, total_tokens: 1_239 } } : {} })}\n\n`
    );
    return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const env = runtimeTestEnv(home);
  await ensureCliSettings(env);
  const settings = JSON.parse(await readFile(cliSettingsPath(env), "utf8"));
  settings.plugins.enabled = false;
  settings.memory = { use: false, write: false, autoConsolidate: false };
  settings.features = { compact: false, rewind: false, subagent: false, memory: false, skill: false, mcp: false };
  settings.ui.locale = "en-US";
  await writeFile(cliSettingsPath(env), JSON.stringify(settings));
  await writeProviderFixture(env, {
    providerId: "probe", modelId: "probe-1m", models: ["probe-1m"], contextWindow: configuredContextWindow,
    apiKey: "fixture-key-not-real", baseUrl: `${server.url.origin}/v1`
  });
  return {
    home, env,
    close: async () => { server.stop(true); await rm(home, { recursive: true, force: true }); }
  };
}

/* #212: compaction and the request budget used the configured window while every
 * host-visible projection kept the 200000 default. */
test.skipIf(process.platform === "win32")(
  "headless runs project the configured context window",
  async () => {
    const f = await fixture();
    try {
      const child = Bun.spawn([node, join(root, "bin/zcode.js"), "--prompt", "Reply with the fixture text.", "--json"], {
        cwd: f.home, env: f.env, stdin: "ignore", stdout: "pipe", stderr: "pipe"
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
      ]);
      expect(code, stderr || stdout).toBe(0);
      const result = JSON.parse(stdout) as {
        response?: string;
        projection?: { contextUsed?: number; contextWindow?: number };
      };
      expect(result.response).toBe(fixtureReply);
      expect(result.projection?.contextUsed).toBeGreaterThan(0);
      expect(result.projection?.contextWindow).toBe(configuredContextWindow);
    } finally { await f.close(); }
  },
  30_000
);

test.skipIf(process.platform === "win32")(
  "the /context panel reports the configured context window",
  async () => {
    const f = await fixture();
    let output = "";
    const decoder = new TextDecoder();
    const terminal = new Bun.Terminal({ cols: 110, rows: 36, name: "xterm-256color",
      data(_terminal, data) { output += decoder.decode(data, { stream: true }); }
    });
    const child = Bun.spawn([node, join(root, "bin/zcode.js")], {
      cwd: f.home, terminal, env: { ...f.env, TERM: "xterm-256color", CI: "0", ZCODE_TUI_MODE: "regular", ZCODE_NODE: node }
    });
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 35_000);
    async function waitFor(pattern: RegExp, offset = 0, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && child.exitCode === null) {
        if (pattern.test(plainText(output.slice(offset)))) return;
        await Bun.sleep(20);
      }
      throw new Error(`Missing ${pattern}: ${plainText(output).slice(-2000)}`);
    }
    try {
      await waitFor(/◈ probe\/probe-1m/, 0, runtimeStartupTimeoutMs);
      const prompt = output.length;
      terminal.write("Reply with the fixture text.\r");
      await waitFor(new RegExp(fixtureReply), prompt);
      const panel = output.length;
      terminal.write("/context\r");
      // 1,000,000 tokens render as "1M"; the unfixed projection rendered "200K".
      await waitFor(/\/ 1M tokens/, panel);
      expect(plainText(output.slice(panel))).not.toContain("/ 200K tokens");
    } finally {
      clearTimeout(killTimer);
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      terminal.close();
      await f.close();
    }
  },
  40_000
);
