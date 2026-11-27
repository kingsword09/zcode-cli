import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cliSettingsPath, ensureCliSettings } from "../../src/model-access.ts";
import { writeProviderFixture } from "../fixtures/provider-config.ts";
import { runtimeTestEnv } from "../fixtures/runtime-env.ts";
import { ScenarioWorkspace } from "../tui/harness/scenario-workspace.ts";
import { TerminalSession } from "../tui/harness/terminal-session.ts";

test.skipIf(process.platform === "win32")("a second CLI cannot duplicate a live child and can resume it after SIGKILL", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-agent-owner-" });
  const env = runtimeTestEnv(workspace.home);
  await ensureCliSettings(env);
  const settings = JSON.parse(await readFile(cliSettingsPath(env), "utf8"));
  settings.plugins.enabled = false;
  settings.ui.locale = "en-US";
  settings.memory = { use: false, write: false, autoConsolidate: false };
  await writeFile(cliSettingsPath(env), JSON.stringify(settings));
  const node = Bun.which("node")!;
  // The launcher and kernel are separate processes. Target only this test's kernel.
  const preload = join(workspace.root, "runtime-pid.cjs");
  await writeFile(preload, 'if (process.argv[1]?.endsWith("zcode.cjs")) require("node:fs").writeFileSync(process.env.RUNTIME_PID_FILE,String(process.pid))');
  let streams = 0;
  let closed = 0;
  let agentId: string;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages: { role: string; content: unknown }[] };
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "Agent fixture" }, finish_reason: "stop" }] });
    const hasPrompt = (marker: string) => body.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes(marker));
    if (hasPrompt("CHILD_306")) {
      streams++;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(": waiting\n\n")); },
        cancel() { closed++; }
      }), { headers: { "content-type": "text/event-stream" } });
    }
    const launch = hasPrompt("LAUNCH_306") && !body.messages.some(m => m.role === "tool");
    const attempt = body.messages.findLastIndex(m => m.role === "user" && JSON.stringify(m.content).includes("NATIVE_SEND_306"));
    const result = attempt >= 0 && body.messages.slice(attempt + 1).find(m => m.role === "tool");
    const send = attempt >= 0 && !result;
    const tool = send
      ? { name: "SendMessage", arguments: JSON.stringify({ to: agentId, message: "Continue", summary: "Continue" }) }
      : { name: "Agent", arguments: JSON.stringify({ subagent_type: "general-purpose",
        description: "Ownership fixture", prompt: "CHILD_306", run_in_background: true }) };
    const delta = launch || send ? { role: "assistant", tool_calls: [{ index: 0, id: send ? "call_send_306" : "call_launch_306",
      type: "function", function: tool }] }
      : result ? { role: "assistant", content: /not reachable|No agent named|still owned/i.test(JSON.stringify(result.content))
        ? "NATIVE_SEND_REFUSED" : "UNEXPECTED_SEND_RESULT " + JSON.stringify(result.content) }
      : { role: "assistant", content: "PARENT_READY" };
    const chunk = (delta: unknown, finish_reason: string | null) => "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
    return new Response(chunk(delta, null) + chunk({}, launch || send ? "tool_calls" : "stop") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } });
  const wait = async (predicate: () => boolean, session: TerminalSession) => {
    for (let i = 0; i < 500 && !predicate(); i++) await Bun.sleep(25);
    if (!predicate()) throw new Error(`Unexpected streams: opened=${streams} closed=${closed}\n${session.screenText()}`);
  };
  try {
    await writeProviderFixture(env, { apiKey: "fixture", baseUrl: `${server.url.origin}/v1` });
    const start = (name: string, args: string[]) => TerminalSession.start({ workspace,
      command: [node, join(import.meta.dir, "../../bin/zcode.js"), "--mode", "build", ...args],
      env: { ...env, ZCODE_NODE: node, NODE_OPTIONS: `--require="${preload}"`, RUNTIME_PID_FILE: join(workspace.root, name) },
      timeoutMilliseconds: 60_000 });
    await using owner = start("owner", []);
    await owner.waitForScreen("owner ready", /◉ build/u, 15_000);
    owner.send("LAUNCH_306\r");
    await wait(() => streams === 1, owner);
    const [file] = await Array.fromAsync(new Bun.Glob("**/agent_*/metadata.json").scan({
      cwd: workspace.home, dot: true, absolute: true
    }));
    const metadata = JSON.parse(await readFile(file, "utf8"));
    agentId = metadata.agentId;
    await owner.waitForHistory("persisted launch receipt", /PARENT_READY/u);
    await using observer = start("observer", ["--resume", metadata.parentSessionId]);
    await observer.waitForScreen("observer ready", /◉ build/u, 15_000);
    observer.send(`/tasks resume ${metadata.agentId}\r`);
    await observer.waitForHistory("live elsewhere", /running elsewhere/u);
    observer.send("NATIVE_SEND_306\r");
    await observer.waitForScreen("model SendMessage refused while the other runtime is live", /NATIVE_SEND_REFUSED/u);
    expect(streams).toBe(1);
    process.kill(Number(await readFile(join(workspace.root, "owner"), "utf8")), "SIGKILL");
    await wait(() => closed === 1, observer);
    observer.send(`/tasks resume ${metadata.agentId}\r`);
    await wait(() => streams === 2, observer);
    observer.send(`/tasks stop ${metadata.agentId}\r`);
    await wait(() => closed === 2, observer);
    expect(streams).toBe(2);
  } finally {
    server.stop(true);
  }
}, 80_000);
