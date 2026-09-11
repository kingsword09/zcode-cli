#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runTui } from "../../../packages/zcode-tui/src/index.ts";

await runTui({
  version: "write-and-diff-scenario",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: "scenario/model",
  modelOptions: [{ alias: "main", id: "scenario/model", name: "Scenario" }],
  loadSessionTranscript: async () => [
    {
      messageId: "scenario_instruction",
      role: "agent",
      content: "Type “modify workspace” to start the isolated Write and real Git diff scenario."
    }
  ],
  submitPrompt: async (input: unknown) => {
    if (String(input) !== "modify workspace") {
      return { response: "Type “modify workspace” to start." };
    }
    await mkdir(join(process.cwd(), "src"), { recursive: true });
    await Promise.all([
      writeFile(join(process.cwd(), "src", "example.ts"), "export const value = 2;\n"),
      writeFile(join(process.cwd(), "src", "created.ts"), "export const created = true;\n")
    ]);
    return { response: "Workspace write complete." };
  },
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr
} as Parameters<typeof runTui>[0]);
