import { describe, expect, test } from "bun:test";

import {
  chooseArtifact,
  manifestUrl,
  parseArgs,
  patchRuntimeTuiGoalBridge
} from "../scripts/sync-runtime.ts";

describe("runtime synchronization", () => {
  test("parseArgs uses the CI-safe Linux default", () => {
    expect(parseArgs([])).toEqual({ platform: "linux", arch: "x64" });
    expect(parseArgs(["--platform", "win32", "--arch", "arm64"])).toEqual({
      platform: "win32",
      arch: "arm64"
    });
  });

  test("manifestUrl maps supported updater channels", () => {
    expect(manifestUrl("linux", "x64")).toMatch(/update\/linux\/x64\/latest-linux\.yml$/);
    expect(manifestUrl("darwin", "arm64")).toMatch(/update\/mac\/arm64\/latest-mac\.yml$/);
    expect(manifestUrl("win32", "x64")).toMatch(/update\/win\/x64\/latest\.yml$/);
  });

  test("chooseArtifact selects an extractable installer", () => {
    const manifest = {
      files: [
        { url: "ZCode.AppImage", sha512: "one" },
        { url: "ZCode.deb", sha512: "two" }
      ]
    };
    expect(chooseArtifact(manifest, "linux").url).toBe("ZCode.deb");
    expect(() => chooseArtifact({ files: [] }, "linux")).toThrow(/No \.deb artifact/);
  });

  test("injects a structured goal reader into the official TUI adapter", () => {
    const runtime = [
      "E.sendInput=async(A,$)=>{return Kvt(await S(),D,O1(t))},",
      "E.recallPreviousInput=async A=>await(await S()).recallPreviousInputHistory?.(A)??null,",
      "CVr(E,S,r);",
      "return c({recallPreviousInput:g.recallPreviousInput,sendInput:g.sendInput,submitPrompt:g})"
    ].join("");
    const patched = patchRuntimeTuiGoalBridge(runtime);

    expect(patched).toContain("E.readGoal=async()=>await(await S()).readTarget?.()??null");
    expect(patched).toContain("readGoal:g.readGoal,recallPreviousInput:g.recallPreviousInput");
    expect(patchRuntimeTuiGoalBridge(patched)).toBe(patched);
    expect(() => patchRuntimeTuiGoalBridge("incompatible runtime")).toThrow(/incompatible/);
  });
});
