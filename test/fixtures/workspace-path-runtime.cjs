const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

// Expose the native provider from the shipped bundle without starting the CLI.
const file = path.resolve(__dirname, "../../vendor/zcode.cjs");
let source = fs.readFileSync(file, "utf8");
const label = /[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),"createWorkspacePathSuggestionProvider"\)/u.exec(source);
assert.ok(label, "Missing native workspace path provider");
const init = [...source.slice(0, label.index).matchAll(/([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\(\)=>\{/gu)].at(-1)?.[1];
assert.ok(init, "Missing native workspace path initialization");
const main = /async function [A-Za-z_$][\w$]*\(\)\{let [A-Za-z_$][\w$]*=process\.argv\.slice\(2\);/u.exec(source);
assert.ok(main, "Missing native runtime test entry");
source = source.replace(main[0], `${main[0]}module.exports=(${init}(),${label[1]});return;`);
const runtime = new Module(file, module);
runtime.filename = file;
runtime.paths = Module._nodeModulePaths(path.dirname(file));
runtime._compile(source, file);
const createProvider = runtime.exports;
assert.equal(typeof createProvider, "function");

async function run() {
  const workspace = process.cwd();
  for (const name of [
    "First_folder/one.py", "First_folder/two.py", "Second_folder/one.py", "Second_folder/three.py",
    "docs/my file.md", "src/node_modules/one.py", ".git/one.py", ".hidden/one.py", "src/.one.py"
  ]) {
    await fs.promises.mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
    await fs.promises.writeFile(path.join(workspace, name), "");
  }
  const search = createProvider({ workspaceDirectory: workspace });
  const result = await search({ token: "@on" });
  assert.deepEqual(result, {
    items: [
      { kind: "file", path: "First_folder/one.py" },
      { kind: "file", path: "Second_folder/one.py" },
      { kind: "directory", path: "Second_folder/" }
    ], truncated: false
  });
  assert.deepEqual(await search({ token: "@one.py", limit: 1 }), {
    items: [{ kind: "file", path: "First_folder/one.py" }], truncated: true
  });
  for (const token of ["@First_folder/on", "@First_folder\\on"]) {
    assert.deepEqual(await search({ token }), { items: [{ kind: "file", path: "First_folder/one.py" }], truncated: false });
  }
  assert.ok((await search({ token: "@" })).items.every(item => !item.path.replace(/\/$/u, "").includes("/")));
  assert.deepEqual((await search({ token: "@my f" })).items, [{ kind: "file", path: "docs/my file.md" }]);
  assert.deepEqual((await search({ token: "@.one" })).items, [{ kind: "file", path: "src/.one.py" }]);
  assert.deepEqual(await search({ token: "@../" }), { items: [], truncated: false });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await search({ token: "@on", abortSignal: controller.signal }), { items: [], truncated: false });
  process.stdout.write("Native workspace search passed: recursive files, limits, scoped paths, exclusions and cancellation.\n");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
