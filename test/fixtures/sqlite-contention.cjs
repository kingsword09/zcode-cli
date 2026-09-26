const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "zcode-sqlite-runtime-"));
  try { await run(directory, path.join(directory, "sessions.sqlite")); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function startWorker(mode, options) {
  const child = fork(path.join(__dirname, "sqlite-session-store.cjs"), [mode, JSON.stringify(options)], {
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 45_000
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("message", message => message?.type === "ready" ? resolve() : reject(new Error("Unexpected worker message")));
      child.once("close", () => reject(new Error(`Worker exited before ready: ${stderr}`)));
    });
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
  return {
    send(message) { if (child.connected) child.send(message); },
    async wait() {
      const result = await exited;
      assert.equal(result.code, 0, `Worker failed (${result.signal}): ${stderr}`);
    },
    async stop(signal = "SIGTERM") { if (child.connected) child.kill(signal); await exited; }
  };
}

module.exports = { withDirectory, startWorker };
