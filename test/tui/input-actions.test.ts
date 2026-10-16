import { test } from "bun:test";
import { join } from "node:path";
import { ScenarioWorkspace } from "./harness/scenario-workspace.ts";
import { TerminalSession } from "./harness/terminal-session.ts";

test("queue supports pausing, reordering and editing drafts through the keyboard", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-input-actions-" });
  await using session = TerminalSession.start({ command: [process.execPath, join(import.meta.dir, "fixtures/input-actions.ts")], workspace });
  await session.waitForScreen("ready", /Original answer/u);
  await session.sendAndWait("/queue pause\r", "paused", /Queue paused/u);
  session.send("First draft");
  await session.settle();
  session.send("\t");
  await session.waitForScreen("first queued", /1 input/u);
  session.send("Second draft");
  await session.settle();
  session.send("\t");
  await session.waitForScreen("second queued", /2 inputs/u);
  await session.sendAndWait("/queue\r", "queue picker", /Select a draft/u);
  session.send("\x1b[B\r");
  await session.waitForScreen("draft actions", /Move earlier/u);
  session.send("\x1b[B\r");
  await session.waitForScreen("reordered picker", /Select a draft/u);
  session.send("\r");
  await session.waitForScreen("draft actions again", /Move to editor/u);
  session.send("\r");
  await session.waitForScreen("draft restored", /Second draft/u);
  await session.assertScreenExcludes("nothing submitted", /Sent: Second draft/u);
  session.send("\x03");
  await session.settle();
  await session.sendAndWait("/queue resume\r", "remaining input sent", /Sent: First draft/u);
  await session.exit();
}, 20_000);

test.each(["/edit-message", "/retry"])("%s confirms conversation rewind before editing or resending", async (command) => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-message-action-" });
  await using session = TerminalSession.start({ command: [process.execPath, join(import.meta.dir, "fixtures/input-actions.ts")], workspace });
  await session.waitForScreen("ready", /Original answer/u);
  await session.sendAndWait(`${command}\r`, "question picker", /Select the question/u);
  session.send("\r");
  await session.waitForScreen("explicit history scope", /Later conversation turns will be removed/u);
  session.send("\x1b[B\r");
  if (command === "/retry") await session.waitForHistory("question retried", /Sent: Original question/u);
  else {
    await session.waitForHistory("rewind completed", /Conversation rewound\. The selected input was restored to the editor/u);
    await session.waitForScreen("question restored", /Original question/u);
    await session.assertScreenExcludes("edit does not submit", /Sent: Original question/u);
    session.send("\x03");
    await session.settle();
  }
  await session.exit();
}, 20_000);

test("pending images cannot silently move into another queued or retried question", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-input-images-" });
  await using session = TerminalSession.start({ command: [process.execPath, join(import.meta.dir, "fixtures/input-actions.ts")], workspace });
  await session.waitForScreen("ready", /Original answer/u);
  await session.sendAndWait("/queue pause\r", "paused", /Queue paused/u);
  await session.sendAndWait("/paste-image\r", "attached", /1 image attached/u);
  session.send("Image question");
  await session.settle();
  session.send("\t");
  await session.waitForScreen("image cannot queue", /Send or remove pending images before queueing/u);
  session.send("\x03");
  await session.settle();
  await session.sendAndWait("/retry\r", "retry guarded", /Save or clear the current draft/u);
  await session.assertScreenExcludes("no retry sent", /Sent: Original question/u);
  await session.exit();
}, 20_000);

test("resuming queued text preserves an image attached afterwards for the editor", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-queued-images-" });
  await using session = TerminalSession.start({ command: [process.execPath, join(import.meta.dir, "fixtures/input-actions.ts")], workspace });
  await session.waitForScreen("ready", /Original answer/u);
  await session.sendAndWait("/queue pause\r", "paused", /Queue paused/u);
  session.send("Queued text");
  await session.settle();
  session.send("\t");
  await session.waitForScreen("queued", /1 input/u);
  await session.sendAndWait("/paste-image\r", "attached after queue", /1 image attached/u);
  await session.sendAndWait("/queue resume\r", "text sent without image", /Sent: Queued text/u);
  await session.waitForScreen("image remains", /\[Image #1\]/u);
  await session.sendAndWait("Image question\r", "editor image sent", /Sent: Image question with original image/u);
  await session.assertScreenExcludes("sent image leaves editor", /\[Image #1\]/u);
  await session.exit();
}, 20_000);

test("ctrl+c clears the editor text on screen without waiting for the next keypress", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-input-clear-" });
  await using session = TerminalSession.start({ command: [process.execPath, join(import.meta.dir, "fixtures/input-actions.ts")], workspace });
  await session.waitForScreen("ready", /Original answer/u);
  session.send("stale draft");
  await session.waitForScreen("draft visible", /stale draft/u);
  session.send("\x03");
  await session.settle();
  await session.assertScreenExcludes("cleared draft no longer visible", /stale draft/u);
  await session.exit();
}, 20_000);

test("ctrl+f replaces editor text with the /search prefill on screen", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-input-search-" });
  await using session = TerminalSession.start({ command: [process.execPath, join(import.meta.dir, "fixtures/input-actions.ts")], workspace });
  await session.waitForScreen("ready", /Original answer/u);
  session.send("stale draft");
  await session.waitForScreen("draft visible", /stale draft/u);
  session.send("\x06");
  await session.settle();
  await session.assertScreenExcludes("replaced draft no longer visible", /stale draft/u);
  await session.waitForScreen("search prefill visible", /\/search/u);
  session.send("\x03");
  await session.settle();
  await session.exit();
}, 20_000);

test("fragmented terminal palette replies do not enter the draft or trigger input actions", async () => {
  await using workspace = await ScenarioWorkspace.create({ prefix: "zcode-color-replies-" });
  await using session = TerminalSession.start({
    command: [process.execPath, join(import.meta.dir, "fixtures/input-actions.ts")],
    workspace,
    env: { NO_COLOR: "", COLORFGBG: "15;0", EDITOR: "true", VISUAL: "true" }
  });
  await session.waitForScreen("ready", /Original answer/u);
  session.send("retained draft");
  await session.waitForScreen("draft visible", /retained draft/u);
  for (const fragment of [
    "\x1b]10;rgb:", "1111/2222/3333", "\x07",
    "\x1b]11;rgb:ffff", "/eeee/dddd", "\x1b\\",
    "\x1b]4;2;rgb:", "1234/5678/9abc", "\x07",
    "\x1b[?1;2c"
  ]) {
    session.send(fragment);
    await session.settle();
  }
  await session.assertScreenExcludes("palette replies stay out of the draft", /rgb:|1111|2222|ffff|9abc/u);
  await session.sendAndWait(" tail\r", "unaltered draft submitted", /Sent: retained draft tail/u);
  await session.exit();
}, 20_000);
