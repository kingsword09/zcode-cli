import { describe, expect, test } from "bun:test";

import {
  effortPicker,
  explicitModelRequest,
  isEffortPickerRequest,
  isModePickerRequest,
  isModelPickerRequest,
  modePicker,
  modelPicker,
  sessionRenameRequest
} from "../packages/zcode-tui/src/selectors.ts";

describe("TUI selectors", () => {
  test("reads registry model references in the model picker", () => {
    const options = [
      { ref: { providerId: "account:zai-individual-coding-plan", modelId: "GLM-5.3" }, label: "GLM-5.3", providerLabel: "Z.AI" },
      { ref: { providerId: "custom", modelId: "org/model" }, label: "Custom" }
    ];
    const current = "custom/org/model";
    expect(modelPicker(options, current).items.map((item) => item.value)).toEqual([
      "account:zai-individual-coding-plan/GLM-5.3", current
    ]);
    expect(modelPicker(options, current).selectedIndex).toBe(1);
  });

  test("builds and selects model choices from upstream model entries", () => {
    const picker = modelPicker([
      { alias: "main", id: "zai/glm-5.2", name: "GLM-5.2" },
      { alias: "lite", id: "zai/glm-5-turbo", name: "GLM-5 Turbo" },
      { id: "zai/glm-5.2", name: "duplicate" },
      "custom/model"
    ], "zai/glm-5-turbo");

    expect(picker.selectedIndex).toBe(1);
    expect(picker.items).toEqual([
      {
        value: "zai/glm-5.2",
        label: "zai/glm-5.2",
        description: "GLM-5.2 · main",
        command: "/model zai/glm-5.2"
      },
      {
        value: "zai/glm-5-turbo",
        label: "zai/glm-5-turbo",
        description: "GLM-5 Turbo · lite · current",
        command: "/model zai/glm-5-turbo"
      },
      {
        value: "custom/model",
        label: "custom/model",
        description: undefined,
        command: "/model custom/model"
      }
    ]);
  });

  test("builds localized effort choices and tracks the current level", () => {
    const picker = effortPicker([
      { id: "low", label: "Low" },
      { id: "high", label: "High" }
    ], "high");

    expect(picker.selectedIndex).toBe(1);
    expect(picker.items[1]).toEqual({
      value: "high",
      label: "High",
      description: "high · current",
      command: "/effort high"
    });
  });

  test("opens pickers only for list-style slash commands", () => {
    expect(isModelPickerRequest("/model")).toBe(true);
    expect(isModelPickerRequest("/MODEL list")).toBe(true);
    expect(isModelPickerRequest("/model zai/glm-5.2")).toBe(false);
    expect(isEffortPickerRequest("/effort")).toBe(true);
    expect(isEffortPickerRequest("/variant list")).toBe(true);
    expect(isEffortPickerRequest("/effort high")).toBe(false);
  });

  test("extracts explicit model refs, aliases, and nested model IDs", () => {
    expect(explicitModelRequest("/model zai/glm-5.2")).toBe("zai/glm-5.2");
    expect(explicitModelRequest("/model custom/model")).toBe("custom/model");
    expect(explicitModelRequest("/model provider/org/model")).toBe("provider/org/model");
    // Bare picker and list forms are handled by showModelPicker.
    expect(explicitModelRequest("/model")).toBeUndefined();
    expect(explicitModelRequest("/model list")).toBeUndefined();
    // Runtime-resolved aliases also use the transient session switch path.
    expect(explicitModelRequest("/model main")).toBe("main");
    expect(explicitModelRequest("/model lite")).toBeUndefined();
    expect(explicitModelRequest("/model opus")).toBeUndefined();
    // Malformed refs fall through to the runtime's own error handling.
    expect(explicitModelRequest("/model not-a-ref")).toBeUndefined();
    expect(explicitModelRequest("/effort high")).toBeUndefined();
  });

  test("builds mode choices with the current mode preselected", () => {
    const picker = modePicker("edit");
    expect(picker.selectedIndex).toBe(1);
    expect(picker.items.map(item => item.value)).toEqual(["build", "edit", "guarded", "yolo"]);
    expect(picker.items[1]?.description).toBe("Edit automatically · current");
    expect(modePicker("edit", ["build", "edit", "auto", "yolo", "plan"]).items.map(item => item.value))
      .toEqual(["build", "edit", "yolo"]);
    const guarded = modePicker("guarded");
    expect(guarded.selectedIndex).toBe(2);
    expect(guarded.items[2]?.description).toBe("Autonomous · ask before risky commands · current");
    expect(guarded.items[2]?.command).toBe("/mode guarded");

    // Unknown current mode falls back to index 0 with no current marker.
    const fallback = modePicker(undefined);
    expect(fallback.selectedIndex).toBe(0);
    expect(fallback.items.every((item) => !item.description?.includes("current"))).toBe(true);

    // Restricted mode list (e.g. runtime-reported availability).
    const restricted = modePicker("yolo", ["build", "yolo"]);
    expect(restricted.items.map((item) => item.value)).toEqual(["build", "yolo"]);
    expect(restricted.selectedIndex).toBe(1);

    expect(isModePickerRequest("/mode")).toBe(true);
    expect(isModePickerRequest("/MODE list")).toBe(true);
    expect(isModePickerRequest("/mode plan")).toBe(false);
  });

});

describe("sessionRenameRequest", () => {
  test("parses explicit rename titles", () => {
    expect(sessionRenameRequest("/rename Sidebar drag fix")).toBe("Sidebar drag fix");
    expect(sessionRenameRequest("  /rename   spaced   out  ")).toBe("spaced out");
  });

  test("returns an empty title for the bare usage form", () => {
    expect(sessionRenameRequest("/rename")).toBe("");
    expect(sessionRenameRequest("/rename ")).toBe("");
    expect(sessionRenameRequest("/rename \x1b]0;INJECTED\x07")).toBe("");
  });

  test("removes terminal controls before persisting a title", () => {
    expect(sessionRenameRequest("/rename safe\x07\x1b]0;INJECTED\x07")).toBe("safe");
    expect(sessionRenameRequest("/rename safe\u009c\u009d0;INJECTED\u009c")).toBe("safe");
    expect(sessionRenameRequest("/rename 修复\x1b[31m登录\x1b[0m  ✓")).toBe("修复登录 ✓");
  });

  test("ignores other commands and conversation text", () => {
    expect(sessionRenameRequest("/model zai/glm-5.2")).toBeUndefined();
    expect(sessionRenameRequest("what does /rename do")).toBeUndefined();
  });
});
