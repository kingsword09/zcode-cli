import { describe, expect, test } from "bun:test";

import { clientModes, initialClientMode, nextClientMode, nextMode, normalizedClientMode, normalizedMode, runtimeResultClientMode } from "../packages/zcode-tui/src/shortcuts.ts";
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

  test("env auto over a runtime genuinely in reserved auto is rejected, not re-labeled", () => {
    // The overlay is documented to ride only on a build runtime; a runtime in
    // its reserved `auto` denies every prompt, so the overlay must stay off.
    // (Regression: normalization first silently re-labeled it "build".)
    expect(initialClientMode("auto", "auto")).toBe("build");
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

describe("runtime-confirmed mode results (regression: typed /mode re-armed the classifier)", () => {
  test("reserved auto from the runtime rejects instead of re-entering client mode", () => {
    // Overlay was active (mode "auto"); a typed `/mode auto` confirms the
    // runtime's reserved value and exits the overlay. The confirmed result
    // must not leave the client mode at "auto" — the classifier gate reads
    // the mode alone.
    expect(runtimeResultClientMode("auto", "auto")).toBe("build");
    expect(runtimeResultClientMode("auto", "build")).toBe("build");
  });

  test("genuine confirmed values pass through; missing results keep the normalized current", () => {
    expect(runtimeResultClientMode("edit", "auto")).toBe("edit");
    expect(runtimeResultClientMode("yolo", "plan")).toBe("yolo");
    expect(runtimeResultClientMode(undefined, "yolo")).toBe("yolo");
    expect(runtimeResultClientMode("nope", "edit")).toBe("edit");
  });

  test("classifier gate cannot be re-armed by a runtime-confirmed reserved auto", () => {
    expect(shouldAutoClassify(runtimeResultClientMode("auto", "auto"), "Bash")).toBe(false);
  });
});
