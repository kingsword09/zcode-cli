#!/usr/bin/env bun
// Minimal runTui fixture for the /clear and /cls smoke check.

import { runTui } from "../../packages/zcode-tui/src/index.ts";

const sessionTranscript = [
  { messageId: "message_startup", role: "user", content: "Restored startup prompt." },
  { messageId: "message_startup_reply", role: "agent", content: "Restored startup response." },
  { messageId: "message_later", role: "user", content: "Restored later prompt." },
  { messageId: "message_later_reply", role: "agent", content: "Restored later response." }
];

await runTui({
  model: "alpha/model",
  modelOptions: [{ alias: "main", id: "alpha/model", name: "Alpha" }],
  slashCommands: [{ name: "new", summary: "Start a fresh session." }],
  loadSessionTranscript: async () => sessionTranscript,
  submitPrompt: async (input) => {
    if (input === "/clear") {
      return { response: "Runtime handled /clear as a new session.", sessionId: "sess_new" };
    }
    return { response: `Echo: ${String(input)}` };
  },
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin
} as Parameters<typeof runTui>[0]);
