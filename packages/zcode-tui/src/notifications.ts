import { spawn } from "node:child_process";

import { readUserConfig, updateUserConfig } from "../../../src/model-access.ts";

import { sanitizeTerminalText } from "./terminal-text.ts";

const ESC = "\x1b";
const BEL = "\x07";
const focusReportingEnable = `${ESC}[?1004h`;
const focusReportingDisable = `${ESC}[?1004l`;
const focusIn = `${ESC}[I`;
const focusOut = `${ESC}[O`;
const notificationPreviewGraphemes = 200;
const nativeNotificationTimeoutMs = 3_000;

export type NotificationMethod = "auto" | "osc9" | "bel" | "native" | "off";
export type NotificationCondition = "unfocused" | "always";
export type TurnNotificationKind = "completed" | "failed";

export interface NotificationSettings {
  method: NotificationMethod;
  condition: NotificationCondition;
}

export interface NotificationCommand {
  command: string;
  args: string[];
}

export type NotificationCommandRunner = (command: NotificationCommand) => Promise<boolean>;

interface TurnNotifierOptions {
  writeTerminal: (data: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runCommand?: NotificationCommandRunner;
  settings?: NotificationSettings;
}

const windowsToastScript = [
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)",
  "$text = $xml.GetElementsByTagName('text')",
  "$text.Item(0).AppendChild($xml.CreateTextNode($args[0])) > $null",
  "$text.Item(1).AppendChild($xml.CreateTextNode($args[1])) > $null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('ZCode').Show($toast)"
].join("; ");

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function configuredNotifications(config: unknown): Record<string, unknown> | undefined {
  return record(record(record(config)?.ui)?.notifications);
}

export function notificationSettings(
  env: NodeJS.ProcessEnv = process.env,
  config?: unknown
): NotificationSettings {
  const configured = configuredNotifications(config);
  const method = (env.ZCODE_TUI_NOTIFICATION_METHOD ?? configured?.method)?.toString().trim().toLowerCase();
  const condition = (env.ZCODE_TUI_NOTIFICATION_CONDITION ?? configured?.condition)?.toString().trim().toLowerCase();
  return {
    method: method === "osc9" || method === "bel" || method === "native" || method === "off"
      ? method
      : "auto",
    condition: condition === "always" ? "always" : "unfocused"
  };
}

export async function readNotificationSettings(
  env: NodeJS.ProcessEnv = process.env
): Promise<NotificationSettings> {
  return notificationSettings(env, await readUserConfig(env));
}

export async function readStoredNotificationSettings(
  env: NodeJS.ProcessEnv = process.env
): Promise<NotificationSettings> {
  return notificationSettings({}, await readUserConfig(env));
}

export async function writeNotificationSettings(
  settings: NotificationSettings,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  return await updateUserConfig((config) => {
    const ui = record(config.ui) ?? {};
    ui.notifications = { ...settings };
    config.ui = ui;
  }, env);
}

export function notificationPreview(value: string, maximum = notificationPreviewGraphemes): string | undefined {
  const normalized = sanitizeTerminalText(value, { preserveSgr: false }).replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  if (maximum <= 0) return "";

  const segments = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(normalized),
    (entry) => entry.segment
  );
  return segments.length <= maximum
    ? normalized
    : `${segments.slice(0, Math.max(1, maximum - 1)).join("")}…`;
}

export function supportsOsc9(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env.TERM_PROGRAM?.trim().toLowerCase() ?? "";
  return Boolean(
    env.GHOSTTY_RESOURCES_DIR ||
    env.KITTY_WINDOW_ID ||
    env.WEZTERM_PANE ||
    termProgram.includes("ghostty") ||
    termProgram.includes("iterm") ||
    termProgram.includes("kitty") ||
    termProgram.includes("warp") ||
    termProgram.includes("wezterm")
  );
}

export function osc9NotificationSequence(message: string, tmux = false): string {
  const safeMessage = notificationPreview(message) ?? "ZCode";
  return tmux
    ? `${ESC}Ptmux;${ESC}${ESC}]9;${safeMessage}${BEL}${ESC}\\`
    : `${ESC}]9;${safeMessage}${BEL}`;
}

export function nativeNotificationCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string
): NotificationCommand | undefined {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        "--", title, body
      ]
    };
  }
  if (platform === "linux") {
    return {
      command: "notify-send",
      args: ["--app-name=ZCode", title, body]
    };
  }
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", windowsToastScript, title, body]
    };
  }
  return undefined;
}

async function runNotificationCommand({ command, args }: NotificationCommand): Promise<boolean> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(success);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, nativeNotificationTimeoutMs);
    timeout.unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

export class TurnNotifier {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: NotificationCommandRunner;
  private settings: NotificationSettings;
  private active = false;
  private focusReporting = false;
  private terminalFocused = true;

  constructor(private readonly options: TurnNotifierOptions) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? runNotificationCommand;
    this.settings = options.settings ?? notificationSettings(this.env);
  }

  start(): void {
    this.active = true;
    this.terminalFocused = true;
    this.syncFocusReporting();
  }

  stop(): void {
    this.active = false;
    this.disableFocusReporting();
  }

  currentSettings(): NotificationSettings {
    return { ...this.settings };
  }

  setSettings(settings: NotificationSettings): void {
    this.settings = { ...settings };
    this.syncFocusReporting();
  }

  handleInput(data: string): boolean {
    if (data === focusIn) {
      this.terminalFocused = true;
      return true;
    }
    if (data === focusOut) {
      this.terminalFocused = false;
      return true;
    }
    return false;
  }

  async notify(kind: TurnNotificationKind, detail = ""): Promise<boolean> {
    if (
      this.settings.method === "off" ||
      (this.settings.condition === "unfocused" && this.terminalFocused)
    ) {
      return false;
    }

    const fallback = kind === "completed" ? "Agent turn complete" : "Agent turn failed";
    const body = notificationPreview(detail) ?? fallback;
    const title = kind === "completed" ? "ZCode · Task complete" : "ZCode · Task failed";

    if (this.settings.method === "osc9") return this.writeOsc9(body);
    if (this.settings.method === "bel") return this.writeTerminal(BEL);
    if (this.settings.method === "native") return await this.writeNative(title, body);

    if (supportsOsc9(this.env)) return this.writeOsc9(body);
    if (!this.env.SSH_CONNECTION && !this.env.SSH_TTY && await this.writeNative(title, body)) {
      return true;
    }
    return this.writeTerminal(BEL);
  }

  private writeOsc9(body: string): boolean {
    return this.writeTerminal(osc9NotificationSequence(`ZCode · ${body}`, Boolean(this.env.TMUX)));
  }

  private async writeNative(title: string, body: string): Promise<boolean> {
    const command = nativeNotificationCommand(this.platform, title, body);
    if (!command) return false;
    try {
      return await this.runCommand(command);
    } catch {
      return false;
    }
  }

  private writeTerminal(data: string): boolean {
    try {
      this.options.writeTerminal(data);
      return true;
    } catch {
      return false;
    }
  }

  private syncFocusReporting(): void {
    if (!this.active || this.settings.method === "off") {
      this.disableFocusReporting();
      return;
    }
    if (!this.focusReporting && this.writeTerminal(focusReportingEnable)) {
      this.focusReporting = true;
    }
  }

  private disableFocusReporting(): void {
    if (!this.focusReporting) return;
    this.writeTerminal(focusReportingDisable);
    this.focusReporting = false;
  }
}
