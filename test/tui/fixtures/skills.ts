import { runTui } from "../../../packages/zcode-tui/src/index.ts";

await runTui({
  initialModel: "scenario/model",
  workspaceDirectory: process.cwd(),
  slashCommands: [{ name: "deploy", description: "Custom deploy command", aliases: ["ship"] }],
  listSkills: async () => ({ skills: [
    { name: "orchestration", description: "Coordinate skill tasks" },
    { name: "orchestration", description: "Duplicate skill" },
    { name: "audit", qualifiedName: "plugin:audit", description: "Review code" },
    { name: "deploy" }, { name: "ship" }
  ] }),
  loadSessionTranscript: async () => [{ role: "agent", content: "Skill scenario ready" }],
  submitPrompt: async (input) => ({ response: `Runtime received: ${String(input)}` })
});
