import { test } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test("Desktop off hides restored and live reasoning while preserving the thinking activity", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-thinking-hidden-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/thinking-visibility.ts")],
    workspace,
    env: { ZCODE_TEST_SHOW_REASONING: "false" }
  });
  await session.waitForScreen("transcript is ready", /THINKING_VISIBILITY_READY/u);
  session.send("test hidden reasoning\r");
  await session.waitForScreen("reasoning is processed", /thinking/u);
  await session.waitForScreen("thinking activity remains visible", /thinking/u);
  await session.assertScreenExcludes("reasoning view is hidden", /RESTORED_THOUGHT_SENTINEL|LIVE_THOUGHT_SENTINEL|Ctrl\+O to expand/u);
  session.send("\x03");
  await session.exit();
}, 20_000);

test("Desktop on keeps restored and live reasoning visible", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-thinking-visible-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/thinking-visibility.ts")],
    workspace,
    env: { ZCODE_TEST_SHOW_REASONING: "true" }
  });
  await session.waitForScreen("transcript is ready", /THINKING_VISIBILITY_READY/u);
  session.send("test visible reasoning\r");
  await session.waitForScreen("live thought appears", /LIVE_THOUGHT_SENTINEL/u);
  session.send("\x0f");
  await session.waitForScreen("restored thought appears after expanding", /RESTORED_THOUGHT_SENTINEL/u);
  session.send("\x03");
  await session.exit();
}, 20_000);
