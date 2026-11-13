import { test } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test("Desktop off keeps the first thought per turn and hides later reasoning", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-thinking-hidden-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/thinking-visibility.ts")],
    workspace,
    env: { ZCODE_TEST_SHOW_REASONING: "false" }
  });
  await session.waitForScreen("transcript is ready", /THINKING_VISIBILITY_READY/u);
  session.send("first live turn\r");
  await session.waitForScreen("first live thought remains visible", /LIVE_FIRST_THOUGHT_FIRST_TURN_SENTINEL/u);
  await session.waitForScreen("thinking activity remains visible", /thinking/u);
  await session.assertScreenExcludes("later live thought is hidden", /LIVE_SECOND_THOUGHT_FIRST_TURN_SENTINEL/u);
  await session.waitForScreen("first live turn finishes", /TURN_FINISHED:first live turn/u);
  session.send("\x0f");
  await session.waitForScreen("first restored thought appears", /RESTORED_FIRST_THOUGHT_SENTINEL/u);
  await session.waitForScreen("next turn's first restored thought appears", /RESTORED_NEXT_TURN_FIRST_THOUGHT_SENTINEL/u);
  await session.assertScreenExcludes(
    "later restored thoughts are hidden",
    /RESTORED_SECOND_THOUGHT_SENTINEL|RESTORED_LATER_MESSAGE_THOUGHT_SENTINEL/u
  );

  session.send("second live turn\r");
  await session.waitForScreen("first thought appears in the next live turn", /LIVE_FIRST_THOUGHT_SECOND_TURN_SENTINEL/u);
  await session.assertScreenExcludes("second thought stays hidden in the next live turn", /LIVE_SECOND_THOUGHT_SECOND_TURN_SENTINEL/u);
  await session.waitForScreen("second live turn finishes", /TURN_FINISHED:second live turn/u);
  await session.waitForScreen("thinking activity remains visible", /thinking/u);
  session.send("\x03");
  await session.exit();
}, 20_000);

test("Desktop on keeps all restored and live reasoning visible", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-thinking-visible-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/thinking-visibility.ts")],
    workspace,
    env: { ZCODE_TEST_SHOW_REASONING: "true" }
  });
  await session.waitForScreen("transcript is ready", /THINKING_VISIBILITY_READY/u);
  session.send("test visible reasoning\r");
  await session.waitForScreen("first live thought appears", /LIVE_FIRST_THOUGHT_VISIBLE_TURN_SENTINEL/u);
  await session.waitForScreen("later live thought appears", /LIVE_SECOND_THOUGHT_VISIBLE_TURN_SENTINEL/u);
  session.send("\x0f");
  await session.waitForScreen("restored first thought appears after expanding", /RESTORED_FIRST_THOUGHT_SENTINEL/u);
  await session.waitForScreen("restored later thought appears after expanding", /RESTORED_SECOND_THOUGHT_SENTINEL/u);
  await session.waitForScreen("later assistant message thought appears", /RESTORED_LATER_MESSAGE_THOUGHT_SENTINEL/u);
  await session.waitForScreen("next turn thought appears", /RESTORED_NEXT_TURN_FIRST_THOUGHT_SENTINEL/u);
  session.send("\x03");
  await session.exit();
}, 20_000);
