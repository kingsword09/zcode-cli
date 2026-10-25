import { constants as osConstants } from "node:os";
import { isKeyRelease, matchesKey, ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";

import { watchStreamErrors } from "./stream-error-guard.ts";
import { stopTui } from "./terminal-cleanup.ts";
import type { TuiOptions } from "./types.ts";

export async function loadTuiStartupOptions(options: TuiOptions): Promise<TuiOptions | undefined> {
  const loadStartupOptions = options.loadStartupOptions;
  if (!loadStartupOptions) return options;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("ZCode TUI requires an interactive terminal.");
  }

  const ui = new TuiMainScreen(new ProcessTerminal(), true);
  const chinese = options.locale?.startsWith("zh");
  ui.addChild(new Text(chinese ? "正在启动 ZCode…" : "Starting ZCode…", 1, 0));
  ui.addChild(new Text(chinese ? "按 Ctrl+C 取消" : "Press Ctrl+C to cancel", 1, 0));

  let cancelled = false;
  let resolveCancelled!: () => void;
  const cancellation = new Promise<undefined>((resolve) => {
    resolveCancelled = () => resolve(undefined);
  });
  const cancel = (exitCode: number) => {
    if (cancelled) return;
    cancelled = true;
    process.exitCode = exitCode;
    resolveCancelled();
  };
  const onSigint = () => cancel(128 + osConstants.signals.SIGINT);
  const onSigterm = () => cancel(128 + osConstants.signals.SIGTERM);
  const onSighup = () => cancel(128 + osConstants.signals.SIGHUP);
  ui.addInputListener((data) => {
    if (!isKeyRelease(data) && matchesKey(data, "ctrl+c")) onSigint();
    return { consume: true };
  });
  const removeStreamErrorGuards = watchStreamErrors([process.stdout, process.stderr], () => cancel(1));
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  if (process.platform !== "win32") process.on("SIGHUP", onSighup);

  let readyOptions: TuiOptions | undefined;
  try {
    ui.start();
    ui.renderNow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (cancelled) return undefined;
    readyOptions = await Promise.race([
      Promise.resolve().then(async () => {
        if (cancelled) return undefined;
        const startup = await loadStartupOptions();
        return cancelled ? undefined : { ...options, ...startup };
      }),
      cancellation
    ]);
  } finally {
    try {
      ui.clear();
      ui.renderNow();
    } finally {
      try {
        await stopTui(ui);
      } finally {
        await new Promise<void>((resolve) => setImmediate(resolve));
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
        if (process.platform !== "win32") process.off("SIGHUP", onSighup);
        removeStreamErrorGuards();
      }
    }
  }
  return cancelled ? undefined : readyOptions;
}
