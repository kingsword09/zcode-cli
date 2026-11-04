import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureCliSettings } from "../../src/model-access.ts";
import { writeProviderFixture } from "../fixtures/provider-config.ts";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";

const root = resolve(import.meta.dir, "../..");

async function runFixture(options: {
  apiType?: string; effort?: string; args?: string[]; fail?: boolean; noSavedProvider?: boolean;
  savedSelection?: boolean;
} = {}) {
  const home = await mkdtemp(join(tmpdir(), "zcode-environment-runtime-"));
  const requests: { path: string; authorization: string | null; apiKey: string | null; body: Record<string, unknown> }[] = [];
  const apiType = options.apiType ?? "openai-chat-completions";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), apiKey: request.headers.get("x-api-key"), body });
    if (options.fail) return Response.json({ error: { message: "ENV_PROVIDER_REJECTED" } }, { status: 401 });
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "ENV_REPLY" }, finish_reason: "stop" }] });
    if (apiType === "openai-responses") {
      const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "ENV_REPLY", annotations: [] }] };
      const response = { id: "resp_fixture", object: "response", created_at: 1, model: body.model,
        status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "ENV_REPLY" },
        { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "ENV_REPLY" },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response }
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (apiType === "anthropic-messages") {
      const events = [
        { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ENV_REPLY" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" }
      ];
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    const chunks = [{ role: "assistant", content: "ENV_REPLY" }, {}].map((delta, index) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model,
        choices: [{ index: 0, delta, finish_reason: index ? "stop" : null }] })}\n\n`).join("");
    return new Response(`${chunks}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const env = runtimeTestEnv(home);
    const saved = options.noSavedProvider ? undefined : await writeProviderFixture(env, {
      providerId: "saved", modelId: "saved-model", models: ["saved-model", "environment-selected-model"], apiKey: "saved-key",
      baseUrl: options.savedSelection ? `http://127.0.0.1:${server.port}/v1` : "http://127.0.0.1:1/v1"
    });
    const original = saved && await readFile(saved.path, "utf8");
    const bootstrap = await ensureCliSettings(env);
    const settings = JSON.parse(await readFile(bootstrap.configPath, "utf8"));
    settings.storage = { dir: join(home, ".zcode"), sessionDbPath: join(home, "sessions.sqlite") };
    settings.memory = { use: false, write: false, autoConsolidate: false };
    settings.features = { compact: false, rewind: false, subagent: false, skill: false, mcp: false };
    settings.plugins = { enabled: false, dirs: [], enabledPlugins: {}, options: {}, suppressedBuiltins: [] };
    await writeFile(bootstrap.configPath, JSON.stringify(settings));
    if (!options.savedSelection) await writeFile(join(dirname(bootstrap.configPath), "config.json"), JSON.stringify({
      provider: { legacy: { options: { apiKey: "legacy-key", baseURL: "http://127.0.0.1:1/v1" } } }
    }));
    const child = Bun.spawn([Bun.which("node")!, "bin/zcode.js", "-p", "Reply with ENV_REPLY.", "--cwd", home,
      "--mode", "build", "--output-format", "stream-json", ...(options.args ?? [])], {
      cwd: root, env: {
        ...env, TMPDIR: home, TMP: home, TEMP: home,
        ZCODE_MODEL_BASE_URL: options.savedSelection ? undefined : `http://127.0.0.1:${server.port}/v1`,
        ZCODE_API_KEY: options.savedSelection ? undefined : "environment-key",
        ZCODE_API_TYPE: options.savedSelection ? undefined : apiType,
        ZCODE_MODEL: options.savedSelection ? "saved/environment-selected-model" : "organization/custom-model",
        ZCODE_EFFORT: options.effort,
        ZCODE_MODEL_RETRY_MAX_RETRIES: "0"
      }, stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    let code: number, stdout: string, stderr: string;
    try { [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
    finally { clearTimeout(timeout); }
    if (saved) expect(await readFile(saved.path, "utf8")).toBe(original!);
    else expect(await Bun.file(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE!).exists()).toBe(false);
    expect((await readdir(home)).filter(name => name.startsWith("zcode-prompt-provider-"))).toEqual([]);
    expect(stdout).not.toContain("environment-key");
    expect(stderr).not.toContain("environment-key");
    return { code, stdout, stderr, requests };
  } finally {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}

test("headless environment credentials run without a saved provider or browser login", async () => {
  const result = await runFixture({ noSavedProvider: true, effort: "high" });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('"type":"result"');
  expect(result.stdout).toContain("ENV_REPLY");
  expect(result.requests.some(request => request.body.stream)).toBe(true);
  for (const request of result.requests.filter(request => request.body.stream)) {
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.authorization).toBe("Bearer environment-key");
    expect(request.body.model).toBe("organization/custom-model");
    expect(request.body.reasoning_effort).toBe("high");
    expect(request.body.thinking).toBeUndefined();
  }
}, 30_000);

test("explicit raw model and effort override environment without changing saved providers", async () => {
  const result = await runFixture({ effort: "high", args: ["--model", "different/model", "--effort", "low"] });
  expect(result.code, result.stderr).toBe(0);
  const request = result.requests.find(request => request.body.stream)!;
  expect(request.body.model).toBe("different/model");
  expect(request.body.reasoning_effort).toBe("low");
}, 30_000);

test.each([undefined, "auto"])("omits reasoning parameters with effort %s", async effort => {
  const result = await runFixture({ effort });
  expect(result.code, result.stderr).toBe(0);
  const request = result.requests.find(request => request.body.stream)!;
  expect(request.body.reasoning_effort).toBeUndefined();
  expect(request.body.reasoning).toBeUndefined();
  expect(request.body.thinking).toBeUndefined();
}, 30_000);

test("Anthropic-compatible environment credentials and effort reach the custom endpoint", async () => {
  const result = await runFixture({ apiType: "anthropic-messages", effort: "high" });
  expect(result.code, result.stderr).toBe(0);
  const request = result.requests.find(request => request.body.stream)!;
  expect(request.path).toBe("/v1/messages");
  expect(request.apiKey).toBe("environment-key");
  expect(request.body.model).toBe("organization/custom-model");
  expect(request.body.thinking).toEqual({ type: "adaptive" });
  expect(request.body.output_config).toEqual({ effort: "high" });
}, 30_000);

test("Responses-compatible environment credentials and effort reach the custom endpoint", async () => {
  const result = await runFixture({ apiType: "openai-responses", effort: "high" });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("ENV_REPLY");
  const request = result.requests.find(request => request.body.stream)!;
  expect(request.path).toBe("/v1/responses");
  expect(request.authorization).toBe("Bearer environment-key");
  expect(request.body.model).toBe("organization/custom-model");
  expect(request.body.reasoning).toEqual({ effort: "high" });
  expect(request.body.reasoning_effort).toBeUndefined();
}, 30_000);

test("provider rejection fails without falling back and cleans up temporary credentials", async () => {
  const result = await runFixture({ fail: true });
  expect(result.code).not.toBe(0);
  expect(result.requests.length).toBeGreaterThan(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain("ENV_PROVIDER_REJECTED");
}, 30_000);

test("environment model selects a saved provider when no custom endpoint is configured", async () => {
  const result = await runFixture({ savedSelection: true });
  expect(result.code, result.stderr).toBe(0);
  const request = result.requests.find(request => request.body.stream)!;
  expect(request.body.model).toBe("environment-selected-model");
  expect(request.authorization).toBe("Bearer saved-key");
}, 30_000);

test.skipIf(process.platform === "win32")("handled cancellation removes temporary provider credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-environment-cancel-"));
  const fakeNode = join(home, "fake-node");
  await writeFile(fakeNode, [
    `#!${Bun.which("node")!}`,
    "process.on('SIGTERM', () => process.exit(143));",
    "setInterval(() => {}, 1000);",
    "process.stdout.write(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE + '\\n');",
    ""
  ].join("\n"));
  await chmod(fakeNode, 0o755);
  const child = Bun.spawn([Bun.which("node")!, "bin/zcode.js", "-p", "Wait for cancellation.", "--cwd", home], {
    cwd: root, env: {
      ...runtimeTestEnv(home), ZCODE_NODE: fakeNode, TMPDIR: home,
      ZCODE_MODEL_BASE_URL: "https://example.test/v1", ZCODE_API_KEY: "cancellation-secret", ZCODE_MODEL: "model"
    }, stdin: "ignore", stdout: "pipe", stderr: "pipe"
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    const path = new TextDecoder().decode(first.value).trim();
    expect(path).toContain("zcode-prompt-provider-");
    expect(await Bun.file(path).exists()).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await Bun.file(path).exists()).toBe(false);
    reader.releaseLock();
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await child.exited;
    await rm(home, { recursive: true, force: true });
  }
}, 15_000);

test("incomplete custom environment fails before creating settings or launching the runtime", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-environment-invalid-"));
  try {
    const child = Bun.spawn([Bun.which("node")!, "bin/zcode.js", "-p", "Must not run."], {
      cwd: root, env: {
        ...runtimeTestEnv(home), ZCODE_NODE: join(home, "nonexistent-node"),
        ZCODE_API_KEY: "incomplete-secret", ZCODE_MODEL: "raw-model"
      }, stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Custom model access requires");
    expect(stderr).not.toContain("incomplete-secret");
    expect(stderr).not.toContain("ENOENT");
    expect(await readdir(home)).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
