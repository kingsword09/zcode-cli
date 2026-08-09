import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRuntimePluginReferenceLister,
  isPluginReferenceValue,
  normalizePluginReferenceEntries,
  PluginReferenceCatalog,
  pluginReferenceMarkdown,
  pluginReferenceSuggestions
} from "../packages/zcode-tui/src/plugin-references.ts";

const browserPlugin = {
  conflictingPluginIds: [],
  enabled: true,
  marketplace: "zcode-plugins-official",
  mcpServerNames: [],
  name: "browser-use",
  pluginId: "browser-use@zcode-plugins-official",
  skillQualifiedNames: ["browser-use:control-browser", "browser-use:web-gui-tester"],
  subagentNames: []
};

describe("runtime Plugin references", () => {
  test("keeps only unambiguous enabled plugins with referenceable capabilities", () => {
    expect(normalizePluginReferenceEntries({
      authority: "workspace",
      plugins: [
        browserPlugin,
        { ...browserPlugin, pluginId: "disabled@example", name: "disabled", marketplace: "example", enabled: false },
        {
          ...browserPlugin,
          pluginId: "ambiguous@example",
          name: "ambiguous",
          marketplace: "example",
          conflictingPluginIds: ["other@example"]
        },
        { ...browserPlugin, pluginId: "empty@example", name: "empty", marketplace: "example", skillQualifiedNames: [] },
        { ...browserPlugin, pluginId: "bad-id", name: "bad", marketplace: "example" }
      ]
    })).toEqual([{
      description: "Plugin | zcode-plugins-official | 2 skills",
      marketplace: "zcode-plugins-official",
      name: "browser-use",
      pluginId: "browser-use@zcode-plugins-official"
    }]);
  });

  test("inserts the runtime-native plugin Markdown link", () => {
    const plugin = normalizePluginReferenceEntries({ plugins: [browserPlugin] })[0]!;
    const value = pluginReferenceMarkdown(plugin);
    expect(value).toBe("[@browser-use](plugin://browser-use@zcode-plugins-official)");
    expect(isPluginReferenceValue(value)).toBe(true);
    expect(isPluginReferenceValue("@browser-use")).toBe(false);
    expect(pluginReferenceSuggestions([plugin], "browser", 20)).toEqual([{
      value,
      label: "@browser-use",
      description: "Plugin | zcode-plugins-official | 2 skills"
    }]);
  });

  test("caches successful discovery and retries transient catalog errors", async () => {
    let calls = 0;
    const catalog = new PluginReferenceCatalog(async () => {
      calls += 1;
      if (calls > 1) throw new Error("unavailable");
      return { plugins: [browserPlugin] };
    });

    expect(await catalog.list()).toHaveLength(1);
    expect(await catalog.list()).toHaveLength(1);
    expect(calls).toBe(1);

    let transientCalls = 0;
    const unavailable = new PluginReferenceCatalog(async () => {
      transientCalls += 1;
      if (transientCalls === 1) throw new Error("unavailable");
      return { plugins: [browserPlugin] };
    });
    expect(await unavailable.list()).toEqual([]);
    expect(await unavailable.list()).toHaveLength(1);
    expect(transientCalls).toBe(2);
  });

  test("queries app-server directly from the running runtime without a bridge patch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-plugin-reference-runtime-"));
    const runtime = join(directory, "zcode.cjs");
    await writeFile(runtime, `
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const request = JSON.parse(input.trim());
        console.log(JSON.stringify({ id: request.id, result: {
          authority: "workspace",
          plugins: [],
          received: request
        } }));
      });
    `);
    try {
      const list = createRuntimePluginReferenceLister(directory, {}, [process.execPath, runtime]);
      expect(list).toBeFunction();
      expect(await list!()).toMatchObject({
        authority: "workspace",
        received: {
          method: "plugins/referenceCatalog",
          params: {
            workspace: { workspacePath: directory, workspaceKey: directory }
          }
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
