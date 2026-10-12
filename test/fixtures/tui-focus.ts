#!/usr/bin/env bun

export {};

if (process.argv[2] === "login") {
  console.log("Focus fixture login finished.");
  process.exit(0);
}

const entry = new URL(process.argv[2] === "built"
  ? "../../packages/zcode-tui/dist/index.js"
  : "../../packages/zcode-tui/src/index.ts", import.meta.url);
const { runTui } = await import(entry.href) as typeof import("../../packages/zcode-tui/src/index.ts");

await runTui({
  version: "focus-smoke",
  workspaceDirectory: process.cwd(),
  initialMode: "build",
  initialModel: "alpha/model",
  initialThoughtLevel: "low",
  submitPrompt: async (input, options) => {
    if (input === "/focus-prompt") {
      return {
        selection: {
          title: "Focus test prompts",
          prompt: "Choose an input.",
          items: [false, true].map((mask) => ({
            command: mask ? "/focus-secret" : "/focus-text",
            primary: mask ? "Masked input" : "Text input",
            input: {
              primary: mask ? "Focus masked prompt" : "Focus text prompt",
              secondary: "Enter a fixture value.",
              placeholder: mask ? "Secret placeholder" : "Text placeholder",
              mask
            }
          }))
        }
      };
    }
    if (input === "/focus-stream") {
      for (const text of ["Stream focus", " still running", " finished."]) {
        await Bun.sleep(120);
        await options.onEvent?.({
          type: "model.streaming",
          payload: { type: "text-delta", textDelta: text }
        });
      }
      return { response: "Stream focus still running finished." };
    }
    return { response: "Focus fixture response." };
  }
});
