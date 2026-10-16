import { symlink } from "node:fs/promises";
import { join } from "node:path";

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

test("scenario shell blocks symlink traversal and oversized output", async () => {
  await using workspace = await ScenarioWorkspace.create();
  await symlink("/etc/passwd", join(workspace.directory, "host-file"));

  const shell = createScenarioShell({ workspaceDirectory: workspace.directory });

  const symlinkRead = await shell.exec("cat host-file", { expectedExitCode: 1 });
  expect(symlinkRead.stderr).toContain("No such file");

  const boundedShell = createScenarioShell({
    executionLimits: { maxOutputSize: 16 },
    workspaceDirectory: workspace.directory
  });
  await expect(boundedShell.exec("printf 12345678901234567890")).rejects.toThrow(
    "expected exit 0, received 126"
  );
});

test("scenario shell rejects an empty command allowlist", async () => {
  await using workspace = await ScenarioWorkspace.create();

  expect(() => createScenarioShell({
    commands: [],
    workspaceDirectory: workspace.directory
  })).toThrow("requires at least one allowed command");
});

test("scenario shell contains floating-point precision failures and remains usable", async () => {
  await using workspace = await ScenarioWorkspace.create();
  const shell = createScenarioShell({ workspaceDirectory: workspace.directory });

  for (const specifier of ["e", "f", "g"]) {
    expect((await shell.exec(`printf '%.100${specifier}' 1.25`)).stdout.length).toBeLessThanOrEqual(107);
    // just-bash implements ordinary float formats itself and contains their
    // RangeErrors at the command boundary; sprintf-js handles fallback formats.
    for (const command of [
      `printf '%.101${specifier}' 1.25`,
      `printf '%.*${specifier}' 101 1.25`,
      `printf -v formatted '%.*${specifier}' 101 1.25`
    ]) {
      const result = await shell.exec(command, { expectedExitCode: 1 });
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^printf: .+argument must be between /u);
    }
  }
  expect(await shell.exec("printf '%.0g %.0f' 1.25 1.25")).toMatchObject({
    exitCode: 0, stdout: "1 1", stderr: ""
  });
  expect((await shell.exec("echo ready")).stdout).toBe("ready\n");
});

test("scenario shell rejects excessive awk printf and sprintf precision before formatting", async () => {
  await using workspace = await ScenarioWorkspace.create();
  const shell = createScenarioShell({ workspaceDirectory: workspace.directory, commands: ["awk"] });
  for (const expression of ['printf "%.101f", 1.25', 'print sprintf("%.101f", 1.25)']) {
    const result = await shell.exec(`awk 'BEGIN { ${expression} }'`, { expectedExitCode: 126 });
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("floating-point precision limit exceeded (100 digits)");
  }
  expect((await shell.exec(`awk 'BEGIN { printf "%.2f", 1.25 }'`)).stdout).toBe("1.25");
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
