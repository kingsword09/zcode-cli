import { expect, test } from "bun:test";

import { readWorkspaceDiff } from "../../packages/zcode-tui/src/workspace-diff.ts";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";

test.skipIf(process.platform === "win32")("scenario workspace exposes real writes to Git and resets them", async () => {
  await using workspace = await ScenarioWorkspace.create({
    files: {
      "README.md": "baseline\n",
      "src/existing.ts": "export const value = 1;\n"
    }
  });

  await workspace.write("src/existing.ts", "export const value = 2;\n");
  await workspace.write("src/created.ts", "export const created = true;\n");

  const changed = await readWorkspaceDiff(workspace.directory);
  expect(changed.error).toBeUndefined();
  expect(changed.files.map((file) => [file.filePath, file.status])).toEqual([
    ["src/created.ts", "untracked"],
    ["src/existing.ts", "modified"]
  ]);

  await workspace.reset();
  expect(await workspace.read("src/existing.ts")).toBe("export const value = 1;\n");
  const reset = await readWorkspaceDiff(workspace.directory);
  expect(reset).toEqual({ files: [], truncated: false });
});

test("scenario workspace rejects paths outside its isolated root", async () => {
  await using workspace = await ScenarioWorkspace.create();
  await expect(workspace.write("../escaped.txt", "not allowed\n")).rejects.toThrow("escapes the workspace");
});
