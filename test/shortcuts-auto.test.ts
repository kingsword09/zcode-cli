import { describe, expect, test } from "bun:test";

import { clientModes, initialClientMode, nextClientMode, nextMode, normalizedClientMode, normalizedMode } from "../packages/zcode-tui/src/shortcuts.ts";
import { shouldAutoClassify } from "../packages/zcode-tui/src/auto-permissions.ts";

describe("auto client mode", () => {
  test("auto sits in the client cycle between edit and yolo; official cycle unchanged", () => {
    expect(clientModes).toEqual(["build", "edit", "auto", "yolo", "plan"]);
    expect(nextClientMode("edit")).toBe("auto");
    expect(nextClientMode("auto")).toBe("yolo");
    expect(nextMode("edit")).toBe("yolo");
    expect(nextMode("yolo")).toBe("plan");
  });

  test("runtime mode validation still rejects auto (runtime owns its enum)", () => {
    expect(normalizedMode("auto")).toBe("build");
    expect(normalizedMode("yolo")).toBe("yolo");
  });

  test("boot mode selection honors the client-mode env only over a build runtime", () => {
    expect(initialClientMode(undefined, "auto")).toBe("auto");
    expect(initialClientMode("build", "auto")).toBe("auto");
    expect(initialClientMode("yolo", "auto")).toBe("yolo");
    expect(initialClientMode("auto", undefined)).toBe("build");
    expect(initialClientMode("plan", undefined)).toBe("plan");
    // Only "auto" is a supported env value; anything else means no overlay.
    expect(initialClientMode(undefined, "yolo")).toBe("build");
    expect(initialClientMode(undefined, undefined)).toBe("build");
  });

  test("client mode validation accepts auto", () => {
    expect(normalizedClientMode("auto")).toBe("auto");
    expect(normalizedClientMode("nope")).toBe("build");
  });

  test("classification gate is on only for auto mode, ordinary tools", () => {
    expect(shouldAutoClassify("auto", "Bash")).toBe(true);
    expect(shouldAutoClassify("build", "Bash")).toBe(false);
    expect(shouldAutoClassify("yolo", "Bash")).toBe(false);
    expect(shouldAutoClassify("auto", "AskUserQuestion")).toBe(false);
    expect(shouldAutoClassify("auto", "ExitPlanMode")).toBe(false);
  });
});
