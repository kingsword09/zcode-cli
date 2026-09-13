import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { runManualTuiScenario } from "./harness/run-scenario.ts";
import type { TuiScenario } from "./scenarios/types.ts";

test("manual TUI runner returns the fixture exit code and disposes its workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-manual-runner-"));
  const fixture = join(directory, "fixture.ts");
  await writeFile(fixture, [
    'import { writeFile } from "node:fs/promises";',
    'import { join } from "node:path";',
    'await writeFile(join(import.meta.dir, "observed-cwd.txt"), process.cwd(), "utf8");',
    "process.exit(7);",
    ""
  ].join("\n"), "utf8");

  const scenario: TuiScenario = {
    name: "manual-exit-code",
    description: "manual runner test fixture",
    fixture,
    files: { "baseline.txt": "baseline\n" },
    async run() {}
  };

  try {
    await expect(runManualTuiScenario(scenario)).resolves.toBe(7);
    const workspaceDirectory = await readFile(join(directory, "observed-cwd.txt"), "utf8");
    await expect(access(workspaceDirectory)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
