const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

function loadCredentialRuntime(options = {}) {
  const file = path.resolve(__dirname, "../../vendor/zcode.cjs");
  let source = fs.readFileSync(file, "utf8");
  const names = ["createSystemCredentialCipher", "createLegacyCredentialCipher", "createSharedZCodeCredentialStore"];
  const functions = names.map(name => {
    const label = new RegExp(`[A-Za-z_$][\\w$]*\\(([A-Za-z_$][\\w$]*),"${name}"\\)`, "u").exec(source);
    assert.ok(label, `Missing native ${name}`);
    const init = [...source.slice(0, label.index).matchAll(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\(\)=>\{/gu)].at(-1)?.[1];
    assert.ok(init, `Missing initializer for ${name}`);
    return { name, symbol: label[1], init };
  });
  const main = /async function [A-Za-z_$][\w$]*\(\)\{let [A-Za-z_$][\w$]*=process\.argv\.slice\(2\);/u.exec(source);
  assert.ok(main, "Missing native entry point");
  source = source.replace(main[0], `${main[0]}${functions.map(value => `${value.init}();`).join("")}module.exports={${functions.map(value => `${value.name}:${value.symbol}`).join(",")}};return;`);
  const runtime = new Module(file, module);
  runtime.filename = file;
  runtime.paths = Module._nodeModulePaths(path.dirname(file));
  const nativeRequire = runtime.require.bind(runtime);
  const helperPath = path.join(path.dirname(file), "cli-config.cjs");
  const helper = nativeRequire(helperPath);
  const recover = helper.createKeychainRecovery({ platform: options.platform ?? "darwin", unlock: options.unlock });
  runtime.require = id => id === helperPath ? {
    ...helper,
    createRecoverableSystemKeyStore: (_entry, unavailable) => helper.createRecoverableSystemKeyStore(
      async () => options.entry, unavailable, recover
    )
  } : nativeRequire(id);
  runtime._compile(source, file);
  return runtime.exports;
}

module.exports = { loadCredentialRuntime };
