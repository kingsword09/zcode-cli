import { expect, test } from "bun:test";

import {
  hasRuntimeResolvedContextWindow as has,
  patchRuntimeResolvedContextWindow as patch
} from "../scripts/runtime-context-window-patches.ts";
import { applyRuntimePatchPlan, runtimePatchPlan } from "../scripts/sync-runtime.ts";

interface FixtureState {
  contextWindow: number;
  contextUsed: number;
}

interface FixtureModel {
  providerId: string;
  modelId: string;
  contextWindow?: number;
  current: boolean;
}

interface FixtureContext {
  eventStore: { getEvents(sessionId?: string): Promise<unknown[]> };
  eventReducer: { reduce(events: unknown[]): FixtureState };
  modelCatalogPort?: { listModels(): FixtureModel[] };
  sessionId: string;
}

/** Mirrors the runtime's projection source: the reduced event state for a session. */
function fixture(projection = "NBo"): string {
  return `const label=(fn,name)=>fn;
async function ${projection}(){let events=await this.eventStore.getEvents(this.sessionId);return this.eventReducer.reduce(events)}
label(${projection},"rebuildProjection");
return {rebuildProjection:${projection}};`;
}

function load(source: string) {
  return new Function(source)() as { rebuildProjection(): Promise<FixtureState> };
}

const recorded: FixtureState = { contextWindow: 200_000, contextUsed: 1_234 };
const resolvedWindow = 1_000_000;

function context(models: FixtureModel[] | undefined): FixtureContext {
  return {
    sessionId: "sess_fixture",
    eventStore: { getEvents: async () => [] },
    eventReducer: { reduce: () => recorded },
    ...models === undefined ? {} : { modelCatalogPort: { listModels: () => models } }
  };
}

const current = (contextWindow?: number): FixtureModel => ({
  providerId: "probe", modelId: "probe-model", current: true, ...contextWindow === undefined ? {} : { contextWindow }
});

test("projects the resolved context window from the model catalog port", async () => {
  const patched = patch(fixture());
  expect(has(fixture())).toBe(false);
  expect(has(patched)).toBe(true);
  expect(patch(patched)).toBe(patched);
  const result = await load(patched).rebuildProjection.call(context([current(resolvedWindow)]));
  expect(result).toEqual({ contextWindow: resolvedWindow, contextUsed: 1_234 });
  expect(recorded).toEqual({ contextWindow: 200_000, contextUsed: 1_234 });
});

test("keeps the reduced projection when no window is resolved", async () => {
  const projection = load(patch(fixture())).rebuildProjection;
  const cases = [
    context(undefined),
    context([]),
    context([current()]),
    context([{ ...current(resolvedWindow), current: false }]),
    context([current(0)])
  ];
  for (const item of cases) expect(await projection.call(item)).toMatchObject({ contextWindow: 200_000 });
});

test("fails loudly when the projection source changes shape", () => {
  expect(() => patch("const runtime = {};")).toThrow("rebuildProjection label missing or ambiguous");
  expect(() => patch(`${fixture()}\nlabel(other,"rebuildProjection");`)).toThrow("rebuildProjection label missing or ambiguous");
  expect(() => patch(fixture().replace("function NBo()", "function IOther()")))
    .toThrow("rebuildProjection function missing or ambiguous");
  expect(() => patch(fixture().replace("function NBo()", "function NBo(value)")))
    .toThrow("rebuildProjection signature changed");
  for (const replaced of [
    "return this.snapshot(events)",
    "return this.eventReducer.snapshot(events)",
    "return this.eventReducer.reduce()",
    "return this.eventReducer.reduce(...events)"
  ]) {
    expect(() => patch(fixture().replace("return this.eventReducer.reduce(events)", replaced)))
      .toThrow("rebuildProjection no longer returns the reduced event state");
  }
});

test("applies through the runtime patch plan idempotently", () => {
  const entry = runtimePatchPlan.find(item => item.id === "resolved-context-window");
  expect(entry?.requirement).toBe("required");
  const first = applyRuntimePatchPlan(fixture(), [entry!]);
  expect(first.reports[0]?.status).toBe("applied");
  expect(applyRuntimePatchPlan(first.runtime, [entry!]).reports[0]?.status).toBe("already_present");
  expect(() => applyRuntimePatchPlan("incompatible runtime", [entry!]))
    .toThrow("Required runtime patch resolved-context-window failed");
});
