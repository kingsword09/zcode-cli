import { readFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import {
  Container,
  isKeyRelease,
  isViewportTUI,
  matchesKey,
  Spacer,
  Text,
  VStack,
  type TUI,
  type TuiMode
} from "@earendil-works/pi-tui";

import { cliSettingsPath } from "../../../src/config-paths.ts";
import { initialColorScheme, queryTerminalColorScheme, themePreference, type ZCodeColorScheme } from "./color-scheme.ts";
import { FullscreenHeader, SessionWelcome } from "./fullscreen-header.ts";
import { PlanEditor } from "./plan-editor.ts";
import { StatusLine } from "./status-line.ts";
import { watchStreamErrors } from "./stream-error-guard.ts";
import { stopTui } from "./terminal-cleanup.ts";
import { createThemeStyles } from "./theme-styles.ts";
import { createTuiScreen } from "./tui-screen.ts";
import type { TuiOptions } from "./types.ts";

export class TuiStartupScreen {
  cancelled = false;
  colorScheme?: ZCodeColorScheme;
  private claimed = false;

  constructor(
    readonly ui: TUI,
    readonly mode: TuiMode,
    readonly editor: PlanEditor | undefined,
    private readonly cleanup: () => void
  ) {}

  claim(): void {
    this.claimed = true;
    this.cleanup();
  }

  async dispose(): Promise<void> {
    if (this.claimed) return;
    this.claimed = true;
    try {
      try {
        this.ui.clear();
        this.ui.renderNow();
      } finally {
        await stopTui(this.ui);
      }
    } finally {
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.cleanup();
    }
  }
}

async function startupAppearance(options: TuiOptions): Promise<{ mode: TuiMode; theme?: string }> {
  let appearance: Record<string, unknown> | undefined;
  try {
    appearance = JSON.parse(await readFile(cliSettingsPath(), "utf8"))?.ui;
  } catch {}
  const mode = process.env.ZCODE_TUI_MODE?.trim().toLowerCase();
  const configured = options.initialTuiMode ?? appearance?.tuiMode;
  const normalized = typeof configured === "string" ? configured.trim().toLowerCase() : undefined;
  return {
    mode: (mode === "regular" || mode === "fullscreen" ? mode : normalized) === "fullscreen"
      ? "fullscreen" : "regular",
    theme: options.theme ?? (typeof appearance?.theme === "string" ? appearance.theme : undefined)
  };
}

export async function loadTuiStartupOptions(options: TuiOptions): Promise<TuiOptions | undefined> {
  const loadStartupOptions = options.loadStartupOptions;
  if (!loadStartupOptions) return options;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("ZCode TUI requires an interactive terminal.");
  }

  const appearance = await startupAppearance(options);
  const ui = createTuiScreen(appearance.mode);
  const preference = themePreference(appearance.theme);
  const theme = createThemeStyles(!options.noColor && !process.env.NO_COLOR, initialColorScheme(preference));
  const chinese = options.locale?.startsWith("zh");
  const editor = options.startupEditor
    ? new PlanEditor(ui, theme.editor, { paddingX: 1, autocompleteMaxVisible: 7 }) : undefined;
  if (options.startupEditor) {
    const header = new FullscreenHeader(theme, {
      distributionVersion: process.env.ZCODE_APP_CLI_VERSION ?? options.version,
      runtimeVersion: options.version ?? "unknown",
      workspace: options.workspaceDirectory ?? process.cwd(),
      branch: options.workspaceGitBranch
    });
    const welcome = new SessionWelcome(theme, width => header.location(width), width => header.identity(width), {
      includeIdentity: appearance.mode !== "fullscreen"
    });
    const transcript = new Container();
    transcript.addChild(welcome);
    transcript.addChild(new Spacer(1));
    const status = new StatusLine();
    status.setFields([
      { text: theme.muted(chinese ? "正在启动 ZCode…" : "Starting ZCode…"), priority: 100, required: true },
      { text: theme.muted(chinese ? "可以先输入，准备就绪后按 Enter 发送 · Ctrl+C 取消"
        : "Type now · Enter to send when ready · Ctrl+C to cancel"), priority: 50 }
    ], theme.muted(" ─ "));
    const composer = new Container();
    composer.addChild(editor!);
    composer.addChild(status);
    if (isViewportTUI(ui)) {
      ui.setLayoutRoot(new VStack([
        { component: header, basis: 1, shrink: 0, minSize: 1 },
        { component: transcript, basis: 0, grow: 1, minSize: 1 },
        { component: composer, basis: "auto", shrink: 1, minSize: 1 }
      ]));
    } else {
      ui.addChild(transcript);
      ui.addChild(composer);
    }
  } else {
    ui.addChild(new Text(chinese ? "正在启动 ZCode…" : "Starting ZCode…", 1, 0));
    ui.addChild(new Text(chinese ? "按 Ctrl+C 取消" : "Press Ctrl+C to cancel", 1, 0));
  }
  if (editor) {
    editor.disableSubmit = true;
    ui.setFocus(editor);
  }

  let cancelled = false;
  let resolveCancelled!: () => void;
  const cancellation = new Promise<undefined>((resolve) => {
    resolveCancelled = () => resolve(undefined);
  });
  const cancel = (exitCode: number) => {
    if (cancelled) return;
    cancelled = true;
    screen.cancelled = true;
    process.exitCode = exitCode;
    resolveCancelled();
  };
  const onSigint = () => cancel(128 + osConstants.signals.SIGINT);
  const onSigterm = () => cancel(128 + osConstants.signals.SIGTERM);
  const onSighup = () => cancel(128 + osConstants.signals.SIGHUP);
  const onRuntimeAbort = () => cancel(1);
  const removeInputListener = ui.addInputListener((data) => {
    if (!isKeyRelease(data) && matchesKey(data, "ctrl+c")) {
      onSigint();
      return { consume: true };
    }
    return editor ? undefined : { consume: true };
  });
  const removeStreamErrorGuards = watchStreamErrors([process.stdout, process.stderr], () => cancel(1));
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  if (process.platform !== "win32") process.on("SIGHUP", onSighup);
  options.runtimeSignal?.addEventListener("abort", onRuntimeAbort, { once: true });
  const screen = new TuiStartupScreen(ui, appearance.mode, editor, () => {
    removeInputListener();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (process.platform !== "win32") process.off("SIGHUP", onSighup);
    options.runtimeSignal?.removeEventListener("abort", onRuntimeAbort);
    removeStreamErrorGuards();
  });

  let readyOptions: TuiOptions | undefined;
  try {
    if (options.runtimeSignal?.aborted) return undefined;
    ui.start();
    ui.renderNow();
    if (preference === "auto" && !options.noColor && !process.env.NO_COLOR) {
      void queryTerminalColorScheme(ui, 100).then(scheme => {
        if (!scheme || cancelled) return;
        screen.colorScheme = scheme;
        theme.setColorScheme(scheme);
        ui.requestRender();
      }).catch(() => {});
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (cancelled) return undefined;
    readyOptions = await Promise.race([
      Promise.resolve().then(async () => {
        if (cancelled) return undefined;
        const startup = await loadStartupOptions();
        return cancelled ? undefined : { ...options, theme: appearance.theme, ...startup };
      }),
      cancellation
    ]);
  } finally {
    if (cancelled || !readyOptions || !editor) await screen.dispose();
  }
  return cancelled || !readyOptions ? undefined : {
    ...readyOptions,
    ...(editor ? { startupScreen: screen } : {})
  };
}
