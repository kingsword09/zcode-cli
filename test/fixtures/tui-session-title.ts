#!/usr/bin/env bun
// Minimal runTui fixture for terminal session-title lifecycle coverage.

import { runTui } from "../../packages/zcode-tui/src/index.ts";

const sessionTranscript = [
  { messageId: "message_startup", role: "user", content: "Restored startup prompt." },
  { messageId: "message_startup_reply", role: "agent", content: "Restored startup response." }
];

await runTui({
  model: "alpha/model",
  slashCommands: [
    { name: "login", summary: "Sign in" },
    { name: "resume", summary: "Resume a session" }
  ],
  loadSessionTranscript: async () => sessionTranscript,
  submitPrompt: async (input) => {
    if (input === "/resume fixture-session") {
      return {
        resetSessionProjection: true,
        restoredMessages: [
          { role: "user", content: "Restored resumed prompt." },
          { role: "agent", content: "Restored resumed response." }
        ],
        response: "Resumed session fixture-session."
      };
    }
    return { response: `Echo: ${String(input)}` };
  },
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin
} as Parameters<typeof runTui>[0]);
