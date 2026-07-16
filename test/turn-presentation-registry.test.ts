import { describe, expect, test } from "bun:test";

import { Transcript } from "../packages/zcode-tui/src/transcript.ts";
import { ProtocolPartView } from "../packages/zcode-tui/src/protocol-part-view.ts";
import { ThinkingView } from "../packages/zcode-tui/src/thinking-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { ToolTreeView } from "../packages/zcode-tui/src/tool-tree-view.ts";
import { ToolExecutionView } from "../packages/zcode-tui/src/tool-view.ts";
import { TurnPresentationRegistry } from "../packages/zcode-tui/src/turn-presentation-registry.ts";

interface ToolState {
  tree: ToolTreeView;
}

function tool(name: string): ToolTreeView {
  const theme = createTheme(false);
  return new ToolTreeView(theme, new ToolExecutionView(theme, { name, state: "complete" }));
}

function populate(
  registry: TurnPresentationRegistry<ToolState>,
  index: number
): void {
  const id = `part_${index}`;
  const theme = createTheme(false);
  registry.thinkingParts.set(id, new ThinkingView(theme));
  registry.protocolPartViews.set(id, new ProtocolPartView(theme, {
    type: "file",
    text: `file ${index}`
  }));
  registry.protocolPartKinds.set(id, "tool");
  registry.protocolPartMessages.set(id, `message_${index}`);
  registry.protocolPartTools.set(id, `tool_${index}`);
  registry.toolViews.set(`tool_${index}`, { tree: tool("Read") });
  registry.pendingToolParents.set(`child_${index}`, `tool_${index}`);
  registry.pendingToolProgress.set(`tool_${index}`, { elapsedMs: index });
}

describe("turn presentation registry", () => {
  test("retains indexes for only the latest turn", () => {
    const unbounded = new TurnPresentationRegistry<ToolState>();
    const registry = new TurnPresentationRegistry<ToolState>();
    for (let turn = 1; turn <= 1_000; turn += 1) {
      populate(unbounded, turn);
      registry.beginTurn();
      populate(registry, turn);
    }

    expect(unbounded.sizes().total).toBe(8_000);
    expect(registry.sizes()).toEqual({
      thinkingParts: 1,
      protocolPartViews: 1,
      protocolPartKinds: 1,
      protocolPartMessages: 1,
      protocolPartTools: 1,
      toolViews: 1,
      pendingToolParents: 1,
      pendingToolProgress: 1,
      total: 8
    });
  });

  test("releases lookup roots without mutating settled transcript trees", () => {
    const registry = new TurnPresentationRegistry<ToolState>();
    const parent = tool("Agent");
    const child = tool("Read");
    parent.addChild(child);
    parent.setExpanded(true);
    const transcript = new Transcript();
    transcript.addBlock(parent, { kind: "tool", searchText: () => parent.getSearchText() });
    transcript.setExpanded(true);
    registry.toolViews.set("parent", { tree: parent });
    registry.toolViews.set("child", { tree: child });

    const before = transcript.render(80);
    expect(before.join("\n")).toContain("Read");
    registry.beginTurn();

    expect(registry.sizes().total).toBe(0);
    expect(transcript.render(80)).toEqual(before);
    expect(transcript.searchFor("Read")).toMatchObject({ current: 1, total: 1 });
  });
});
