#!/usr/bin/env bun

// Minimal fixture that boots ZCodeTui in fullscreen mode via the
// ZCODE_TUI_MODE environment variable. The smoke script
// (scripts/smoke-tui-fullscreen.ts) asserts that TuiAltScreen enters the
// alternate screen (DEC private mode 1049). The fixture exits immediately
// after the editor becomes interactive so the smoke layer can observe the
// startup escape sequence.

import { runTui } from "../../packages/zcode-tui/src/index.ts";

let model = "alpha/model";
let effort = "low";

await runTui({
  version: "fullscreen-smoke",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: model,
  initialThoughtLevel: effort,
  modelOptions: [
    { alias: "main", id: "alpha/model", name: "Alpha" },
    { alias: "lite", id: "beta/model", name: "Beta" }
  ],
  effortOptions: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" }
  ],
  listWorkspacePathSuggestions: async ({ token }) => {
    await Bun.sleep(120);
    return token === "@ind"
      ? { items: [{ kind: "file" as const, path: "src/index.ts" }], truncated: false }
      : { items: [], truncated: false };
  },
  submitPrompt: async () => ({ response: "ok", model, thoughtLevel: effort })
});
