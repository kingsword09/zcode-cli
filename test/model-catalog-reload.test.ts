import { describe, expect, test } from "bun:test";

import { patchRuntimeModelCatalogReload } from "../scripts/sync-runtime.ts";

describe("runtime model catalog reload bridge", () => {
  test("refreshes a registry in place and propagates refresh failures", async () => {
    const source = [
      'const kind="ProviderRegistryService";class Registry{refresh(reason="explicit"){}}',
      'function makeApp(ctx){return{listModels:label(()=>listRegistry(ctx.providerRegistry),"listModels")}}',
      'function makeBridge(host){const bridge={},pending=Promise.resolve(host);const create=async()=>{let state=await pending,selection=state?.modelSelectionConfigRepository?await state.modelSelectionConfigRepository.read():undefined};bridge.listModelOptions=async()=>(await getApp()).listModels?.()??[];',
      'bridge.setTransientModel=async model=>(await getApp()).setModel(model,{transient:true});',
      'return{listModelOptions:bridge.listModelOptions}}'
    ].join("");
    const patched = patchRuntimeModelCatalogReload(source);
    let models = ["old"], refreshes = 0;
    let failure: Error | undefined;
    const registry = {
      async refresh(reason: string) {
        expect(reason).toBe("cli-model-catalog");
        if (failure) throw failure;
        models = ["new"];
        refreshes++;
      }
    };
    let saved = { providerId: "custom", modelId: "old" };
    const repository = {
      read: async () => saved,
      saveConfiguredDefault: async (value: typeof saved) => { saved = value; }
    };
    const { app, bridge } = new Function("listRegistry", "ctx", "repository", `
      const label = (fn) => fn;
      ${patched}
      const app = makeApp(ctx), getApp = async () => app;
      app.getModelOption = (selection) => selection.modelId === "new";
      app.setModel = async (model, options) => ({model, options});
      return {app, bridge: makeBridge({modelSelectionConfigRepository: repository})};
    `)(() => models, { providerRegistry: registry, sessionId: "existing" }, repository);
    expect(await bridge.listModelOptions()).toEqual(["old"]);
    expect(await bridge.reloadModelOptions()).toEqual(["new"]);
    expect(await bridge.listModelOptions()).toEqual(app.listModels());
    expect(refreshes).toBe(1);
    expect(await bridge.readDefaultModel()).toBe("custom/old");
    expect(await bridge.setDefaultModel("custom/new")).toMatchObject({ model: "custom/new", options: { transient: true } });
    expect(saved).toEqual({ providerId: "custom", modelId: "new" });
    await expect(bridge.setDefaultModel("custom/missing")).rejects.toThrow("Unknown default model");
    expect(await bridge.readDefaultModel()).toBe("custom/new");
    failure = new Error("invalid catalog");
    await expect(bridge.reloadModelOptions()).rejects.toThrow("invalid catalog");
    expect(patchRuntimeModelCatalogReload(patched)).toBe(patched);
    expect(() => patchRuntimeModelCatalogReload(source.replace('reason="explicit"', 'reason'))).toThrow("registry refresh anchor");
  });

  test("rejects incompatible bundles instead of silently omitting runtime refresh", () => {
    expect(() => patchRuntimeModelCatalogReload("unrecognized bundle")).toThrow("anchor missing");
  });
});
