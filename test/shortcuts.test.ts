import { describe, expect, test } from "bun:test";

import type { PickerSpec } from "../packages/zcode-tui/src/selectors.ts";
import {
  executionMode,
  nextAutonomyMode,
  nextPickerCommand,
  toggledWorkMode
} from "../packages/zcode-tui/src/shortcuts.ts";

describe("TUI shortcuts", () => {
  test("toggles plan mode and cycles official autonomy modes", () => {
    expect(executionMode("plan")).toBe("build");
    expect(executionMode("yolo")).toBe("yolo");
    expect(toggledWorkMode("build", "edit")).toBe("plan");
    expect(toggledWorkMode("plan", "edit")).toBe("edit");
    expect(nextAutonomyMode("plan", "edit")).toBe("edit");
    expect(nextAutonomyMode("build", "build")).toBe("edit");
    expect(nextAutonomyMode("edit", "edit")).toBe("yolo");
    expect(nextAutonomyMode("yolo", "yolo")).toBe("build");
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
