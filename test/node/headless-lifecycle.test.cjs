const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

test("headless lifecycle keeps unreferenced work alive and releases its handle on success and failure", () => {
  const child = spawnSync(process.execPath, ["-e", `
    const { withHeadlessPromptLifecycle } = require("./vendor/cli-config.cjs");
    const run = async () => {
      const result = await withHeadlessPromptLifecycle(process, () => new Promise(resolve => {
        setTimeout(() => resolve("settled"), 50).unref();
      }));
      process.stdout.write(result + "\\n");
      try {
        await withHeadlessPromptLifecycle(process, () => new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error("fixture failure")), 50).unref();
        }));
      } catch (error) {
        process.stderr.write(error.message + "\\n");
      }
    };
    run().catch(() => { process.exitCode = 1; });
  `], { cwd: root, encoding: "utf8", timeout: 3_000 });

  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "settled\n");
  assert.equal(child.stderr, "fixture failure\n");
});

test("headless output failures reject and do not leak the keepalive handle", () => {
  const child = spawnSync(process.execPath, ["-e", `
    const { Writable } = require("node:stream");
    const { withHeadlessPromptLifecycle } = require("./vendor/cli-config.cjs");
    const broken = new Writable({ write(chunk, encoding, callback) { callback(new Error("output failed")); } });
    broken.on("error", () => {});
    withHeadlessPromptLifecycle({ stdout: broken, stderr: process.stderr }, async () => 0)
      .then(() => { process.exitCode = 1; }, error => { process.stderr.write(error.message); });
  `], { cwd: root, encoding: "utf8", timeout: 3_000 });

  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "output failed");
});
