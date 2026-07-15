import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { QueuedInputView } from "../packages/zcode-tui/src/queued-input-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("TUI queued follow-up inputs", () => {
  test("renders unsent inputs with a discoverable edit shortcut", () => {
    const view = new QueuedInputView(createTheme(false));
    view.setState({
      pendingSteers: [],
      queuedInputs: ["first follow-up", "second follow-up"]
    });

    const output = view.render(80).join("\n");
    expect(output).toContain("Queued next turn · 2 inputs");
    expect(output).toContain("↳ first follow-up");
    expect(output).toContain("↳ second follow-up");
    expect(output).toContain("Alt+Up / Shift+Left edit last");
  });

  test("bounds long and numerous inputs at narrow widths", () => {
    const view = new QueuedInputView(createTheme(false));
    view.setState({
      pendingSteers: [],
      queuedInputs: [
        "first",
        "second",
        "third",
        "fourth follow-up with a deliberately long description"
      ]
    });

    const lines = view.render(24);
    expect(lines).toHaveLength(6);
    expect(lines.join("\n")).toContain("… 1 earlier");
    expect(lines.join("\n")).not.toContain("↳ first");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBeTrue();
  });

  test("stays hidden without queued inputs", () => {
    const view = new QueuedInputView(createTheme(false));
    expect(view.render(80)).toEqual([]);
  });

  test("keeps undrained steers next to the editor instead of transcript history", () => {
    const view = new QueuedInputView(createTheme(false));
    view.setState({
      pendingSteers: ["Use the simpler implementation."],
      queuedInputs: ["Add regression tests next."]
    });

    const output = view.render(80).join("\n");
    expect(output).toContain("Steering current turn · 1 waiting");
    expect(output).toContain("↪ Use the simpler implementation.");
    expect(output).toContain("waiting for the next model step");
    expect(output).toContain("Queued next turn · 1 input");
  });
});
