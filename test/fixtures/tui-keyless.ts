import { runTui } from "../../packages/zcode-tui/src/index.ts";

await runTui({
  initialModel: "zai/glm-5.3-flash",
  initialThoughtLevel: "low",
  workspaceDirectory: process.env.HOME,
  submitPrompt: async () => {
    throw new Error("UNEXPECTED_MODEL_SUBMISSION");
  }
});
