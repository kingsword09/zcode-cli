import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliSettingsPath, ensureCliSettings } from "../../src/model-access.ts";
import { requestAppServer } from "../../src/app-server-client.ts";
import { writeProviderFixture } from "../fixtures/provider-config.ts";
import { TerminalScreen } from "../tui/harness/terminal-screen.ts";

test.skipIf(process.platform === "win32").each(["regular", "fullscreen"])("Plan and permissions remain independent in %s TUI and after resume", async (display) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-execution-state-"));
  const node = Bun.which("node")!;
  const root = join(import.meta.dir, "../..");
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: home,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(home, "providers.json"),
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(root, "vendor/provider/zcode-builtin.json"),
    ZCODE_DISABLE_UPDATE_CHECK: "1", ZCODE_TUI_MODE: display, ZCODE_NODE: node, TERM: "xterm-256color", CI: "0" };
  await ensureCliSettings(env);
  const settings = JSON.parse(await readFile(cliSettingsPath(env), "utf8"));
  settings.plugins.enabled = false;
  settings.ui.locale = "en-US";
  settings.memory = { use: false, write: false };
  await writeFile(cliSettingsPath(env), JSON.stringify(settings));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean };
    if (!body.stream) return Response.json({ choices: [{ message: { role: "assistant", content: "READY" }, finish_reason: "stop" }] });
    return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"READY"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } });
  } });
  const { path: providerPath } = await writeProviderFixture(env, { apiKey: "fixture-key", modelId: "fixture", baseUrl: `${server.url.origin}/v1` });
  const providerBefore = await readFile(providerPath, "utf8");
  using screen = new TerminalScreen(80, 30);
  let output = "";
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({ cols: 80, rows: 30, name: "xterm-256color", data(_terminal, data) {
    output += decoder.decode(data, { stream: true });
    void screen.write(data);
  } });
  const start = (args: string[] = []) => Bun.spawn([node, join(root, "bin/zcode.js"), ...args], { cwd: home, terminal, env });
  let child = start();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 40_000);
  const wait = async (predicate: (text: string) => boolean) => {
    const until = Date.now() + 7_000;
    while (Date.now() < until && child.exitCode === null) {
      await screen.settled();
      if (predicate(screen.screenText())) return;
      await Bun.sleep(25);
    }
    throw new Error(`Execution state did not settle:\n${screen.screenText()}\n${output.slice(-2000)}`);
  };
  const state = (mode: string, plan: boolean) => (text: string) => {
    const lines = text.split("\n");
    // Use the live editor border, not an earlier command/notice in scrollback.
    const status = lines.findLastIndex(line => line.includes("◈ custom/fixture") && line.includes(`◉ ${mode}`));
    return status >= 3 && /─/.test(lines[status - 1]!)
      && / Plan ──$/.test(lines[status - 3]!.trimEnd()) === plan;
  };
  try {
    await wait(state("build", false));
    terminal.write("Prepare a session for the execution-state test.\r");
    await wait(text => text.includes("READY") && state("build", false)(text));
    await Bun.sleep(150);
    terminal.write("/plan\r");
    await wait(state("build", true));
    expect(screen.screenText()).toContain("Research and plan before making changes");
    terminal.write("/mode\r");
    await wait(text => text.includes("Select mode"));
    const picker = screen.screenText().split("Select mode").at(-1)!;
    expect(picker).toContain("Build");
    expect(picker).toContain("Edit");
    expect(picker).toContain("Yolo");
    expect(picker).not.toMatch(/\bAuto\b/);
    terminal.write("\x1b");
    await wait(state("build", true));
    terminal.write("\x1b[Z");
    await wait(state("edit", true));
    terminal.write("\x1b[Z");
    await wait(state("yolo", true));
    terminal.write("\x1b[Z");
    await wait(state("build", true));
    terminal.write("/mode edit\r");
    await wait(state("edit", true));
    terminal.write("/plan\r");
    await wait(state("edit", false));
    terminal.write("/plan\r");
    await wait(state("edit", true));
    const sessions = await requestAppServer({ method: "session/list", params: {}, transport: {
      command: node, args: [join(root, "vendor/zcode.cjs"), "app-server"], cwd: home, env
    } }) as { sessions: { sessionId: string }[] };
    const sessionId = sessions.sessions[0]?.sessionId;
    expect(sessionId).toBeString();
    terminal.write("/new\r");
    await wait(state("edit", false));
    terminal.write("/mode yolo\r");
    await wait(state("yolo", false));
    terminal.write(`/resume ${sessionId}\r`);
    await wait(state("edit", true));
    child.kill("SIGTERM");
    await child.exited;
    await screen.write("\x1b[2J\x1b[H");
    child = start(["--resume", sessionId!]);
    await wait(state("edit", true));
    terminal.resize(40, 30);
    screen.resize(40, 30);
    await wait(text => / Plan ──\s*\n/.test(text));
    terminal.write("测试输入");
    await wait(text => text.includes("测试输入") && !text.includes("Research and plan before making changes"));
    expect(await readFile(providerPath, "utf8")).toBe(providerBefore);
    expect(JSON.parse(await readFile(cliSettingsPath(env), "utf8"))).toEqual(settings);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    clearTimeout(deadline);
    terminal.close();
    server.stop(true);
    await screen.settled();
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
