const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const herdrStatus = import("../../src/herdr-status.mjs");

test("reports idle to Herdr before starting an interactive ZCode TUI", async () => {
  const { runTuiWithHerdrStatus } = await herdrStatus;
  const events = [];
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => events.push("unref");
  const env = {
    HERDR_ENV: "1",
    HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
    HERDR_PANE_ID: "w1X:pB"
  };

  const exitCode = await runTuiWithHerdrStatus(async () => {
    events.push("tui");
    return 23;
  }, env, (binary, args, options) => {
    events.push("report");
    calls.push({ binary, args, options });
    return child;
  });

  assert.equal(exitCode, 23);
  assert.deepEqual(events, ["report", "unref", "tui"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binary, env.HERDR_BIN_PATH);
  assert.deepEqual(calls[0].args.slice(0, 9), [
    "pane", "report-agent", env.HERDR_PANE_ID,
    "--source", "herdr-zcode", "--agent", "zcode", "--state", "idle"
  ]);
  const sequenceIndex = calls[0].args.indexOf("--seq");
  assert.notEqual(sequenceIndex, -1);
  assert.ok(BigInt(calls[0].args[sequenceIndex + 1]) > 10_000_000_000_000_000n);
  assert.deepEqual(calls[0].options, { stdio: "ignore", windowsHide: true });
});

test("does not call Herdr when the CLI is outside a Herdr pane", async () => {
  const { runTuiWithHerdrStatus } = await herdrStatus;
  let spawnCount = 0;
  let tuiStarted = false;

  const exitCode = await runTuiWithHerdrStatus(async () => {
    tuiStarted = true;
    return 0;
  }, {}, () => {
    spawnCount += 1;
    throw new Error("Herdr must not be called");
  });

  assert.equal(exitCode, 0);
  assert.equal(spawnCount, 0);
  assert.equal(tuiStarted, true);
});
