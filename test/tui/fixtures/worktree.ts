import { appendFileSync } from "node:fs";
import { runTui } from "../../../packages/zcode-tui/src/index.ts";

const record = (entry: unknown) => appendFileSync(
  process.env.ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL!,
  `${JSON.stringify(entry)}\n`
);

await runTui({
  initialModel: "scenario/model",
  workspaceDirectory: process.cwd(),
  loadSessionTranscript: async () => [],
  submitPrompt: async (input) => {
    record({ kind: "native-command", input: String(input) });
    return { response: "Native command handled" };
  },
  createManagedWorktree: async (directory) => {
    record({ kind: "create", directory });
    return {
      bucket: "1a2b",
      path: `${directory}/.zcode/worktrees/1a2b/${directory.split("/").at(-1)}`,
      head: "fixture-head",
      dirty: false
    };
  },
  listManagedWorktrees: async (directory) => [{
    bucket: "1a2b",
    path: `${directory}/.zcode/worktrees/1a2b/${directory.split("/").at(-1)}`,
    head: "fixture-head",
    dirty: true
  }],
  restartTuiAtDirectory: (directory) => record({ kind: "restart", directory })
});
