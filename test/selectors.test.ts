import { describe, expect, test } from "bun:test";

import {
  effortPicker,
  explicitModelRequest,
  isEffortPickerRequest,
  isModelPickerRequest,
  modelPicker,
  providerModelPicker
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

  test("extracts explicit model refs, aliases, and nested model IDs", () => {
    expect(explicitModelRequest("/model zai/glm-5.2")).toBe("zai/glm-5.2");
    expect(explicitModelRequest("/model custom/model")).toBe("custom/model");
    expect(explicitModelRequest("/model provider/org/model")).toBe("provider/org/model");
    // Bare picker and list forms are handled by showModelPicker.
    expect(explicitModelRequest("/model")).toBeUndefined();
    expect(explicitModelRequest("/model list")).toBeUndefined();
    // Runtime-resolved aliases also use the transient session switch path.
    expect(explicitModelRequest("/model main")).toBe("main");
    expect(explicitModelRequest("/model lite")).toBe("lite");
    expect(explicitModelRequest("/model opus")).toBe("opus");
    // Malformed refs fall through to the runtime's own error handling.
    expect(explicitModelRequest("/model not-a-ref")).toBeUndefined();
    expect(explicitModelRequest("/effort high")).toBeUndefined();
  });

  test("groups runtime modelOptions into a provider cascade", () => {
    // Runtime format: { modelId, providerId, providerLabel }
    const cascade = providerModelPicker([
      { modelId: "glm-5.2", providerId: "zai", providerLabel: "Z.AI", name: "GLM-5.2" },
      { modelId: "glm-5-turbo", providerId: "zai", providerLabel: "Z.AI", name: "GLM-5-Turbo" },
      { modelId: "glm-5.2", providerId: "bigmodel", providerLabel: "BigModel", name: "GLM-5.2" }
    ], "zai/glm-5.2");

    expect(cascade).not.toBeNull();
    expect(cascade!.providers.items).toHaveLength(2);
    expect(cascade!.providers.items[0]).toMatchObject({ value: "zai", label: "Z.AI" });
    expect(cascade!.providers.items[1]).toMatchObject({ value: "bigmodel", label: "BigModel" });
    expect(cascade!.providers.selectedIndex).toBe(0);

    const zaiGroup = cascade!.groups.find((g) => g.providerId === "zai")!;
    expect(zaiGroup.models.items).toHaveLength(2);
    expect(zaiGroup.models.items[0]).toMatchObject({
      value: "zai/glm-5.2",
      label: "GLM-5.2",
      command: "/model zai/glm-5.2"
    });
    expect(zaiGroup.models.items[0]?.description).toContain("current");
    expect(zaiGroup.models.selectedIndex).toBe(0);
  });

  test("accepts legacy { id, name } format alongside runtime format", () => {
    const cascade = providerModelPicker([
      { id: "zai/glm-5.2", name: "GLM-5.2" },
      { id: "custom/model" }
    ], "zai/glm-5.2");

    expect(cascade).not.toBeNull();
    expect(cascade!.providers.items).toHaveLength(2);
    expect(cascade!.groups.find((g) => g.providerId === "zai")!.models.items).toHaveLength(1);
    expect(cascade!.groups.find((g) => g.providerId === "custom")!.models.items[0]?.label).toBe("model");
  });

  test("returns null for empty or unparseable options", () => {
    expect(providerModelPicker([], "zai/glm-5.2")).toBeNull();
    expect(providerModelPicker([
      "plain-string",
      { noId: true }
    ], "zai/glm-5.2")).toBeNull();
  });

  test("deduplicates models within the same provider", () => {
    const cascade = providerModelPicker([
      { modelId: "glm-5.2", providerId: "zai" },
      { id: "zai/glm-5.2", name: "duplicate" }
    ], undefined);

    expect(cascade!.groups[0]!.models.items).toHaveLength(1);
  });

  test("falls back to providerName when providerLabel is absent (runtime format)", () => {
    const cascade = providerModelPicker([
      { modelId: "glm-5.2", providerId: "zai", providerName: "Z.AI" },
      { modelId: "glm-5.2", providerId: "bigmodel", providerName: "BigModel" }
    ], undefined);

    expect(cascade!.providers.items[0]?.label).toBe("Z.AI");
    expect(cascade!.providers.items[1]?.label).toBe("BigModel");
  });
});
