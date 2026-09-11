import { expect, test } from "bun:test";

import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { createScenarioShell } from "./runtime/scenario-shell.ts";

test("scenario shell writes through the isolated workspace and real Git sees the result", async () => {
  await using workspace = await ScenarioWorkspace.create({
    files: { "input.txt": "beta\nalpha\n" }
  });
  const shell = createScenarioShell({
    journalPath: workspace.runtimeJournalPath,
    workspaceDirectory: workspace.directory
  });

  const result = await shell.exec(
    "mkdir -p reports && sort input.txt | tee reports/sorted.txt | wc -l"
  );

  expect(result).toMatchObject({ exitCode: 0, stderr: "", stdout: "2\n" });
  expect(await workspace.read("reports/sorted.txt")).toBe("alpha\nbeta\n");
  expect((await workspace.git(["status", "--short"])).stdout).toContain("?? reports/");
  expect(await workspace.readRuntimeJournal()).toContain('"kind":"shell.finish"');
});

test("scenario shell exposes only allowlisted commands without host or network access", async () => {
  await using workspace = await ScenarioWorkspace.create();
  const shell = createScenarioShell({ workspaceDirectory: workspace.directory });

  await expect(shell.exec("git status")).rejects.toThrow("received 127");
  await expect(shell.exec("curl https://example.com")).rejects.toThrow("received 127");
  const outside = await shell.exec("cat /etc/passwd", { expectedExitCode: 1 });
  expect(outside.stderr).toContain("No such file");
});

test("scenario shell supports expected failures, cancellation, and bounded execution", async () => {
  await using workspace = await ScenarioWorkspace.create();
  const shell = createScenarioShell({
    executionLimits: {
      maxExecutionTimeMs: 50,
      maxLoopIterations: 20
    },
    workspaceDirectory: workspace.directory
  });

  await expect(shell.exec("while true; do echo loop >/dev/null; done")).rejects.toThrow();

  const controller = new AbortController();
  controller.abort(new Error("scenario cancelled"));
  await expect(shell.exec("echo unreachable", {
    signal: controller.signal
  })).rejects.toThrow();
});

test("scenario shell rejects ambiguous journals and invalid exit expectations", async () => {
  await using workspace = await ScenarioWorkspace.create();
  const journalPath = workspace.runtimeJournalPath;
  expect(() => createScenarioShell({
    journal: createScenarioShell({
      workspaceDirectory: workspace.directory
    }).journal,
    journalPath,
    workspaceDirectory: workspace.directory
  })).toThrow("either journal or journalPath");

  const shell = createScenarioShell({ workspaceDirectory: workspace.directory });
  await expect(shell.exec("true", { expectedExitCode: [] })).rejects.toThrow(
    "must contain valid exit codes"
  );
});
