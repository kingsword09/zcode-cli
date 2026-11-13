const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const { loadCredentialRuntime } = require("../fixtures/credential-runtime.cjs");

async function withCredentials(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zcode-keychain-recovery-"));
  try { await run(directory, path.join(directory, "credentials.json")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function locked() {
  return new Error("Platform failure: User interaction is not allowed.");
}

function encryptedRecord(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v2:os:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}:${[iv, cipher.getAuthTag(), ciphertext].map(bytes => bytes.toString("base64url")).join(".")}`;
}

test("real native cipher unlocks in place, preserves OS ciphertext and never writes a replacement key", async () => {
  await withCredentials(async (directory, filePath) => {
    let isLocked = true, unlocks = 0, reads = 0, writes = 0;
    const key = crypto.randomBytes(32);
    const record = { token: encryptedRecord(key, "fixture-token") };
    const original = JSON.stringify(record);
    await writeFile(filePath, original);
    await writeFile(path.join(directory, "credential-source"), "os\n");
    const { createSystemCredentialCipher } = loadCredentialRuntime({
      entry: {
        getSecret: async () => { reads++; if (isLocked) throw locked(); return [...Buffer.from(key.toString("base64url"))]; },
        setPassword: async () => { writes++; throw new Error("Do not replace an existing key"); }
      },
      unlock: async () => { unlocks++; isLocked = false; }
    });
    const originalPid = process.pid;
    const cipher = createSystemCredentialCipher({ filePath, env: {} });
    const values = await Promise.all([cipher.decrypt(record.token), cipher.decrypt(record.token)]);
    assert.deepEqual(values, ["fixture-token", "fixture-token"]);
    assert.equal(process.pid, originalPid);
    assert.deepEqual({ unlocks, reads, writes }, { unlocks: 1, reads: 2, writes: 0 });
    assert.equal(await readFile(filePath, "utf8"), original);
    assert.equal(await readFile(path.join(directory, "credential-source"), "utf8"), "os\n");
    const encrypted = await cipher.encrypt("next-token");
    assert.match(encrypted, /^enc:v2:os:/u);
    assert.equal(await cipher.decrypt(encrypted), "next-token");
  });
});

test("the same native cipher recovers after a failed unlock instead of caching rejection forever", async () => {
  await withCredentials(async (directory, filePath) => {
    let isLocked = true, unlocks = 0;
    const key = crypto.randomBytes(32);
    const ciphertext = encryptedRecord(key, "fixture-token");
    await writeFile(filePath, JSON.stringify({ token: ciphertext }));
    await writeFile(path.join(directory, "credential-source"), "os\n");
    const { createSystemCredentialCipher } = loadCredentialRuntime({
      entry: {
        getSecret: async () => { if (isLocked) throw locked(); return [...Buffer.from(key.toString("base64url"))]; },
        setPassword: async () => { throw new Error("Unexpected write"); }
      },
      unlock: async () => {
        if (++unlocks === 1) throw Object.assign(new Error("User cancelled the terminal unlock"), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });
        isLocked = false;
      }
    });
    const cipher = createSystemCredentialCipher({ filePath, env: {} });
    await assert.rejects(cipher.decrypt(ciphertext), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE", message: "User cancelled the terminal unlock" });
    assert.equal(await cipher.decrypt(ciphertext), "fixture-token");
    assert.equal(unlocks, 2);
  });
});

test("managed secrets bypass the keychain and do not unlock or migrate OS records", async () => {
  await withCredentials(async (directory, filePath) => {
    let unlocks = 0, reads = 0;
    const { createSystemCredentialCipher } = loadCredentialRuntime({
      entry: { getSecret: async () => { reads++; throw locked(); }, setPassword: async () => {} },
      unlock: async () => { unlocks++; }
    });
    const cipher = createSystemCredentialCipher({ filePath, env: { ZCODE_CREDENTIAL_SECRET: "fixture-managed-secret-at-least-32-bytes" } });
    const encrypted = await cipher.encrypt("fixture-token");
    assert.match(encrypted, /^enc:v2:env:/u);
    assert.equal(await cipher.decrypt(encrypted), "fixture-token");
    await assert.rejects(cipher.decrypt(encryptedRecord(crypto.randomBytes(32), "old-token")), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });
    assert.deepEqual({ unlocks, reads }, { unlocks: 0, reads: 0 });
  });
});

test("native legacy migration waits for unlock and persists exactly one new OS key", async () => {
  await withCredentials(async (directory, filePath) => {
    let isLocked = true, unlocks = 0, writes = 0, savedKey = null;
    const { createLegacyCredentialCipher, createSharedZCodeCredentialStore } = loadCredentialRuntime({
      entry: {
        getSecret: async () => {
          if (isLocked) throw locked();
          return savedKey === null ? null : [...Buffer.from(savedKey)];
        },
        setPassword: async value => { writes++; savedKey = value; }
      },
      unlock: async () => { unlocks++; isLocked = false; }
    });
    const legacy = createLegacyCredentialCipher({});
    await writeFile(filePath, JSON.stringify({ fixture: legacy.encrypt("fixture-token") }));
    const store = createSharedZCodeCredentialStore({ env: { ZCODE_CLI_CREDENTIALS_FILE: filePath } });
    assert.equal(await store.load("fixture"), "fixture-token");
    assert.deepEqual({ unlocks, writes }, { unlocks: 1, writes: 1 });
    assert.match(JSON.parse(await readFile(filePath, "utf8")).fixture, /^enc:v2:os:/u);
    assert.equal(await readFile(path.join(directory, "credential-source"), "utf8"), "os\n");
    assert.equal(await store.load("fixture"), "fixture-token");
    assert.equal(writes, 1);
  });
});

function terminalBridge(options = {}) {
  const file = path.resolve(__dirname, "../../vendor/cli-config.cjs");
  const calls = [], output = [];
  const runtime = new Module(file, module);
  runtime.filename = file;
  runtime.paths = Module._nodeModulePaths(path.dirname(file));
  const nativeRequire = runtime.require.bind(runtime);
  const fakeProcess = Object.assign(new EventEmitter(), {
    platform: "darwin",
    pid: 12345,
    kill: (pid, signal) => { calls.push(["default-signal", pid, signal]); },
    stdin: {
      isRaw: options.raw ?? false,
      isTTY: options.stdinTty ?? false,
      readableFlowing: options.flowing ?? false,
      pause: () => { calls.push(["pause-input"]); },
      resume: () => { calls.push(["resume-input"]); }
    }
  });
  if (options.signalHandler) fakeProcess.on(options.interrupt, options.signalHandler);
  runtime.require = id => {
    if (id === "node:fs") return {
      ...fs,
      openSync: (target, flags) => {
        calls.push(["open", target, flags]);
        if (options.noTerminal) throw new Error("ENXIO");
        return 42;
      },
      writeSync: (fd, text) => { output.push([fd, text]); return text.length; },
      closeSync: fd => { calls.push(["close", fd]); }
    };
    if (id === "node:tty") return { isatty: fd => fd === 42 };
    if (id === "node:child_process") return {
      ...nativeRequire(id),
      spawn: (command, args, config) => {
        calls.push(["spawn", command, args, config]);
        const child = new EventEmitter();
        child.kill = signal => { calls.push(["kill", signal]); return true; };
        queueMicrotask(() => {
          if (options.interrupt) fakeProcess.emit(options.interrupt);
          if (options.spawnError) child.emit("error", new Error("spawn failed"));
          else child.emit("close", options.signal || options.interrupt ? null : options.code ?? 0, options.signal ?? options.interrupt ?? null);
        });
        return child;
      }
    };
    return nativeRequire(id);
  };
  runtime.__testProcess = fakeProcess;
  runtime._compile(`(function(process){${fs.readFileSync(file, "utf8")}\n})(module.__testProcess);`, file);
  return { bridge: runtime.exports, calls, output, process: fakeProcess };
}

test("terminal unlock delegates the hidden prompt to security without using task stdin or stdout", async () => {
  const { bridge, calls, output } = terminalBridge();
  await bridge.unlockKeychainInTerminal();
  assert.deepEqual(calls, [
    ["open", "/dev/tty", "r+"],
    ["spawn", "/usr/bin/security", ["unlock-keychain"], { stdio: [42, 42, 42] }],
    ["close", 42]
  ]);
  assert.equal(output.length, 2);
  assert.ok(output.every(([fd]) => fd === 42));
});

test("missing controlling terminal and raw-mode UI fail without attempting a password prompt", async () => {
  for (const options of [{ noTerminal: true }, { raw: true }]) {
    const { bridge, calls } = terminalBridge(options);
    await assert.rejects(bridge.unlockKeychainInTerminal(), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });
    assert.ok(calls.every(([kind]) => kind !== "spawn"));
  }
});

test("a flowing terminal input is paused during password entry and restored on failure", async () => {
  const { bridge, calls } = terminalBridge({ stdinTty: true, flowing: true, code: 1 });
  await assert.rejects(bridge.unlockKeychainInTerminal());
  assert.equal(calls[1][0], "pause-input");
  assert.equal(calls[2][0], "spawn");
  assert.equal(calls.at(-1)[0], "resume-input");
});

test("failed, cancelled or unavailable unlock tools close the terminal and do not loop", async () => {
  for (const options of [{ code: 1 }, { signal: "SIGINT" }, { spawnError: true }]) {
    const { bridge, calls } = terminalBridge(options);
    await assert.rejects(bridge.unlockKeychainInTerminal(), { code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE" });
    assert.equal(calls.filter(([kind]) => kind === "spawn").length, 1);
    assert.deepEqual(calls.at(-1), ["close", 42]);
  }
});

test("termination signals reach the unlock child and preserve normal signal handling", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const { bridge, calls, process: fakeProcess } = terminalBridge({ interrupt: signal });
    await assert.rejects(bridge.unlockKeychainInTerminal());
    assert.ok(calls.some(call => call[0] === "kill" && call[1] === signal));
    assert.ok(calls.some(call => call[0] === "default-signal" && call[2] === signal));
    assert.equal(fakeProcess.listenerCount(signal), 0);
  }
  let handled = 0;
  const { bridge, calls, process: fakeProcess } = terminalBridge({ interrupt: "SIGTERM", signalHandler: () => { handled++; } });
  await assert.rejects(bridge.unlockKeychainInTerminal());
  assert.equal(handled, 1);
  assert.equal(fakeProcess.listenerCount("SIGTERM"), 1);
  assert.equal(calls.some(call => call[0] === "default-signal"), false);
});
