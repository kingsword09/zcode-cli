#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { createSessionModelFixture, sessionModelCases, type SessionModelCase } from "../test/fixtures/session-model-recovery.ts";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  case: { type: "string", default: "legacy-provider" },
  headless: { type: "boolean", default: false },
  fullscreen: { type: "boolean", default: false }
} });
if (!Object.hasOwn(sessionModelCases, values.case)) throw new Error(`Choose --case ${Object.keys(sessionModelCases).join(" | ")}`);

await using fixture = await createSessionModelFixture(values.case as SessionModelCase);
console.log(`Issue #160 reproduction: ${values.case}\nTemporary session: ${fixture.sessionId}\nData: ${fixture.directory}`);
console.log("The runtime and SQLite session are real. Model responses come from a local mock; no API key is needed.");
console.log(values.headless
  ? "Resuming and sending a prompt without a terminal."
  : "Resume should immediately ask you to replace the unavailable model. Choose zai/glm-5.3, then send a message. Use /exit to finish.");
const child = Bun.spawn([...fixture.command, "--resume", fixture.sessionId,
  ...values.headless ? ["--prompt", "Reply after resuming."] : []], {
  cwd: fixture.directory, env: { ...fixture.env, ZCODE_TUI_MODE: values.fullscreen ? "fullscreen" : "regular" },
  stdin: "inherit", stdout: "inherit", stderr: "inherit"
});
const interrupt = () => child.kill("SIGINT");
const terminate = () => child.kill("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
try { process.exitCode = await child.exited; }
finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}
