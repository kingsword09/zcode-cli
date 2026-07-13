import { describe, expect, test } from "bun:test";

import {
  effortPicker,
  isEffortPickerRequest,
  isModelPickerRequest,
  modelPicker
} from "../packages/zcode-tui/src/selectors.ts";

describe("TUI selectors", () => {
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
});
