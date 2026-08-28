#!/usr/bin/env bun

import { runTui } from "../../packages/zcode-tui/src/index.ts";

const response = Array.from({ length: 80 }, (_, index) => `transcript line ${index + 1}`).join("\n");

await runTui({
  version: "fullscreen-layout-smoke",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: "alpha/model",
  initialThoughtLevel: "low",
  loginRequired: true,
  modelOptions: [{ id: "alpha/model", name: "Alpha" }],
  effortOptions: [{ id: "low", label: "Low" }],
  writeClipboardText: process.env.ZCODE_TUI_TEST_CLIPBOARD_PATH
    ? async (text) => {
        await Bun.write(process.env.ZCODE_TUI_TEST_CLIPBOARD_PATH!, text);
      }
    : undefined,
  submitPrompt: async () => ({ response, model: "alpha/model", thoughtLevel: "low" })
});
