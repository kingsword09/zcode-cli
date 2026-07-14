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
export type NotificationBackend = "osc9" | "bel" | "native" | "off";
export type TerminalFocusState = "focused" | "unfocused" | "unknown";

export interface NotificationSettings {
  method: NotificationMethod;
  condition: NotificationCondition;
}

export interface NotificationDiagnostics {
  configuredMethod: NotificationMethod;
  backend: NotificationBackend;
  focus: TerminalFocusState;
  terminal: string;
}

export type NativeNotificationSender = (
  platform: NodeJS.Platform,
  title: string,
  body: string
) => Promise<boolean>;

export interface NativeNotificationCommand {
  command: string;
  args: string[];
}

type ExecutableResolver = (name: string) => string | null;

interface TurnNotifierOptions {
  writeTerminal: (data: string) => void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nativeNotify?: NativeNotificationSender;
  settings?: NotificationSettings;
}

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

export function detectedTerminal(env: NodeJS.ProcessEnv = process.env): string {
  const termProgram = env.TERM_PROGRAM?.trim();
  if (termProgram) return termProgram;
  if (env.GHOSTTY_RESOURCES_DIR) return "Ghostty";
  if (env.KITTY_WINDOW_ID) return "Kitty";
  if (env.WEZTERM_PANE) return "WezTerm";
  return env.TERM?.trim() || "unknown terminal";
}

export function resolveNotificationBackend(
  method: NotificationMethod,
  env: NodeJS.ProcessEnv = process.env
): NotificationBackend {
  if (method === "off" || method === "bel" || method === "native") return method;
  return supportsOsc9(env) ? "osc9" : "bel";
}

export function notificationDeliveryLabel(
  method: NotificationMethod,
  backend: NotificationBackend
): string {
  if (method === "auto") return `${method} → ${backend}`;
  return method === backend ? method : `${method} → ${backend} fallback`;
}

export function terminalBundleIdentifier(
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const terminal = env.TERM_PROGRAM?.trim().toLowerCase() ?? "";
  if (terminal === "apple_terminal") return "com.apple.Terminal";
  if (terminal.includes("iterm")) return "com.googlecode.iterm2";
  if (terminal.includes("ghostty") || env.GHOSTTY_RESOURCES_DIR) return "com.mitchellh.ghostty";
  if (terminal.includes("kitty") || env.KITTY_WINDOW_ID) return "net.kovidgoyal.kitty";
  if (terminal.includes("warp")) return "dev.warp.Warp-Stable";
  if (terminal.includes("wezterm") || env.WEZTERM_PANE) return "com.github.wez.wezterm";
  if (terminal.includes("vscode")) return "com.microsoft.VSCode";
  return undefined;
}

export function osc9NotificationSequence(message: string, tmux = false): string {
  const safeMessage = notificationPreview(message) ?? "ZCode";
  return tmux
    ? `${ESC}Ptmux;${ESC}${ESC}]9;${safeMessage}${BEL}${ESC}\\`
    : `${ESC}]9;${safeMessage}${BEL}`;
}

export function terminalNotifierCommand(
  title: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
  which: ExecutableResolver = Bun.which
): NativeNotificationCommand | undefined {
  const command = which("terminal-notifier");
  if (!command) return undefined;

  const args = ["-title", title, "-message", body, "-group", "zcode-cli-turn"];
  const terminalBundle = terminalBundleIdentifier(env);
  if (terminalBundle) args.push("-sender", terminalBundle, "-activate", terminalBundle);
  return { command, args };
}

export function nativeNotificationCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
  which: ExecutableResolver = Bun.which
): NativeNotificationCommand | undefined {
  if (platform === "darwin") return terminalNotifierCommand(title, body, env, which);
  if (platform === "linux") {
    const command = which("notify-send");
    return command ? { command, args: ["--app-name=ZCode", title, body] } : undefined;
  }
  if (platform === "win32") {
    const command = which("SnoreToast.exe") ?? which("snoretoast");
    return command ? { command, args: ["-t", title, "-m", body, "-appID", "ZCode CLI"] } : undefined;
  }
  return undefined;
}

async function runNativeNotification(command: NativeNotificationCommand | undefined): Promise<boolean> {
  if (!command) return false;
  return await new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.command, command.args, { stdio: "ignore", windowsHide: true });
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

export async function sendNativeNotification(
  platform: NodeJS.Platform,
  title: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  return await runNativeNotification(nativeNotificationCommand(platform, title, body, env));
}

export class TurnNotifier {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly nativeNotify: NativeNotificationSender;
  private settings: NotificationSettings;
  private active = false;
  private focusReporting = false;
  private terminalFocus: TerminalFocusState = "unknown";

  constructor(private readonly options: TurnNotifierOptions) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.nativeNotify = options.nativeNotify ?? ((platform, title, body) => (
      sendNativeNotification(platform, title, body, this.env)
    ));
    this.settings = options.settings ?? notificationSettings(this.env);
  }

  start(): void {
    this.active = true;
    this.terminalFocus = "unknown";
    this.syncFocusReporting();
  }

  stop(): void {
    this.active = false;
    this.disableFocusReporting();
  }

  currentSettings(): NotificationSettings {
    return { ...this.settings };
  }

  diagnostics(): NotificationDiagnostics {
    return {
      configuredMethod: this.settings.method,
      backend: resolveNotificationBackend(this.settings.method, this.env),
      focus: this.terminalFocus,
      terminal: detectedTerminal(this.env)
    };
  }

  setSettings(settings: NotificationSettings): void {
    if (this.settings.condition !== settings.condition) this.terminalFocus = "unknown";
    this.settings = { ...settings };
    this.syncFocusReporting();
  }

  handleInput(data: string): boolean {
    if (data === focusIn) {
      this.terminalFocus = "focused";
      return true;
    }
    if (data === focusOut) {
      this.terminalFocus = "unfocused";
      return true;
    }
    return false;
  }

  async notify(kind: TurnNotificationKind, detail = ""): Promise<boolean> {
    if (
      this.settings.method === "off" ||
      (this.settings.condition === "unfocused" && this.terminalFocus === "focused")
    ) {
      return false;
    }

    const fallback = kind === "completed" ? "Agent turn complete" : "Agent turn failed";
    const body = notificationPreview(detail) ?? fallback;
    const title = kind === "completed" ? "ZCode · Task complete" : "ZCode · Task failed";

    const backend = resolveNotificationBackend(this.settings.method, this.env);
    if (backend === "osc9") return this.writeOsc9(body);
    if (backend === "native" && await this.writeNative(title, body)) return true;
    return backend === "off" ? false : this.writeTerminal(BEL);
  }

  private writeOsc9(body: string): boolean {
    return this.writeTerminal(osc9NotificationSequence(`ZCode · ${body}`, Boolean(this.env.TMUX)));
  }

  private async writeNative(title: string, body: string): Promise<boolean> {
    try {
      return await this.nativeNotify(this.platform, title, body);
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
    if (
      !this.active ||
      this.settings.method === "off" ||
      this.settings.condition !== "unfocused"
    ) {
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
    this.terminalFocus = "unknown";
  }
}
