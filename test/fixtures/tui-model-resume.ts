#!/usr/bin/env bun

import { runTui } from "../../packages/zcode-tui/src/index.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

let resumed = false;
const defaultModel = "scenario/glm-5.3";
const statePath = join(process.cwd(), ".model-resume-state.json");

async function selectedModel(): Promise<string> {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as { model?: unknown };
    return typeof state.model === "string" && state.model.trim() ? state.model : defaultModel;
  } catch {
    return defaultModel;
  }
}

await runTui({
  initialModel: defaultModel,
  modelOptions: [
    { alias: "main", id: "scenario/glm-5.3", name: "GLM-5.3" },
    { id: "scenario/glm-5.3-flash", name: "GLM-5.3-Flash" }
  ],
  loadSessionTranscript: async () => [],
  readSessionModel: async () => resumed ? { model: await selectedModel() } : undefined,
  setTransientModel: async (modelId) => {
    await writeFile(statePath, JSON.stringify({ model: modelId }), "utf8");
    return { model: modelId };
  },
  submitPrompt: async (input) => input === "/resume fixture-session" && (resumed = true)
    ? {
        model: defaultModel,
        resetSessionProjection: true,
        restoredMessages: [{
          messageId: "resumed_assistant",
          role: "agent",
          model: await selectedModel(),
          content: "Restored response from the selected session model."
        }],
        response: "Resumed session fixture-session."
      }
    : { response: `Echo: ${String(input)}` },
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin
} as Parameters<typeof runTui>[0]);
