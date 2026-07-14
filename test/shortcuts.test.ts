import { describe, expect, test } from "bun:test";

import type { PickerSpec } from "../packages/zcode-tui/src/selectors.ts";
import {
  appliesToSetting,
  nextMode,
  nextPickerCommand,
  normalizedMode,
  settingTargetForCommand
} from "../packages/zcode-tui/src/shortcuts.ts";

describe("TUI shortcuts", () => {
  test("cycles every official mode through one Shift+Tab state", () => {
    expect(normalizedMode("invalid")).toBe("build");
    expect(nextMode("build")).toBe("edit");
    expect(nextMode("edit")).toBe("yolo");
    expect(nextMode("yolo")).toBe("plan");
    expect(nextMode("plan")).toBe("build");
  });

  test("isolates mode, model, and effort command results", () => {
    expect(settingTargetForCommand("/mode plan")).toBe("mode");
    expect(settingTargetForCommand(" /model local/glm ")).toBe("model");
    expect(settingTargetForCommand("/effort max")).toBe("effort");
    expect(settingTargetForCommand("/variant high")).toBe("effort");
    expect(settingTargetForCommand("/help")).toBeUndefined();

    expect(appliesToSetting("model", "model")).toBe(true);
    expect(appliesToSetting("model", "mode")).toBe(false);
    expect(appliesToSetting("effort", "model")).toBe(false);
    expect(appliesToSetting(undefined, "mode")).toBe(true);
  });

  test("cycles picker commands and wraps at the final item", () => {
    const picker: PickerSpec = {
      selectedIndex: 0,
      items: [
        { value: "alpha", label: "Alpha", command: "/set alpha" },
        { value: "beta", label: "Beta", command: "/set beta" }
      ]
    };

    expect(nextPickerCommand(picker, "alpha")).toBe("/set beta");
    expect(nextPickerCommand(picker, "beta")).toBe("/set alpha");
    expect(nextPickerCommand(picker, "missing")).toBe("/set alpha");
    expect(nextPickerCommand({ ...picker, items: picker.items.slice(0, 1) }, "alpha")).toBeUndefined();
  });
});
