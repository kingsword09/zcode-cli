import { access } from "node:fs/promises";

import { expect, test } from "bun:test";

import { readWorkspaceDiff } from "../../packages/zcode-tui/src/workspace-diff.ts";
import {
  ScenarioWorkspace,
  type ScenarioWorkspaceBackend
} from "./harness/scenario-workspace.ts";
import { ScenarioJournal } from "./harness/scenario-journal.ts";

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

test("scenario workspace mounts and disposes an optional backend exactly once", async () => {
  let mountedDirectory = "";
  let disposeCalls = 0;
  const backend: ScenarioWorkspaceBackend = {
    name: "fixture-backend",
    async mount(directory) {
      mountedDirectory = directory;
    },
    async dispose() {
      disposeCalls += 1;
    }
  };
  const workspace = await ScenarioWorkspace.create({ backend });

  expect(mountedDirectory).toBe(workspace.directory);
  expect(workspace.backendName).toBe("fixture-backend");
  await workspace.dispose();
  await workspace.dispose();
  expect(disposeCalls).toBe(1);
});

test("scenario workspace removes a partially initialized root when setup fails", async () => {
  const journal = new ScenarioJournal();

  await expect(ScenarioWorkspace.create({
    journal,
    files: { "../escaped.txt": "not allowed\n" }
  })).rejects.toThrow("escapes the workspace");

  const createEntry = journal.entries().find((entry) => entry.channel === "workspace.create");
  expect(createEntry).toBeDefined();
  await expect(access(String((createEntry?.detail as { root: string }).root))).rejects.toThrow();
  expect(journal.entries().at(-1)?.channel).toBe("workspace.dispose");
});

test("scenario workspace disposal is idempotent", async () => {
  const workspace = await ScenarioWorkspace.create();
  await workspace.dispose();
  await expect(workspace.dispose()).resolves.toBeUndefined();
});
