import type { TUI } from "@earendil-works/pi-tui";

/** Disable enhanced keyboard reporting and consume in-flight releases before restoring the terminal. */
export async function stopTui(ui: TUI): Promise<void> {
  try {
    await ui.terminal.drainInput();
  } catch {
    // A disconnected terminal can fail to drain; still restore its modes and listeners.
  }
  ui.stop();
}
