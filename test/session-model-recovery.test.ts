import { expect, test } from "bun:test";
import { assertSessionModelReady, readSessionModelState } from "../src/session-model-recovery.ts";

const selection = { providerId: "zai", modelId: "glm-5.3", options: { reasoningLevel: "high" } };
const registry = {
  validateSelection(value: typeof selection | Omit<typeof selection, "options">) {
    if (value.providerId !== "zai") return { ok: false, code: "provider-not-found" };
    if (value.modelId !== "glm-5.3") return { ok: false, code: "model-not-found" };
    if (!("options" in value) || !value.options?.reasoningLevel) return { ok: false, code: "reasoning-level-missing" };
    return { ok: true };
  },
  getModel(provider: string, model: string) {
    return provider === "zai" && model === "glm-5.3" ? { config: { optionSpecs: { reasoningLevel: { values: ["disabled", "high"] } } } } : undefined;
  }
};

test("inspecting a new session without a saved entry does not request recovery", async () => {
  expect(await readSessionModelState({ registry, sessionId: "new", sessionStore: { sessionEntries: async () => [] } })).toBeUndefined();
  expect(() => assertSessionModelReady({ registry, sessionId: "new" })).not.toThrow();
});

test("the latest decoded selection is authoritative and inspection never mutates it", async () => {
  const data = structuredClone(selection);
  const result = await readSessionModelState({ registry, sessionId: "existing", sessionStore: {
    sessionEntries: async () => [{ data: { ...selection, providerId: "old" } }, { data }]
  } });
  expect(result).toMatchObject({ model: "zai/glm-5.3", thoughtLevel: "high", effortOptions: ["disabled", "high"] });
  expect(result?.issue).toBeUndefined();
  expect(data).toEqual(selection);
});

test.each([null, {}, { modelId: "glm-5.3" }])("a present but invalid entry requires a selection (%j)", async data => {
  const state = await readSessionModelState({ registry, sessionId: "existing", sessionStore: { sessionEntries: async () => [{ data }] } });
  expect(state?.issue?.code).toBe("selection-missing");
  expect(() => assertSessionModelReady({ registry, sessionId: "existing", restored: { selection: data } })).toThrow("/model");
});

test("a valid user replacement takes precedence over the originally restored broken selection", () => {
  expect(() => assertSessionModelReady({ registry, sessionId: "existing", currentSelection: selection,
    restored: { selection: { ...selection, providerId: "old" } } })).not.toThrow();
});

test("store failures remain errors rather than being mistaken for missing models", async () => {
  await expect(readSessionModelState({ registry, sessionId: "existing", sessionStore: {
    sessionEntries: async () => { throw new Error("Database is unavailable"); }
  } })).rejects.toThrow("Database is unavailable");
});
