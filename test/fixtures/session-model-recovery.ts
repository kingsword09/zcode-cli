import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { cliSettingsPath, ensureCliSettings } from "../../src/model-access.ts";
import { writeProviderFixture } from "./provider-config.ts";

export const sessionModelCases = {
  "legacy-provider": {
    modelId: "GLM-5.3", providerId: "builtin:zai-coding-plan", thoughtLevel: "high",
    modelSelection: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" }
  },
  "model-casing": { modelSelection: { providerId: "zai", modelId: "GLM-5.3", options: { reasoningLevel: "high" } } },
  "missing-model": { modelSelection: { providerId: "zai", modelId: "glm-5.1", options: { reasoningLevel: "high" } } },
  "missing-reasoning": { modelSelection: { providerId: "zai", modelId: "glm-5.3" } },
  "valid": { modelSelection: { providerId: "zai", modelId: "glm-5.3", options: { reasoningLevel: "high" } } }
} as const;
export type SessionModelCase = keyof typeof sessionModelCases;

/** A real persisted session and runtime, with only the model HTTP endpoint mocked. */
export async function createSessionModelFixture(kind: SessionModelCase = "legacy-provider") {
  const directory = await mkdtemp(join(tmpdir(), "zcode-session-model-"));
  const root = resolve(import.meta.dir, "../..");
  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is required to reproduce session model recovery.");
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 });
    const body = await request.json() as { model: string; stream?: boolean };
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "Model recovery fixture" }, finish_reason: "stop" }] });
    requests.push(body.model);
    const chunks = [{ role: "assistant", content: "SESSION_MODEL_REPLY" }, {}].map((delta, index) =>
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model,
        choices: [{ index: 0, delta, finish_reason: index ? "stop" : null }] })}\n\n`
    );
    return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, ZCODE_DATA_BASE_DIR: directory,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(directory, "providers.json"),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(root, "vendor/provider/zcode-builtin.json"),
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "", ZCODE_DISABLE_UPDATE_CHECK: "1",
    ZCODE_TUI_MODE: "regular", ZCODE_NODE: node, TERM: "xterm-256color", CI: "0" };
  const dispose = async () => { server.stop(true); await rm(directory, { recursive: true, force: true }); };
  try {
    await ensureCliSettings(env);
    const settings = JSON.parse(await readFile(cliSettingsPath(env), "utf8"));
    settings.plugins.enabled = false;
    settings.memory = { use: false, write: false, autoConsolidate: false };
    settings.features = { compact: false, rewind: false, subagent: false, memory: false, skill: false, mcp: false };
    settings.ui.locale = "en-US";
    await writeFile(cliSettingsPath(env), JSON.stringify(settings));
    const { path: providerPath } = await writeProviderFixture(env, {
      providerId: "zai", modelId: "glm-5.3-flash", models: ["glm-5.3-flash", "glm-5.3"],
      apiKey: "fixture-key-not-real", baseUrl: `${server.url.origin}/v1`
    });
    const command = [node, join(root, "bin/zcode.js")];
    const seed = Bun.spawn([...command, "--prompt", "Reply to seed a session for issue 160.", "--mode", "build"], {
      cwd: directory, env, stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const timeout = setTimeout(() => seed.kill("SIGKILL"), 15_000);
    const [code, stdout, stderr] = await Promise.all([seed.exited, new Response(seed.stdout).text(), new Response(seed.stderr).text()]);
    clearTimeout(timeout);
    if (code !== 0 || !stdout.includes("SESSION_MODEL_REPLY")) throw new Error(`Unable to seed fixture (${code}): ${stderr}\n${stdout}`);
    const dbPath = join(directory, ".zcode/cli/db/db.sqlite");
    const db = new Database(dbPath);
    let sessionId: string;
    try {
      const row = db.query("SELECT session_id FROM session_entry WHERE type = 'runtime/model_selection' ORDER BY time_updated DESC LIMIT 1").get() as { session_id: string } | null;
      if (!row) throw new Error("The seeded session has no model selection entry.");
      sessionId = row.session_id;
      db.query("UPDATE session_entry SET data = ? WHERE session_id = ? AND type = 'runtime/model_selection'")
        .run(JSON.stringify(sessionModelCases[kind]), sessionId);
    } finally { db.close(); }
    requests.length = 0;
    return {
      directory, env, command, sessionId, dbPath, providerPath, requests,
      readSelection() {
        // Node removes WAL sidecars on close; allow SQLite to recreate them for this fixture query.
        const connection = new Database(dbPath);
        try {
          return JSON.parse((connection.query("SELECT data FROM session_entry WHERE session_id = ? AND type = 'runtime/model_selection'")
            .get(sessionId) as { data: string }).data);
        } finally { connection.close(); }
      },
      dispose,
      [Symbol.asyncDispose]: dispose
    };
  } catch (error) { await dispose(); throw error; }
}
