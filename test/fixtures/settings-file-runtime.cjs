// Inspect the real bundled settings and trust APIs without starting a model session.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const file = path.resolve(__dirname, "../../vendor/zcode.cjs");
let source = fs.readFileSync(file, "utf8");
const names = [
  "getDefaultConfigPath", "loadFileConfig", "updateUiLocaleInFileConfig",
  "resolveWorkspaceHookTrustStorePath", "inspectWorkspaceHookTrust"
];
const functions = names.map(name => {
  const symbol = new RegExp(`[A-Za-z_$][\\w$]*\\(([A-Za-z_$][\\w$]*),"${name}"\\)`, "u").exec(source);
  assert.ok(symbol, `Missing native ${name}`);
  const init = [...source.slice(0, symbol.index).matchAll(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\(\)=>\{/gu)].at(-1)?.[1];
  assert.ok(init, `Missing initializer for ${name}`);
  return { name, symbol: symbol[1], init };
});
const main = /async function [A-Za-z_$][\w$]*\(\)\{let [A-Za-z_$][\w$]*=process\.argv\.slice\(2\);/u.exec(source);
assert.ok(main, "Missing native settings test entry");
source = source.replace(main[0], () => main[0]
  + [...new Set(functions.map(entry => entry.init))].map(init => `${init}();`).join("")
  + `module.exports={${functions.map(entry => `${entry.name}:${entry.symbol}`).join(",")}};return;`);
const runtime = new Module(file, module);
runtime.filename = file;
runtime.paths = Module._nodeModulePaths(path.dirname(file));
runtime._compile(source, file);

async function probe() {
  const api = runtime.exports, workspacePath = process.argv[2], locale = process.argv[3];
  const settingsPath = api.getDefaultConfigPath(), loaded = api.loadFileConfig();
  if (locale) await api.updateUiLocaleInFileConfig(settingsPath, locale);
  const trustPath = await api.resolveWorkspaceHookTrustStorePath();
  // App bootstrap passes the loaded user path into its hook trust store.
  const appTrustPath = await api.resolveWorkspaceHookTrustStorePath({ userConfigPath: loaded.path });
  const trust = await api.inspectWorkspaceHookTrust({ workspacePath, userConfigPath: loaded.path });
  console.log(JSON.stringify({ settingsPath, loaded, trustPath, appTrustPath, trust }));
}

probe().catch(error => { console.error(error); process.exitCode = 1; });
