import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runTui } from "../../../packages/zcode-tui/src/index.ts";
import type { TuiOptions, TuiStartupOptions } from "../../../packages/zcode-tui/src/types.ts";

const mode = process.env.ZCODE_TEST_STARTUP_MODE ?? "lazy";
const record = (kind: string) => appendFileSync(
  process.env.ZCODE_TUI_SCENARIO_RUNTIME_JOURNAL!, `${JSON.stringify({ kind })}\n`
);
const startup: TuiStartupOptions = {
  initialMode: "guarded",
  initialModel: "startup/ready-model",
  initialThoughtLevel: "high",
  loginRequired: false,
  locale: "en-US",
  theme: "dark",
  modelOptions: [{ id: "startup/ready-model", label: "Ready model" }],
  effortOptions: [{ id: "high", label: "High" }],
  workspaceGitBranch: "startup-branch",
  slashCommands: [
    { name: "mcp", summary: "STARTUP_MCP_COMPLETION" },
    { name: "help", summary: "STARTUP_HELP_COMPLETION" },
    { name: "custom-startup", summary: "STARTUP_CUSTOM_COMPLETION" }
  ]
};
const options: TuiOptions = {
  initialModel: "fallback/model",
  loginRequired: true,
  workspaceDirectory: process.cwd(),
  loadSessionTranscript: async () => {
    record("transcript-read");
    return [{ role: "agent", content: "STARTUP_READY" }];
  },
  listMcpServers: async () => {
    record("mcp-read");
    return { fixture_server: { status: "disconnected", transport: "stdio", toolCount: 0 } };
  },
  submitPrompt: async (input) => ({ response: `STARTUP_SENT ${String(input)}` })
};

if (mode === "legacy") Object.assign(options, startup);
else options.loadStartupOptions = async () => {
  record("loader-called");
  while (!existsSync(join(process.cwd(), "release-startup"))) await Bun.sleep(10);
  if (mode.startsWith("cancel")) {
    record("loader-settled");
    if (mode === "cancel-reject") throw new Error("LATE_STARTUP_FAILURE");
  }
  if (mode === "failure") throw new Error("STORAGE_STARTUP_FAILURE");
  if (mode === "cancel-after-load") setTimeout(() => process.kill(process.pid, "SIGTERM"), 10);
  return startup;
};

try {
  await runTui(options);
  if (mode.startsWith("cancel")) {
    console.log("STARTUP_CANCELLED");
    console.log(`STARTUP_RAW_MODE ${Boolean(process.stdin.isRaw)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`STARTUP_RAW_MODE ${Boolean(process.stdin.isRaw)}`);
  process.exitCode = 1;
}
