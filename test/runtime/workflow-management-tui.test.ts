import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cliSettingsPath, ensureCliSettings } from "../../src/model-access.ts";
import { writeProviderFixture } from "../fixtures/provider-config.ts";
import { runtimeStartupTimeoutMs, runtimeTestEnv } from "../fixtures/runtime-env.ts";
import { ScenarioWorkspace } from "../tui/harness/scenario-workspace.ts";
import { TerminalSession } from "../tui/harness/terminal-session.ts";

test.skipIf(process.platform === "win32")("native workflow settings, live retuning and saved restart share the TUI session", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-workflow-management-" });
  const root = join(import.meta.dir, "../..");
  const env = { ...runtimeTestEnv(workspace.home), ZCODE_SESSION_DB_PATH: join(workspace.home, "workflow.sqlite") };
  await ensureCliSettings(env);
  const settings = JSON.parse(await readFile(cliSettingsPath(env), "utf8"));
  settings.plugins.enabled = false;
  settings.ui.locale = "en-US";
  settings.memory = { use: false, write: false, autoConsolidate: false };
  settings.features = { compact: false, rewind: false, subagent: true, memory: false, skill: true, mcp: false };
  await writeFile(cliSettingsPath(env), JSON.stringify(settings));
  const script = 'const reviewer = agent("Reviewer", { model: "custom/worker" });\nconst result = await reviewer.ask<{ ok: boolean }>("check");\nreturn result.ok;';
  let releaseWorker!: () => void;
  const workerGate = new Promise<void>(resolve => { releaseWorker = resolve; });
  let markWorkerRequested!: () => void;
  const workerRequested = new Promise<void>(resolve => { markWorkerRequested = resolve; });
  const requestedModels: string[] = [];
  let toolCount = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; model?: string; messages: { role: string; tool_call_id?: string }[] };
    const worker = body.model?.includes("worker") === true;
    requestedModels.push(body.model ?? "");
    if (worker) { markWorkerRequested(); await workerGate; }
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: worker ? '{"ok":true}' : "READY" }, finish_reason: "stop" }] });
    const last = body.messages.at(-1);
    const loadedSkill = last?.tool_call_id?.startsWith("skill_") === true;
    const finished = worker || (last?.role === "tool" && !loadedSkill);
    const delta = finished ? { role: "assistant", content: worker ? '{"ok":true}' : "WORKFLOW_REQUEST_COMPLETE" } : {
      role: "assistant", tool_calls: [{ index: 0, id: `${loadedSkill ? "workflow" : "skill"}_${++toolCount}`, type: "function",
        function: loadedSkill
          ? { name: "CreateWorkflow", arguments: JSON.stringify({ name: "Native workflow test", script, max_concurrency: 4 }) }
          : { name: "Skill", arguments: JSON.stringify({ skill: "dynamic-workflows" }) } }]
    };
    return new Response([
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: finished ? "stop" : "tool_calls" }] }
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const { path: providerPath } = await writeProviderFixture(env, { apiKey: "fixture-key", modelId: "fixture", models: ["fixture", "alternate", "worker"], baseUrl: `${server.url.origin}/v1` });
    const providerBefore = await readFile(providerPath, "utf8");
    await using session = TerminalSession.start({ command: [Bun.which("node")!, join(root, "bin/zcode.js"), "--workflow-mode", "alwaysOn"], workspace, cols: 110, rows: 40,
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), timeoutMilliseconds: 60_000 });
    await session.waitForScreen("startup", /custom\/fixture/u, runtimeStartupTimeoutMs);
    await session.sendAndWait("Create the isolated workflow.\r", "workflow approval", /Approve CreateWorkflow/u);
    await session.sendAndWait("concurrency\r", "concurrency input", /Workflow concurrency/u);
    await session.sendAndWait("2\r", "adjusted approval", /Concurrency: 2/u);
    await session.sendAndWait("2", "denied workflow", /WORKFLOW_REQUEST_COMPLETE/u);
    const database = new Database(env.ZCODE_SESSION_DB_PATH, { readonly: true });
    try {
      const runs = () => database.query("select id, caps_max_concurrency, status from dwf_run order by time_created").all() as { id: string; caps_max_concurrency: number; status: string }[];
      expect(runs()).toHaveLength(0);
      await session.sendAndWait("Create the isolated workflow again.\r", "second approval", /Approve CreateWorkflow/u);
      await session.sendAndWait("concurrency\r", "second concurrency input", /Workflow concurrency/u);
      await session.sendAndWait("2\r", "second adjusted approval", /Concurrency: 2/u);
      await session.sendAndWait("model\r", "model picker", /Workflow default model/u);
      await session.sendAndWait("alternate\r", "selected default", /Subagent default model: custom\/alternate/u);
      await session.sendAndWait("1", "workflow created", /WORKFLOW_REQUEST_COMPLETE/u);
      expect(runs()).toHaveLength(1);
      const runId = runs()[0]!.id;
      expect(runs()[0]!.caps_max_concurrency).toBe(2);
      await session.sendAndWait("/workflows\r", "run list", /Workflow runs/u);
      await session.sendAndWait("Native workflow\r", "run actions", /Workflow actions/u);
      await session.waitForHistory("default model details", /custom\/alternate/u);
      await session.sendAndWait("concurrency\r", "live concurrency input", /Workflow concurrency/u);
      await session.sendAndWait("3\r", "live retune confirmation", /Apply concurrency/u);
      await session.sendAndWait("\r", "live retune result", /Workflow concurrency updated/u);
      expect(runs()).toHaveLength(1);
      expect(runs()[0]).toMatchObject({ id: runId, caps_max_concurrency: 3, status: "running" });
      await session.sendAndWait("/workflows\r", "save run list", /Workflow runs/u);
      await session.sendAndWait("Native workflow\r", "save actions", /Workflow actions/u);
      await session.sendAndWait("save\r", "save name", /Name: up to 64/u);
      await session.sendAndWait("review\r", "save scope", /Save workflow scope/u);
      await session.sendAndWait("\r", "save description", /Workflow description/u);
      await session.sendAndWait("\r", "saved result", /Workflow saved/u);
      expect(await workspace.read(".zcode/workflows/review.dwf.ts")).toContain(script);
      await workerRequested;
      await session.waitForHistory("explicit agent model", /custom\/worker/u);
      expect(requestedModels).toContain("worker");
      expect(runs()[0]).toMatchObject({ id: runId, status: "running" });
      await session.sendAndWait("/workflows saved\r", "saved definitions", /Saved workflows/u);
      await session.sendAndWait("review\r", "saved start confirmation", /Run saved workflow/u);
      await session.sendAndWait("run\r", "new saved run", /Saved workflow started/u);
      expect(runs()).toHaveLength(2);
      expect(runs()[1]!.id).not.toBe(runId);
      expect(runs()[0]).toMatchObject({ id: runId, status: "running" });
      expect(runs()[1]!.status).toBe("running");
      releaseWorker();
      expect(await readFile(providerPath, "utf8")).toBe(providerBefore);
      expect(JSON.parse(await readFile(cliSettingsPath(env), "utf8"))).toEqual(settings);
      await session.exit();
    } finally { database.close(); }
  } finally { releaseWorker(); server.stop(true); }
}, 70_000);
