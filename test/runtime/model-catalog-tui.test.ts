import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureCliSettings, cliSettingsPath } from "../../src/model-access.ts";
import { writeProviderFixture } from "../fixtures/provider-config.ts";
import { requestAppServer } from "../../src/app-server-client.ts";

function plainText(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

test.skipIf(process.platform === "win32").each([false, true])("registry TUI starts and reloads personal models (first install: %p)", async (firstInstall) => {
  const node = Bun.which("node")!;
  const home = await mkdtemp(join(tmpdir(), "zcode-registry-tui-"));
  const env = { HOME: home, USERPROFILE: home };
  await ensureCliSettings(env);
  const config = JSON.parse(await readFile(cliSettingsPath(env), "utf8"));
  const requestedModels: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("", { status: 404 });
    const body = await request.json() as { model: string; stream?: boolean };
    if (!body.stream) return Response.json({ id: "fixture", object: "chat.completion", model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: "REGISTRY_REPLY" }, finish_reason: "stop" }] });
    requestedModels.push(body.model);
    const chunks = [{ role: "assistant", content: "REGISTRY_REPLY" }, {}].map((delta, index) => (
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model,
        choices: [{ index: 0, delta, finish_reason: index ? "stop" : null }] })}\n\n`
    ));
    return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  config.ui.locale = "en-US";
  config.plugins.enabled = false;
  config.memory.use = false;
  config.memory.write = false;
  await writeFile(cliSettingsPath(env), JSON.stringify(config));
  if (firstInstall) await rm(join(home, ".zcode", "cli"), { recursive: true });
  const personalPath = join(home, "provider_config.json");
  const nativeEnv = { ...env, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath };
  if (!firstInstall) await writeProviderFixture(nativeEnv, {
    providerId: "zai", modelId: "glm-5.3", models: ["glm-5.3", "glm-5.3-flash"],
    apiKey: "fixture-key-not-real", baseUrl: `${server.url.origin}/v1`
  });
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 110, rows: 36, name: "xterm-256color",
    data(_terminal, data) { output += decoder.decode(data, { stream: true }); }
  });
  const runtimeEnv = { ...process.env, ...env, TERM: "xterm-256color", CI: "0", ZCODE_DATA_BASE_DIR: home,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(import.meta.dir, "..", "..", "vendor", "provider", "zcode-builtin.json"),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
      ZCODE_DISABLE_MODEL_CATALOG_REFRESH: "1", ZCODE_DISABLE_UPDATE_CHECK: "1",
      ZCODE_TUI_MODE: "regular", ZCODE_NODE: node };
  const start = (args: string[] = []) => Bun.spawn([node, join(import.meta.dir, "../../bin/zcode.js"), ...args], {
    cwd: home, terminal, env: runtimeEnv
  });
  let child = start();
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 35_000);
  async function waitFor(pattern: RegExp, offset = 0) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && child.exitCode === null) {
      if (pattern.test(plainText(output.slice(offset)))) return;
      await Bun.sleep(20);
    }
    throw new Error(`Missing ${pattern}: ${plainText(output).slice(-4000)}`);
  }
  try {
    if (firstInstall) {
      await waitFor(/Welcome to ZCode CLI/);
      const initial = JSON.parse(await readFile(cliSettingsPath(env), "utf8"));
      expect(initial.provider).toBeUndefined();
      return;
    }
    await waitFor(/zai\/glm-5\.3/);
    const firstPicker = output.length;
    terminal.write("/model\r");
    await waitFor(/Select model/, firstPicker);
    expect(plainText(output.slice(firstPicker))).toContain("zai/glm-5.3");
    terminal.write("\x1b");
    await Bun.sleep(50);
    const personal = JSON.parse(await readFile(personalPath, "utf8"));
    const rules = personal.config.providerConfigRules.providerRules;
    const provider = rules.find((entry: { providerId: string }) => entry.providerId === "zai");
    provider.config.personalModelIds.push("catalog-fixture");
    await writeFile(personalPath, JSON.stringify(personal));
    const secondPicker = output.length;
    terminal.write("/model\r");
    await waitFor(/zai\/catalog-fixture/, secondPicker);
    terminal.write("\x1b");
    await Bun.sleep(50);
    const switched = output.length;
    terminal.write("/model zai/catalog-fixture\r");
    await waitFor(/Session model now: zai\/catalog-fixture/, switched);
    expect(JSON.parse(await readFile(cliSettingsPath(env), "utf8"))).toEqual(config);
    expect(JSON.parse(await readFile(personalPath, "utf8")).config.defaultModelSelection)
      .toEqual(personal.config.defaultModelSelection);
    const sent = output.length;
    terminal.write("Reply with the fixture response.\r");
    await waitFor(/REGISTRY_REPLY/, sent);
    expect(requestedModels).toContain("catalog-fixture");
    await Bun.sleep(100);
    const sessions = await requestAppServer({ method: "session/list", params: {}, transport: {
      command: node, args: [join(import.meta.dir, "../../vendor/zcode.cjs"), "app-server"], cwd: home, env: runtimeEnv
    } }) as { sessions: Array<{ sessionId: string }> };
    const sessionId = sessions.sessions[0]?.sessionId;
    expect(typeof sessionId, JSON.stringify(sessions)).toBe("string");
    let offset = output.length;
    terminal.write("/model zai/glm-5.3\r");
    await waitFor(/Session model now: zai\/glm-5\.3/, offset);
    offset = output.length;
    terminal.write("/model zai/catalog-fixture\r");
    await waitFor(/Session model now: zai\/catalog-fixture/, offset);
    offset = output.length;
    terminal.write("/new\r");
    await waitFor(/◈ zai\/glm-5\.3/, offset);
    offset = output.length;
    terminal.write(`/resume ${sessionId}\r`);
    await waitFor(/◈ zai\/catalog-fixture/, offset);
    offset = output.length;
    terminal.write("/effort disabled\r");
    await waitFor(/⚡ disabled/, offset);
    child.kill("SIGTERM");
    await child.exited;
    offset = output.length;
    child = start(["--resume", sessionId!]);
    await waitFor(/◈ zai\/catalog-fixture[\s\S]*⚡ disabled/, offset);
    offset = output.length;
    terminal.write("Reply after resuming.\r");
    await waitFor(/REGISTRY_REPLY/, offset);
    expect(requestedModels.at(-1)).toBe("catalog-fixture");
    await Bun.sleep(100);
    const settings = output.length;
    terminal.write("/settings\r");
    await waitFor(/ZCode settings/, settings);
    terminal.write("\r");
    await waitFor(/Default model/, settings);
    terminal.write("zai/glm-5.3-flash\r");
    await waitFor(/Default model saved: zai\/glm-5\.3-flash/, settings);
    expect(JSON.parse(await readFile(personalPath, "utf8")).config.defaultModelSelection)
      .toEqual({ providerId: "zai", modelId: "glm-5.3-flash" });
    expect(JSON.parse(await readFile(cliSettingsPath(env), "utf8"))).toEqual(config);
    child.kill("SIGTERM");
    await child.exited;
    offset = output.length;
    child = start(["--resume", sessionId!]);
    await waitFor(/◈ zai\/glm-5\.3-flash/, offset);
    offset = output.length;
    terminal.write("/new\r");
    await waitFor(/◈ zai\/glm-5\.3-flash/, offset);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    clearTimeout(killTimer);
    terminal.close();
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
