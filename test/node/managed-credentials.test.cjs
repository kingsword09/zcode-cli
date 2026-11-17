const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadCredentialRuntime } = require("../fixtures/credential-runtime.cjs");
const { setupManagedCredentialSecret, withCredentialLogin } = require("../../vendor/cli-config.cjs");

async function withCredentials(operation) {
  const directory = await mkdtemp(path.join(tmpdir(), "zcode-node-managed-"));
  try {
    await operation(directory, path.join(directory, "credentials.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const unavailableEntry = {
  getSecret: async () => { throw new Error("Secret Service unavailable"); },
  setPassword: async () => { throw new Error("Secret Service unavailable"); }
};

test("concurrent real Node login processes retain the same persistent encryption key", async () => {
  await withCredentials(async (directory, filePath) => {
    const script = `
      const {loadCredentialRuntime}=require(${JSON.stringify(require.resolve("../fixtures/credential-runtime.cjs"))});
      const {withCredentialLogin}=require(${JSON.stringify(require.resolve("../../vendor/cli-config.cjs"))});
      const {createSystemCredentialCipher}=loadCredentialRuntime({platform:"linux",entry:{getSecret:async()=>{throw new Error("No keyring")}}});
      const cipher=createSystemCredentialCipher({filePath:${JSON.stringify(filePath)},env:{}});
      withCredentialLogin({confirmCredentialStorage:async()=>true},()=>cipher.encrypt("fixture-token"))
        .then(value=>console.log(value)).catch(error=>{console.error(error);process.exitCode=1});
    `;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "", stderr = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(stderr)));
    });
    const encrypted = await Promise.all([run(), run()]);
    const secretPath = path.join(directory, "credential-secret");
    const original = await readFile(secretPath, "utf8");
    if (process.platform !== "win32") assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
    const { createSystemCredentialCipher } = loadCredentialRuntime({ platform: "linux", entry: unavailableEntry });
    const cipher = createSystemCredentialCipher({ filePath, env: {} });
    for (const value of encrypted) assert.equal(await cipher.decrypt(value), "fixture-token");
    await run();
    assert.equal(await readFile(secretPath, "utf8"), original);
    assert.deepEqual(await readdir(directory), ["credential-secret"]);
  });
});

test("a Linux login recovers in place once and subsequent writes bypass the unavailable keyring", async () => {
  await withCredentials(async (directory, filePath) => {
    let reads = 0, prompts = 0;
    const { createSystemCredentialCipher } = loadCredentialRuntime({
      platform: "linux", entry: { ...unavailableEntry, getSecret: async () => { reads++; return unavailableEntry.getSecret(); } }
    });
    const cipher = createSystemCredentialCipher({ filePath, env: {} });
    const encrypted = await withCredentialLogin({ confirmCredentialStorage: async () => {
      prompts++;
      assert.deepEqual(await readdir(directory), []);
      return true;
    } }, () => cipher.encrypt("fixture-login-token"));
    assert.match(encrypted, /^enc:v2:env:/);
    assert.equal(await cipher.decrypt(encrypted), "fixture-login-token");
    const original = await readFile(path.join(directory, "credential-secret"), "utf8");
    await cipher.encrypt("another-fixture-token");
    assert.deepEqual({ reads, prompts }, { reads: 1, prompts: 1 });
    assert.equal(await readFile(path.join(directory, "credential-secret"), "utf8"), original);
  });
});

test("setup participates in the same native lock as credential initialization", async () => {
  await withCredentials(async (directory, filePath) => {
    const { withFileLock } = loadCredentialRuntime();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    const held = withFileLock(`${filePath}.keyring`, async () => { acquired(); await pending; });
    await ready;
    const setup = setupManagedCredentialSecret({ filePath, env: {}, withLock: withFileLock });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(!(await readdir(directory)).includes("credential-secret"));
    } finally {
      release();
    }
    await held;
    assert.equal((await setup).created, true);
    assert.deepEqual(await readdir(directory), ["credential-secret"]);
  });
});

test("existing credentials fail without a replacement prompt and unattended login never changes storage", async () => {
  await withCredentials(async (directory, filePath) => {
    const { createSystemCredentialCipher } = loadCredentialRuntime({ platform: "linux", entry: unavailableEntry });
    const cipher = createSystemCredentialCipher({ filePath, env: {} });
    await assert.rejects(withCredentialLogin({}, () => cipher.initialize()), /System credential storage is unavailable/);
    assert.deepEqual(await readdir(directory), []);
    const original = JSON.stringify({ token: "enc:v2:os:fixture" });
    await writeFile(filePath, original);
    let prompts = 0;
    await assert.rejects(withCredentialLogin({ confirmCredentialStorage: async () => { prompts++; return true; } },
      () => cipher.encrypt("fixture-token")), /System credential storage is unavailable/);
    assert.equal(prompts, 0);
    assert.equal(await readFile(filePath, "utf8"), original);
    assert.deepEqual(await readdir(directory), ["credentials.json"]);
  });
});
