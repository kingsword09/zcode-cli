import { describe, expect, test } from "bun:test";
import {
  Container,
  Text,
  type Component,
  type TUI
} from "@earendil-works/pi-tui";

import { choose } from "../packages/zcode-tui/src/choice-dialog.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("TUI choice dialog", () => {
  test("renders after a long transcript instead of compositing into its viewport", async () => {
    const root = new Container();
    const transcript = new Text(
      Array.from({ length: 40 }, (_, index) => `help line ${index + 1}`).join("\n"),
      0,
      0
    );
    const host = new Container();
    const status = new Text("model · build · max", 0, 0);
    const focusState: { current: Component | null } = { current: null };
    const ui = {
      terminal: { rows: 24 },
      requestRender() {},
      setFocus(component: Component | null) {
        focusState.current = component;
      }
    } as unknown as TUI;

    root.addChild(transcript);
    root.addChild(host);
    root.addChild(status);

    const pending = choose(ui, host, createTheme(false), {
      title: "Select reasoning effort",
      prompt: "Current reasoning effort: max.",
      items: [
        { value: "low", label: "Low" },
        { value: "max", label: "Max" }
      ],
      selectedIndex: 1
    });

    const lines = root.render(80);
    const helpIndex = lines.findIndex((line) => line.includes("help line 40"));
    const dialogIndex = lines.findIndex((line) => line.includes("Select reasoning effort"));
    const statusIndex = lines.findIndex((line) => line.includes("model · build"));

    expect(helpIndex).toBeGreaterThanOrEqual(0);
    expect(dialogIndex).toBeGreaterThan(helpIndex);
    expect(statusIndex).toBeGreaterThan(dialogIndex);
    expect(focusState.current).toBe(host.children[0] ?? null);

    host.children[0]?.handleInput?.("\r");
    expect(await pending).toMatchObject({ value: "max" });
    expect(host.children).toHaveLength(0);
  });
});
