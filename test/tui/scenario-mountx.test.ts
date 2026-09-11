import { expect, test } from "bun:test";

import {
  MountxWorkspaceBackend,
  probeScenarioMountx
} from "./harness/mountx-workspace-backend.ts";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";

test("Mountx reports whether this host has an explicit workspace transport", async () => {
  const probe = await probeScenarioMountx();

  expect(probe.platform).toBe(process.platform);
  expect(probe.preference.length).toBeGreaterThan(0);
  if (probe.chosen) {
    expect(probe[probe.chosen].usable).toBe(true);
  } else {
    expect(probe.reason).toBeTruthy();
  }
});

test.skipIf(process.env.ZCODE_TEST_MOUNTX !== "1")(
  "Mountx memory workspace supports real filesystem and Git processes",
  async () => {
    await using workspace = await ScenarioWorkspace.create({
      backend: new MountxWorkspaceBackend(),
      files: { "README.md": "mounted baseline\n" }
    });

    await workspace.write("mounted.txt", "mounted write\n");
    expect(await workspace.read("mounted.txt")).toBe("mounted write\n");
    expect((await workspace.git(["status", "--short"])).stdout).toContain("?? mounted.txt");
  },
  30_000
);
