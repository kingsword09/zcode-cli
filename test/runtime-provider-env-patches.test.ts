import { describe, expect, test } from "bun:test";
import { hasRuntimeBuiltinProviderEnvRecovery, patchRuntimeBuiltinProviderEnvRecovery } from "../scripts/runtime-provider-env-patches.ts";

const source = [
  'var active="ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",bundled="ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE",personal="ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";',
  'async function candidate(path){return read(path)}label(candidate,"readReleaseCandidate");',
  'async function discover(options){return resolve(options)}label(discover,"resolveBundledZCodeBuiltinProviderConfig");',
  'async function prepare(options){if(!requires(options.argv))return{};let builtin=options.env[active]?.trim(),file=options.env[personal]?.trim(),root=options.dataBaseDir??options.env.ZCODE_DATA_BASE_DIR?.trim()??home();',
  'if(builtin&&file)return{[active]:builtin,[personal]:file};let catalog=builtin??await discover({dataBaseDir:root,entrypoint:options.entrypoint??process.argv[1],sea:options.sea??sea()}),user=file??join(root,"personal.json"),version=options.appVersion??"0.0.0-dev",platform=options.platform??"test",endpoint=origin(options.env),paths=cache({root,version,platform,endpoint}),instance=new Source({bundledFilePath:catalog,activeFilePath:paths.activeFilePath,watch:!1});',
  'try{await instance.read()}finally{instance.dispose()}return{[active]:paths.activeFilePath,[bundled]:catalog,[personal]:user}}label(prepare,"prepareCliProviderRuntimeEnv");'
].join("");

function fixture(releases: Record<string, unknown> = { "/vendor/builtin.json": { revision: 1 } }, discovery: string | Error = "/vendor/builtin.json") {
  const warnings: string[] = [], reads: string[] = [], sources: unknown[] = [];
  const prepare = new Function("read", "resolve", "requires", "home", "join", "sea", "origin", "cache", "Source", "label", "process",
    `${patchRuntimeBuiltinProviderEnvRecovery(source)};return prepare`)(
    async (path: string) => {
      reads.push(path);
      const value = releases[path];
      return value instanceof Error ? { error: value } : value ? { release: value } : null;
    },
    async () => { if (discovery instanceof Error) throw discovery; return discovery; },
    (argv: string[]) => argv[0] === "app-server", () => "/home", (...parts: string[]) => parts.join("/"),
    () => undefined, () => "http://localhost", () => ({ activeFilePath: "/cache/active.json" }),
    class {
      constructor(options: unknown) { sources.push(options); }
      async read() {}
      dispose() {}
    },
    () => {}, { argv: ["node", "/vendor/zcode.cjs"], stderr: { write: (message: string) => warnings.push(message) } }
  ) as (options: { argv: string[]; env: Record<string, string> }) => Promise<Record<string, string>>;
  return { run: (env: Record<string, string> = {}, argv = ["app-server"]) => prepare({ argv, env }), warnings, reads, sources };
}

describe("built-in provider environment recovery", () => {
  test("is idempotent and verifies the complete patch", () => {
    const patched = patchRuntimeBuiltinProviderEnvRecovery(source);
    expect(hasRuntimeBuiltinProviderEnvRecovery(source)).toBe(false);
    expect(hasRuntimeBuiltinProviderEnvRecovery(patched)).toBe(true);
    expect(patchRuntimeBuiltinProviderEnvRecovery(patched)).toBe(patched);
  });

  test.each([undefined, "", " \t "])("discovers bundled config for an unset or blank override (%j)", async value => {
    const host = fixture();
    const env: Record<string, string> = value === undefined ? {} : { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: value };
    expect(await host.run(env)).toEqual({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/cache/active.json",
      ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/vendor/builtin.json", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/home/personal.json" });
    expect(host.warnings).toEqual([]);
  });

  test.each([undefined, new SyntaxError("secret fixture content"), new Error("invalid schema")])("recovers missing or invalid releases with a warning (%j)", async failure => {
    const host = fixture({ "/vendor/builtin.json": { revision: 1 }, ...failure ? { "/stale.json": failure } : {} });
    const result = await host.run({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/stale.json", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/custom/personal.json" });
    expect(result).toEqual({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/cache/active.json",
      ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/vendor/builtin.json", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/custom/personal.json" });
    expect(host.sources).toHaveLength(1);
    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).toContain('ZCODE_BUILTIN_PROVIDER_CONFIG_FILE "/stale.json"');
    expect(host.warnings[0]).toContain('using bundled catalog "/vendor/builtin.json"');
    expect(host.warnings[0]).not.toContain("secret fixture content");
  });

  test("preserves a valid custom override and the explicit-path fast path", async () => {
    const host = fixture({ "/custom.json": { revision: 100 }, "/vendor/builtin.json": { revision: 1 } });
    const env = { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: " /custom.json ", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: " /personal.json " };
    expect(await host.run(env)).toEqual({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/custom.json", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/personal.json" });
    expect(host.sources).toEqual([]);
    expect(host.warnings).toEqual([]);
  });

  test("preserves a valid custom bundled input when the personal path is not set", async () => {
    const host = fixture({ "/custom.json": { revision: 100 } });
    expect((await host.run({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/custom.json" })).ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE)
      .toBe("/custom.json");
    expect(host.sources[0]).toMatchObject({ bundledFilePath: "/custom.json" });
    expect(host.warnings).toEqual([]);
  });

  test("reports unreadable overrides by error code without printing decoder details", async () => {
    const host = fixture({ "/vendor/builtin.json": { revision: 1 }, "/unreadable.json": Object.assign(new Error("private data"), { code: "EACCES" }) });
    await host.run({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/unreadable.json" });
    expect(host.warnings[0]).toContain("(EACCES)");
    expect(host.warnings[0]).not.toContain("private data");
  });

  test("does not introduce the explicit-path fast path when only the personal path is set", async () => {
    const host = fixture();
    expect((await host.run({ ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/personal.json" })).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toBe("/cache/active.json");
    expect(host.sources).toHaveLength(1);
  });

  test("prefers a valid explicit bundled fallback", async () => {
    const host = fixture({ "/host/bundled.json": { revision: 2 } }, new Error("discovery unavailable"));
    expect((await host.run({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/stale.json", ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/host/bundled.json" }))
      .ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE).toBe("/host/bundled.json");
  });

  test("ignores an invalid explicit bundled fallback if discovery is healthy", async () => {
    const host = fixture();
    expect((await host.run({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/stale.json", ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: "/missing-bundled.json" }))
      .ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE).toBe("/vendor/builtin.json");
  });

  test.each(["/invalid-bundled.json", new Error("not packaged")])("does not replace an override without a validated fallback (%j)", async discovery => {
    const host = fixture({}, discovery);
    expect(await host.run({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/stale.json", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/personal.json" }))
      .toEqual({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/stale.json", ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/personal.json" });
    expect(host.warnings[0]).toContain("no valid bundled fallback");
  });

  test("leaves commands without provider bootstrap untouched", async () => {
    const host = fixture();
    expect(await host.run({ ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/stale.json" }, ["plugins"])).toEqual({});
    expect(host.reads).toEqual([]);
    expect(host.warnings).toEqual([]);
  });

  test("rejects missing, ambiguous, changed and partially patched anchors", () => {
    expect(() => patchRuntimeBuiltinProviderEnvRecovery(source.replace('label(candidate,"readReleaseCandidate");', ""))).toThrow("incompatible");
    expect(() => patchRuntimeBuiltinProviderEnvRecovery(source + 'label(candidate,"readReleaseCandidate");')).toThrow("incompatible");
    expect(() => patchRuntimeBuiltinProviderEnvRecovery(source.replace("?.trim()", ".trim()"))).toThrow("incompatible");
    const partial = patchRuntimeBuiltinProviderEnvRecovery(source).replace("using bundled catalog", "partial recovery");
    expect(hasRuntimeBuiltinProviderEnvRecovery(partial)).toBe(false);
    expect(() => patchRuntimeBuiltinProviderEnvRecovery(partial)).toThrow("incompatible");
  });
});
