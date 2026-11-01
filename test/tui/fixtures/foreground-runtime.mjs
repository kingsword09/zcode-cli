import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runTui } from "../../../vendor/node_modules/@zcode/tui/dist/index.js";

const record = text => appendFileSync(process.env.ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL, `${text}\n`);
record(`RUNTIME_PID ${process.pid}`);
while (!existsSync(join(process.cwd(), "release-runtime"))) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
if (process.env.ZCODE_TEST_RUNTIME_FAILURE === "1") process.exit(7);
await runTui({
  version: "foreground-scenario",
  workspaceDirectory: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  writeClipboardText: async text => {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  },
  loadStartupOptions: async () => ({
    initialModel: "scenario/model",
    initialMode: "guarded",
    loginRequired: false,
    theme: process.env.ZCODE_TEST_THEME ?? "dark",
    slashCommands: [{ name: "echo", summary: "FOREGROUND_ECHO" }]
  }),
  loadSessionTranscript: async () => [{ role: "agent", content: "FOREGROUND_READY" }],
  submitPrompt: async input => {
    record(`RUNTIME_INPUT ${input}`);
    if (input === "/crash") process.exit(9);
    return { response: `FOREGROUND_REPLY ${input}` };
  }
});
record("RUNTIME_CLOSED");
if (process.env.ZCODE_TEST_RUNTIME_CLEANUP_FAILURE === "1") process.exitCode = 9;
