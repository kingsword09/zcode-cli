import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  nativeNotificationCommand,
  notificationPreview,
  notificationSettings,
  osc9NotificationSequence,
  readNotificationSettings,
  readStoredNotificationSettings,
  supportsOsc9,
  TurnNotifier,
  writeNotificationSettings,
  type NotificationCommand
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
  });

  test("constructs native commands without interpolating notification text", () => {
    const mac = nativeNotificationCommand("darwin", "title ' quoted", "body \" quoted");
    expect(mac?.command).toBe("osascript");
    expect(mac?.args.slice(-3)).toEqual(["--", "title ' quoted", "body \" quoted"]);

    expect(nativeNotificationCommand("linux", "Title", "Body")).toEqual({
      command: "notify-send",
      args: ["--app-name=ZCode", "Title", "Body"]
    });

    const windows = nativeNotificationCommand("win32", "Title", "Body");
    expect(windows?.command).toBe("powershell.exe");
    expect(windows?.args.slice(-2)).toEqual(["Title", "Body"]);
    expect(windows?.args.join(" ")).not.toContain("CreateTextNode(Title)");
  });

  test("notifies through OSC 9 only after the terminal loses focus", async () => {
    const writes: string[] = [];
    const notifier = new TurnNotifier({
      env: { TERM_PROGRAM: "iTerm.app" },
      platform: "darwin",
      settings: { method: "auto", condition: "unfocused" },
      writeTerminal: (data) => writes.push(data)
    });

    notifier.start();
    expect(writes).toEqual(["\x1b[?1004h"]);
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

    expect(notifier.currentSettings()).toEqual({ method: "bel", condition: "always" });
    expect(writes).toEqual(["\x1b[?1004h", "\x1b[?1004l", "\x1b[?1004h"]);
  });

  test("uses a native notification and falls back to BEL when unavailable", async () => {
    const commands: NotificationCommand[] = [];
    const writes: string[] = [];
    const native = new TurnNotifier({
      env: { TERM_PROGRAM: "Apple_Terminal" },
      platform: "linux",
      settings: { method: "auto", condition: "always" },
      writeTerminal: (data) => writes.push(data),
      runCommand: async (command) => {
        commands.push(command);
        return true;
      }
    });

    expect(await native.notify("failed", "Build failed")).toBe(true);
    expect(commands).toEqual([{
      command: "notify-send",
      args: ["--app-name=ZCode", "ZCode · Task failed", "Build failed"]
    }]);
    expect(writes).toEqual([]);

    const fallback = new TurnNotifier({
      env: {},
      platform: "linux",
      settings: { method: "auto", condition: "always" },
      writeTerminal: (data) => writes.push(data),
      runCommand: async () => false
    });
    expect(await fallback.notify("completed")).toBe(true);
    expect(writes).toEqual(["\x07"]);
  });

  test("avoids remote native commands over SSH and supports disabling notifications", async () => {
    let commandRuns = 0;
    const writes: string[] = [];
    const remote = new TurnNotifier({
      env: { SSH_CONNECTION: "client server" },
      platform: "linux",
      settings: { method: "auto", condition: "always" },
      writeTerminal: (data) => writes.push(data),
      runCommand: async () => {
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
