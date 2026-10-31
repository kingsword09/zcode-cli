import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";

import { createSessionModelFixture, type SessionModelCase } from "../fixtures/session-model-recovery.ts";
import { runtimeStartupTimeoutMs } from "../fixtures/runtime-env.ts";
import { TerminalScreen } from "../tui/harness/terminal-screen.ts";

const cases: Array<[SessionModelCase, "regular" | "fullscreen", "startup" | "command"]> = [["missing-model", "regular", "startup"]];

test.skipIf(process.platform === "win32").each(cases)(
  "resume repairs %s through the %s picker (%s)", async (kind, display, entry) => {
    await using fixture = await createSessionModelFixture(kind);
    const before = fixture.readSelection();
    const providers = await readFile(fixture.providerPath, "utf8");
    using screen = new TerminalScreen(100, 32);
    const terminal = new Bun.Terminal({ cols: 100, rows: 32, name: "xterm-256color",
      data(_terminal, data) { void screen.write(data); } });
    const start = (resume = false) => Bun.spawn([...fixture.command, ...resume ? ["--resume", fixture.sessionId] : []], {
      cwd: fixture.directory, env: { ...fixture.env, ZCODE_TUI_MODE: display }, terminal
    });
    let child = start(entry === "startup");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 35_000);
    const wait = async (predicate: (text: string) => boolean, timeoutMs = 8_000) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until && child.exitCode === null) {
        await screen.settled();
        if (predicate(screen.screenText())) return;
        await Bun.sleep(25);
      }
      throw new Error(`Session model recovery did not settle:\n${screen.screenText()}`);
    };
    try {
      if (entry === "command") {
        await wait(text => text.includes("◈ zai/glm-5.3-flash"));
        terminal.write(`/resume ${fixture.sessionId}\r`);
      }
      await wait(text => text.includes("Select a replacement model"), runtimeStartupTimeoutMs);
      expect(screen.screenText()).toContain("Saved model");
      expect(fixture.requests).toEqual([]);
      expect(fixture.readSelection()).toEqual(before);
      if (kind === "legacy-provider") {
        terminal.write("\x1b");
        await wait(text => !text.includes("Select a replacement model") && text.includes("/model"));
        terminal.write("Keep this unsent draft\r");
        await wait(text => text.includes("Choose a model with /model before continuing.") && text.includes("Keep this unsent draft"));
        expect(fixture.requests).toEqual([]);
        expect(fixture.readSelection()).toEqual(before);
        expect(screen.screenText()).toContain("Keep this unsent draft");
        terminal.write("\x03");
        terminal.write("/model\r");
        await wait(text => text.includes("Select a replacement model"));
      }
      terminal.write(kind === "missing-reasoning" ? "\r" : "\x1b[B\r");
      await wait(text => !text.includes("Select a replacement model") && /Session model now: zai\/glm-5\.3\s/.test(text));
      const saved = fixture.readSelection().modelSelection;
      expect(saved).toMatchObject({ providerId: "zai", modelId: "glm-5.3" });
      expect(saved.options.reasoningLevel).toBeString();
      terminal.write("Continue the preserved conversation.\r");
      await wait(text => fixture.requests.length === 1 && text.includes("SESSION_MODEL_REPLY"));
      expect(fixture.requests).toEqual(["glm-5.3"]);
      child.kill("SIGTERM");
      await child.exited;
      await screen.write("\x1b[2J\x1b[H");
      child = start(true);
      await wait(text => text.includes("◈ zai/glm-5.3") && text.includes("SESSION_MODEL_REPLY"));
      expect(screen.screenText()).not.toContain("Select a replacement model");
      expect(fixture.readSelection().modelSelection).toEqual(saved);
      terminal.write("Continue after restarting again.\r");
      await wait(text => fixture.requests.length === 2 && text.includes("SESSION_MODEL_REPLY"));
      expect(fixture.requests).toEqual(["glm-5.3", "glm-5.3"]);
      expect(await readFile(fixture.providerPath, "utf8")).toBe(providers);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      clearTimeout(deadline);
      terminal.close();
      await screen.settled();
    }
  }, 40_000
);

test.each(["missing-model"] as SessionModelCase[])(
  "headless resume explains the invalid saved model (%s)", async kind => {
    await using fixture = await createSessionModelFixture(kind);
    const before = fixture.readSelection();
    const child = Bun.spawn([...fixture.command, "--resume", fixture.sessionId, "--prompt", "Do not send this with an invalid model."], {
      cwd: fixture.directory, env: fixture.env, stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(1);
      expect(`${stdout}\n${stderr}`).toContain("Saved model");
      expect(`${stdout}\n${stderr}`).toContain("/model");
      expect(`${stdout}\n${stderr}`).not.toContain("Model creation failed");
      expect(fixture.requests).toEqual([]);
      expect(fixture.readSelection()).toEqual(before);
    } finally { clearTimeout(timeout); }
  }, 25_000
);

test("headless cold resume rejects an unavailable explicit model without falling back", async () => {
  await using fixture = await createSessionModelFixture("valid");
  const before = fixture.readSelection();
  const child = Bun.spawn([...fixture.command, "--resume", fixture.sessionId, "--model", "zai/unavailable", "--prompt", "Do not fall back."], {
    cwd: fixture.directory, env: fixture.env, stdin: "ignore", stdout: "pipe", stderr: "pipe"
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(`${stdout}\n${stderr}`).toContain("zai/unavailable");
    expect(fixture.requests).toEqual([]);
    expect(fixture.readSelection()).toEqual(before);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    clearTimeout(timeout);
  }
}, 30_000);
