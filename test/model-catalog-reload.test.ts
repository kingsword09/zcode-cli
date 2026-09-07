import { describe, expect, test } from "bun:test";

import { patchRuntimeModelCatalogReload } from "../scripts/sync-runtime.ts";

const fixture = [
  'label(createConfig,"createConfig");label(()=>{},"setModelCatalogOverlay");',
  "function makeBridge(host){const bridge={};",
  "bridge.listModelOptions=async()=>(await getApp()).listModels?.()??[];",
  "return{listModelOptions:bridge.listModelOptions}}"
].join("");

describe("runtime model catalog reload bridge", () => {
  test("uses the native merged config and updates the registry without replacing the session", async () => {
    const targets = [
      { provider: "zai", model: "glm-6", apiKey: "user-key" },
      { provider: "custom", model: "project-lite", baseURL: "https://project.test" },
      { provider: "zai", model: "glm-7" }
    ];
    const overrides = { "zai/glm-6": { contextWindow: 1_000_000 } };
    let overlay: unknown;
    const app = {
      sessionId: "existing-session",
      setModelCatalogOverlay: async (value: unknown) => { overlay = value; },
      listModels: () => (overlay as { targets?: unknown[] })?.targets ?? []
    };
    let configOptions: unknown;
    const createConfig = (options: unknown) => {
      configOptions = options;
      return {
        config: { model: { main: targets[0], lite: targets[1], available: [targets[2]] }, modelCatalog: { overrides } }
      };
    };
    const patched = patchRuntimeModelCatalogReload(fixture);
    const makeBridge = new Function("getApp", "createConfig", `
      const label = (fn) => fn;
      ${patched}
      return makeBridge;
    `)(async () => app, createConfig);
    const host = {
      env: { FIXTURE: "1" }, cwd: () => "/workspace",
      projectConfigPath: "/project.json", userConfigPath: "/user.json", skipUserConfig: false
    };
    const bridge = makeBridge(host);
    expect(await bridge.reloadModelOptions()).toEqual(targets);
    expect(overlay).toEqual({ targets, catalogOverrides: overrides });
    expect(configOptions).toEqual({
      env: host.env, workingDirectory: "/workspace", projectConfigPath: "/project.json",
      userConfigPath: "/user.json", skipUserConfig: false
    });
    expect(app.sessionId).toBe("existing-session");
    expect(patchRuntimeModelCatalogReload(patched)).toBe(patched);
  });

  test("rejects incompatible bundles instead of silently omitting runtime refresh", () => {
    expect(() => patchRuntimeModelCatalogReload("unrecognized bundle")).toThrow("anchor missing");
    expect(() => patchRuntimeModelCatalogReload(fixture.replace('"createConfig"', '"renamed"'))).toThrow("anchor missing");
  });
});
