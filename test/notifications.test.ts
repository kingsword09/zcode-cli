import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectedTerminal,
  nativeNotificationCommand,
  notificationDeliveryLabel,
  notificationPreview,
  notificationSettings,
  osc9NotificationSequence,
  readNotificationSettings,
  readStoredNotificationSettings,
  resolveNotificationBackend,
  supportsOsc9,
  terminalBundleIdentifier,
  terminalNotifierCommand,
  TurnNotifier,
  writeNotificationSettings,
  type NativeNotificationSender
} from "../packages/zcode-tui/src/notifications.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("TUI turn notifications", () => {
  test("uses quiet defaults and accepts explicit delivery settings", () => {
    expect(notificationSettings({})).toEqual({ method: "auto", condition: "unfocused" });
    expect(notificationSettings({
      ZCODE_TUI_NOTIFICATION_METHOD: "native",
      ZCODE_TUI_NOTIFICATION_CONDITION: "always"
    })).toEqual({ method: "native", condition: "always" });
    expect(notificationSettings({
      ZCODE_TUI_NOTIFICATION_METHOD: "unknown",
      ZCODE_TUI_NOTIFICATION_CONDITION: "unknown"
    })).toEqual({ method: "auto", condition: "unfocused" });
    const config = { ui: { notifications: { method: "native", condition: "always" } } };
    expect(notificationSettings({}, config)).toEqual({ method: "native", condition: "always" });
    expect(notificationSettings({ ZCODE_TUI_NOTIFICATION_METHOD: "off" }, config)).toEqual({
      method: "off",
      condition: "always"
    });
  });

  test("persists notification settings without replacing the rest of config.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-notification-config-"));
    temporaryDirectories.push(home);
    const env = { HOME: home, USERPROFILE: home };

    const configPath = await writeNotificationSettings({ method: "native", condition: "always" }, env);
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

    expect(await readNotificationSettings(env)).toEqual({ method: "native", condition: "always" });
    expect(await readStoredNotificationSettings({
      ...env,
      ZCODE_TUI_NOTIFICATION_METHOD: "off"
    })).toEqual({ method: "native", condition: "always" });
    expect(config.provider).toBeDefined();
    expect(config.model).toBeDefined();
    expect(config.ui).toMatchObject({
      locale: "auto",
      theme: "auto",
      notifications: { method: "native", condition: "always" }
    });
  });

  test("builds safe bounded previews from untrusted assistant text", () => {
    expect(notificationPreview("  Hello\n\tworld \x1b]9;injected\x07  ")).toBe("Hello world");
    expect(notificationPreview("A👨‍👩‍👧‍👦BCDE", 4)).toBe("A👨‍👩‍👧‍👦B…");
    expect(notificationPreview("\x1b[31m\x1b[0m")).toBeUndefined();
  });

  test("matches Codex OSC 9 framing with and without tmux", () => {
    expect(osc9NotificationSequence("done")).toBe("\x1b]9;done\x07");
    expect(osc9NotificationSequence("done", true)).toBe(
      "\x1bPtmux;\x1b\x1b]9;done\x07\x1b\\"
    );
  });

  test("detects known OSC 9 terminals", () => {
    expect(supportsOsc9({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
    expect(supportsOsc9({ WEZTERM_PANE: "1" })).toBe(true);
    expect(supportsOsc9({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
    expect(detectedTerminal({ TERM_PROGRAM: "Apple_Terminal" })).toBe("Apple_Terminal");
    expect(resolveNotificationBackend("auto", { TERM_PROGRAM: "Apple_Terminal" })).toBe("bel");
    expect(resolveNotificationBackend("osc9", { TERM_PROGRAM: "Apple_Terminal" })).toBe("bel");
    expect(resolveNotificationBackend("osc9", { TERM_PROGRAM: "iTerm.app" })).toBe("osc9");
    expect(resolveNotificationBackend("native", { TERM_PROGRAM: "iTerm.app" })).toBe("native");
    expect(notificationDeliveryLabel("native", "native")).toBe("native");
    expect(notificationDeliveryLabel("auto", "bel")).toBe("auto → bel");
    expect(notificationDeliveryLabel("osc9", "bel")).toBe("osc9 → bel fallback");
  });

  test("builds dependency-free native commands without shell interpolation", () => {
    const commands = new Map([
      ["terminal-notifier", "/opt/bin/terminal-notifier"],
      ["notify-send", "/usr/bin/notify-send"],
      ["SnoreToast.exe", "C:\\Tools\\SnoreToast.exe"]
    ]);
    const which = (name: string) => commands.get(name) ?? null;

    expect(terminalBundleIdentifier({ TERM_PROGRAM: "iTerm.app" })).toBe("com.googlecode.iterm2");
    expect(terminalBundleIdentifier({ TERM_PROGRAM: "vscode" })).toBe("com.microsoft.VSCode");
    expect(terminalBundleIdentifier({})).toBeUndefined();
    const command = terminalNotifierCommand("title ' quoted", "body \" quoted", {
      TERM_PROGRAM: "Apple_Terminal"
    }, which);
    expect(command).toEqual({
      command: "/opt/bin/terminal-notifier",
      args: [
        "-title", "title ' quoted",
        "-message", "body \" quoted",
        "-group", "zcode-cli-turn",
        "-sender", "com.apple.Terminal",
        "-activate", "com.apple.Terminal"
      ]
    });
    expect(terminalNotifierCommand("Title", "Body", {}, () => null)).toBeUndefined();
    expect(nativeNotificationCommand("linux", "Title", "Body", {}, which)).toEqual({
      command: "/usr/bin/notify-send",
      args: ["--app-name=ZCode", "Title", "Body"]
    });
    expect(nativeNotificationCommand("win32", "Title", "Body", {}, which)).toEqual({
      command: "C:\\Tools\\SnoreToast.exe",
      args: ["-t", "Title", "-m", "Body", "-appID", "ZCode CLI"]
    });
    expect(nativeNotificationCommand("freebsd", "Title", "Body", {}, which)).toBeUndefined();
    expect(command?.args).toEqual([
      "-title", "title ' quoted",
      "-message", "body \" quoted",
      "-group", "zcode-cli-turn",
      "-sender", "com.apple.Terminal",
      "-activate", "com.apple.Terminal"
    ]);
  });

  test("resolves native notification commands from PATH without Bun", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-notification-path-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "notify-send");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);

    expect(nativeNotificationCommand("linux", "Title", "Body", { PATH: directory })).toEqual({
      command: executable,
      args: ["--app-name=ZCode", "Title", "Body"]
    });
  });

  test("uses reported focus and does not suppress notifications while focus is unknown", async () => {
    const writes: string[] = [];
    const notifier = new TurnNotifier({
      env: { TERM_PROGRAM: "iTerm.app" },
      platform: "darwin",
      settings: { method: "auto", condition: "unfocused" },
      writeTerminal: (data) => writes.push(data)
    });

    notifier.start();
    expect(writes).toEqual(["\x1b[?1004h"]);
    expect(notifier.diagnostics()).toEqual({
      configuredMethod: "auto",
      backend: "osc9",
      focus: "unknown",
      terminal: "iTerm.app"
    });
    expect(await notifier.notify("completed", "Focus support is not known yet.")).toBe(true);
    expect(notifier.handleInput("\x1b[I")).toBe(true);
    expect(await notifier.notify("completed", "Finished the task.")).toBe(false);
    expect(notifier.handleInput("\x1b[O")).toBe(true);
    expect(await notifier.notify("completed", "Finished\n the task.")).toBe(true);
    expect(writes.at(-1)).toBe("\x1b]9;ZCode · Finished the task.\x07");
    expect(notifier.handleInput("\x1b[I")).toBe(true);
    expect(notifier.handleInput("x")).toBe(false);
    notifier.stop();
    expect(writes.at(-1)).toBe("\x1b[?1004l");
  });

  test("applies changed settings to focus reporting immediately", () => {
    const writes: string[] = [];
    const notifier = new TurnNotifier({
      settings: { method: "auto", condition: "unfocused" },
      writeTerminal: (data) => writes.push(data)
    });

    notifier.start();
    notifier.setSettings({ method: "off", condition: "unfocused" });
    notifier.setSettings({ method: "bel", condition: "always" });
    notifier.setSettings({ method: "bel", condition: "unfocused" });

    expect(notifier.currentSettings()).toEqual({ method: "bel", condition: "unfocused" });
    expect(writes).toEqual(["\x1b[?1004h", "\x1b[?1004l", "\x1b[?1004h"]);
  });

  test("uses Codex-style BEL fallback in Apple Terminal without requiring focus support", async () => {
    let nativeCalls = 0;
    const writes: string[] = [];
    const automatic = new TurnNotifier({
      env: { TERM_PROGRAM: "Apple_Terminal" },
      platform: "linux",
      settings: { method: "osc9", condition: "unfocused" },
      writeTerminal: (data) => writes.push(data),
      nativeNotify: async () => {
        nativeCalls += 1;
        return true;
      }
    });

    automatic.start();
    expect(await automatic.notify("failed", "Build failed")).toBe(true);
    expect(nativeCalls).toBe(0);
    expect(writes).toEqual(["\x1b[?1004h", "\x07"]);
    expect(automatic.diagnostics()).toEqual({
      configuredMethod: "osc9",
      backend: "bel",
      focus: "unknown",
      terminal: "Apple_Terminal"
    });
    automatic.stop();

    const native = new TurnNotifier({
      env: {},
      platform: "linux",
      settings: { method: "native", condition: "always" },
      writeTerminal: (data) => writes.push(data),
      nativeNotify: async () => false
    });
    expect(await native.notify("completed")).toBe(true);
    expect(writes.at(-1)).toBe("\x07");
  });

  test("uses the explicitly selected native backend when its command succeeds", async () => {
    const calls: Parameters<NativeNotificationSender>[] = [];
    const writes: string[] = [];
    const notifier = new TurnNotifier({
      platform: "linux",
      settings: { method: "native", condition: "always" },
      writeTerminal: (data) => writes.push(data),
      nativeNotify: async (...args) => {
        calls.push(args);
        return true;
      }
    });

    expect(await notifier.notify("failed", "Build failed")).toBe(true);
    expect(calls).toEqual([["linux", "ZCode · Task failed", "Build failed"]]);
    expect(writes).toEqual([]);
  });

  test("uses BEL for automatic SSH notifications and supports disabling notifications", async () => {
    let commandRuns = 0;
    const writes: string[] = [];
    const remote = new TurnNotifier({
      env: { SSH_CONNECTION: "client server" },
      platform: "linux",
      settings: { method: "auto", condition: "always" },
      writeTerminal: (data) => writes.push(data),
      nativeNotify: async () => {
        commandRuns += 1;
        return true;
      }
    });
    expect(await remote.notify("completed", "Done")).toBe(true);
    expect(commandRuns).toBe(0);
    expect(writes).toEqual(["\x07"]);

    const disabled = new TurnNotifier({
      settings: { method: "off", condition: "always" },
      writeTerminal: (data) => writes.push(data)
    });
    disabled.start();
    expect(await disabled.notify("completed", "Done")).toBe(false);
    disabled.stop();
    expect(writes).toEqual(["\x07"]);
  });
});
