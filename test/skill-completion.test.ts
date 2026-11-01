import { expect, test } from "bun:test";
import { SkillCatalog } from "../packages/zcode-tui/src/skills.ts";
import { WorkspaceAutocompleteProvider } from "../packages/zcode-tui/src/workspace-autocomplete.ts";

test("slash completion discovers and deduplicates skills without shadowing commands or aliases", async () => {
  const provider = new WorkspaceAutocompleteProvider(
    [{ name: "deploy", description: "Custom command" }, { name: "effort" }],
    process.cwd(), undefined,
    async () => ({ skills: [
      ...Array.from({ length: 111 }, (_, index) => ({ name: `example-${index}` })),
      { name: "orchestration", description: "Coordinate work" },
      { name: "orchestration", description: "Duplicate from shared root" },
      { name: "audit", qualifiedName: "plugin:audit", description: "Review changes" },
      { name: "deploy" }, { name: "EFFORT" }, { name: "variant" }, { name: "quit" }
    ] }), undefined, ["variant"]
  );
  const options = { signal: new AbortController().signal };
  const all = await provider.getSuggestions(["/"], 0, 1, options);
  expect(all?.items.filter((item) => item.value === "orchestration")).toEqual([
    { value: "orchestration", label: "orchestration", description: "Skill: Coordinate work" }
  ]);
  expect(all?.items.find((item) => item.value === "deploy")?.description).toBe("Custom command");
  expect(all?.items.map((item) => item.value)).not.toContain("EFFORT");
  expect(all?.items.map((item) => item.value)).not.toContain("variant");
  expect(all?.items.map((item) => item.value)).not.toContain("quit");
  const filtered = await provider.getSuggestions(["/orch"], 0, 5, options);
  expect(filtered?.items.map((item) => item.value)).toEqual(["orchestration"]);
  expect(provider.applyCompletion(["  /orch"], 0, 7, filtered!.items[0]!, filtered!.prefix).lines)
    .toEqual(["  /orchestration "]);
  const qualified = await provider.getSuggestions(["/plugin:a"], 0, 9, options);
  expect(qualified?.items[0]?.value).toBe("plugin:audit");
});

test("skill discovery failure preserves slash commands and cancellation drops results", async () => {
  const provider = new WorkspaceAutocompleteProvider(
    [{ name: "help" }], process.cwd(), undefined,
    async () => { throw new Error("Unavailable catalog"); }
  );
  const controller = new AbortController();
  expect((await provider.getSuggestions(["/"], 0, 1, { signal: controller.signal }))?.items[0]?.value)
    .toBe("help");
  controller.abort();
  expect(await provider.getSuggestions(["/"], 0, 1, { signal: controller.signal })).toBeNull();
});

test("skill slash discovery preserves dollar skills and workspace mentions", async () => {
  const provider = new WorkspaceAutocompleteProvider(
    [], process.cwd(), async () => ({ items: [{ kind: "file", path: "src/main.ts" }], truncated: false }),
    async () => ({ skills: [{ name: "audit", qualifiedName: "plugin:audit" }] })
  );
  const options = { signal: new AbortController().signal };
  expect((await provider.getSuggestions(["$audit"], 0, 6, options))?.items[0]?.value).toBe("$plugin:audit");
  expect((await provider.getSuggestions(["@src"], 0, 4, options))?.items[0]?.value).toBe("@src/main.ts");
  expect(await provider.getSuggestions(["/plugin:audit task"], 0, 18, options)).toBeNull();
});

test("skill shortcuts use the native skill route and leave unknown or reserved commands unchanged", async () => {
  let discoveryCalls = 0;
  const catalog = new SkillCatalog(async () => {
    discoveryCalls += 1;
    return { skills: [
      { name: "orchestration" }, { name: "audit", qualifiedName: "plugin:audit" },
      { name: "deploy" }, { name: "variant" }, { name: "skill" }, { name: "quit" }, { name: "workflow" }
    ] };
  });
  const reserved = ["deploy", "variant"];
  for (const input of ["/deploy task", "/VARIANT high", "/variant high", "/skill audit task", "/quit", "/workflow task", "text /orchestration"]) {
    expect(await catalog.prepareSlashCommand(input, reserved)).toBeUndefined();
  }
  expect(discoveryCalls).toBe(0);
  expect(await catalog.prepareSlashCommand("/orchestration", reserved)).toBe("/skill orchestration");
  expect(await catalog.prepareSlashCommand("/plugin:audit review\nthese changes", reserved))
    .toBe("/skill plugin:audit review\nthese changes");
  expect(await catalog.prepareSlashCommand("/unknown task", reserved)).toBeUndefined();
});
