import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runForegroundTui } from "../../../vendor/node_modules/@zcode/tui/dist/foreground.js";

const code = await runForegroundTui({
  version: "foreground-scenario",
  workspaceDirectory: process.cwd(),
  prepare: async () => ({
    command: process.execPath,
    args: [fileURLToPath(new URL("foreground-runtime.mjs", import.meta.url))],
    env: process.env
  }),
  onDiagnostic: chunk => appendFileSync(process.env.ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL, chunk)
}).catch(error => {
  console.error(`FOREGROUND_FAILURE ${error.message}`);
  return 1;
});
console.log(`FOREGROUND_RAW_MODE ${Boolean(process.stdin.isRaw)}`);
process.exitCode = code;
