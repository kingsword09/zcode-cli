import { expect, test } from "bun:test";
import { join } from "node:path";

import { runtimeTestEnv } from "../../scripts/runtime-test-env.ts";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";

const fixture = join(import.meta.dir, "fixtures/terminal-exit.ts");
const ctrlCRelease = "\x1b[99;5:3u";
const cases: {
  name: string;
  mode: "regular" | "fullscreen";
  input?: string;
  release: string;
  status: number;
  startup?: boolean;
  signal?: NodeJS.Signals;
}[] = [
  { name: "Ctrl+C in regular mode", mode: "regular", input: "\x1b[99;5u", release: ctrlCRelease, status: 0 },
  { name: "Ctrl+C in fullscreen mode", mode: "fullscreen", input: "\x1b[99;5u", release: ctrlCRelease, status: 0 },
  { name: "Ctrl+D", mode: "regular", input: "\x1b[100;5u", release: "\x1b[100;5:3u", status: 0 },
  { name: "/exit", mode: "regular", input: "/exit\r", release: "\x1b[13;1:3u", status: 0 },
  { name: "startup cancellation", mode: "regular", startup: true, input: "\x1b[99;5u", release: ctrlCRelease, status: 130 },
  { name: "repeated SIGTERM", mode: "fullscreen", signal: "SIGTERM", release: ctrlCRelease, status: 143 },
  { name: "repeated SIGTERM during startup", mode: "regular", startup: true, signal: "SIGTERM", release: ctrlCRelease, status: 143 }
];

for (const scenario of cases) {
  test.skipIf(process.platform === "win32")(`${scenario.name} drains late key releases before returning to the shell`, async () => {
    await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-terminal-exit-" });
    const decoder = new TextDecoder();
    let output = "";
    let negotiated = false;
    let exiting = false;
    let releaseSent = false;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const terminal = new Bun.Terminal({
      cols: 100,
      rows: 32,
      name: "xterm-256color",
      data(pty, data) {
        output += decoder.decode(data, { stream: true });
        if (!negotiated && output.includes("\x1b[?u")) {
          negotiated = true;
          pty.write("\x1b[?7u\x1b[?1;2c");
        }
        if (exiting && !releaseTimer && output.includes("\x1b[<u")) {
          // Model a release already in transit when the application disables Kitty.
          releaseTimer = setTimeout(() => {
            if (scenario.signal) process.kill(tuiPid(), scenario.signal);
            pty.write(scenario.release);
            releaseSent = true;
          }, 10);
        }
      }
    });
    const child = Bun.spawn([
      "/bin/sh", "-c",
      '"$@"; tui_status=$?; exec "$1" "$2" parent "$tui_status"',
      "zcode-terminal-exit", process.execPath, fixture,
      scenario.startup ? "startup" : "ready"
    ], {
      cwd: workspace.directory,
      env: {
        ...runtimeTestEnv(workspace.home),
        CI: "1",
        NO_COLOR: "1",
        TERM: "xterm-256color",
        PI_PROGRAM_STATUS: "0",
        ZCODE_TUI_MODE: scenario.mode,
        ZCODE_TUI_NOTIFICATION_METHOD: "off"
      },
      terminal
    });
    const tuiPid = () => Number(/EXIT_TUI_PID (\d+)/u.exec(output)?.[1]);
    const waitFor = async (label: string, ready: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!ready()) {
        if (Date.now() >= deadline || child.exitCode !== null) {
          throw new Error(`Timed out waiting for ${label}.\n${JSON.stringify(output)}`);
        }
        await Bun.sleep(5);
      }
    };
    try {
      await waitFor("interactive TUI", () => negotiated && output.includes(
        scenario.startup ? "Starting ZCode" : "EXIT_READY"
      ));
      await Bun.sleep(30);
      const exitStart = output.length;
      exiting = true;
      if (scenario.signal) process.kill(tuiPid(), scenario.signal);
      else terminal.write(scenario.input!);
      await waitFor("release delivered and parent reading", () => releaseSent && output.includes("EXIT_PARENT_READY"));
      terminal.write("next-command\r");
      await waitFor("parent input report", () => output.includes("EXIT_TUI_STATUS"));
      expect(output).toContain('EXIT_PARENT_INPUT "next-command"');
      expect(output).toContain("EXIT_RAW_MODE false");
      expect(output).toContain(`EXIT_TUI_STATUS ${scenario.status}`);
      expect(output.slice(exitStart).match(/\x1b\[<u/gu)).toHaveLength(1);
      if (scenario.mode === "fullscreen") expect(output.slice(exitStart)).toContain("\x1b[?1049l");
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(releaseTimer);
      if (child.exitCode === null) {
        if (tuiPid()) {
          try { process.kill(tuiPid(), "SIGKILL"); } catch {}
        }
        child.kill("SIGKILL");
      }
      await child.exited;
      if (!terminal.closed) terminal.close();
    }
  }, 10_000);
}
