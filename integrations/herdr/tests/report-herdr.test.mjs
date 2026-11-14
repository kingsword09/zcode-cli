import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const HOOK_URL = new URL("../plugins/herdr-zcode/hooks/report-herdr.mjs", import.meta.url);
const CAPTURE_REPORT = `
  import childProcess from "node:child_process";
  import { EventEmitter } from "node:events";
  import { syncBuiltinESMExports } from "node:module";

  childProcess.spawn = (binary, args, options) => {
    if (process.env.HERDR_TEST_FAILURE === "throw") throw new Error("Herdr unavailable");
    process.stdout.write(JSON.stringify({ binary, args, options }) + "\\n");
    const child = new EventEmitter();
    child.unref = () => {};
    if (process.env.HERDR_TEST_FAILURE === "error") {
      queueMicrotask(() => child.emit("error", new Error("Herdr unavailable")));
    }
    return child;
  };
  syncBuiltinESMExports();
  await import(process.argv[1]);
`;

function report(input, environment = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", CAPTURE_REPORT, HOOK_URL.href], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      HERDR_ENV: "1",
      HERDR_BIN_PATH: "herdr-test",
      HERDR_PANE_ID: "w1:p1",
      HERDR_TEST_FAILURE: "",
      ...environment
    }
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("reports hook states with the Herdr 0.9.5+ session and resume arguments", () => {
  const states = {
    SessionStart: "idle",
    UserPromptSubmit: "working",
    PermissionRequest: "blocked",
    PostToolUse: "working",
    PostToolUseFailure: "working",
    Stop: "idle"
  };
  const session = "sess_test-123_abc";

  for (const [event, state] of Object.entries(states)) {
    const calls = report({ hook_event_name: event, session_id: session });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.binary, "herdr-test");
    assert.deepEqual(call.options, { stdio: "ignore", windowsHide: true });
    assert.deepEqual(call.args.slice(0, 10), [
      "pane", "report-agent", "w1:p1", "--source", "herdr-zcode",
      "--agent", "zcode", "--state", state, "--seq"
    ]);
    assert.ok(BigInt(call.args[10]) > 10_000_000_000_000_000n);
    const expectedTail = ["--agent-session-id", session, "--", "zcode", "--resume", session];
    if (state === "blocked") expectedTail.unshift("--message", "Waiting for a ZCode permission decision");
    assert.deepEqual(call.args.slice(11), expectedTail);
  }
});

test("omits session and resume arguments when the session ID is missing or invalid", () => {
  for (const session of [undefined, null, 123, "invalid", "sess_", "sess_" + "a".repeat(129)]) {
    const calls = report({ hook_event_name: "SessionStart", session_id: session });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.length, 11);
  }
});

test("does not report outside a configured Herdr pane", () => {
  for (const environment of [{ HERDR_ENV: "0" }, { HERDR_BIN_PATH: "" }, { HERDR_PANE_ID: "" }]) {
    assert.deepEqual(report({ hook_event_name: "SessionStart" }, environment), []);
  }
});

test("ignores malformed input and unknown events", () => {
  for (const input of ["invalid json", "null", "[]", "{}", { hook_event_name: "Unknown" }]) {
    assert.deepEqual(report(input), []);
  }
});

test("ignores Herdr spawn failures without interrupting the hook", () => {
  const input = { hook_event_name: "SessionStart", session_id: "sess_test" };
  assert.deepEqual(report(input, { HERDR_TEST_FAILURE: "throw" }), []);
  assert.equal(report(input, { HERDR_TEST_FAILURE: "error" }).length, 1);
});
