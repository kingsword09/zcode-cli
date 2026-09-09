import { describe, expect, test } from "bun:test";
import { Container, type Component, type TUI } from "@earendil-works/pi-tui";

import { choose } from "../packages/zcode-tui/src/choice-dialog.ts";
import type { ChoiceItem } from "../packages/zcode-tui/src/choice-dialog.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

const theme = createTheme(false);

// Inline-mode harness matching choice-dialog.test.ts: real pi-tui Container,
// dialog mounts into `host`, render `root` to assert on actual dialog output.
function makeHarness() {
  const root = new Container();
  const host = new Container();
  const focusState: { current: Component | null } = { current: null };
  const ui = {
    terminal: { rows: 24 },
    requestRender() {},
    setFocus(component: Component | null) {
      focusState.current = component;
    }
  } as unknown as TUI;
  root.addChild(host);
  return { root, host, focusState, ui };
}

function rendered(root: Container): string {
  return root.render(80).join("\n");
}

function items(count: number): ChoiceItem[] {
  return Array.from({ length: count }, (_, i) => ({
    value: `opt${i + 1}`,
    label: `Option ${i + 1}`,
    description: `desc ${i + 1}`
  }));
}

describe("choice dialog number shortcuts", () => {
  test("digit '1' confirms the first option in one keystroke", async () => {
    const { host, focusState, ui } = makeHarness();
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      items: items(4),
      numberShortcuts: true
    });
    const dialog = focusState.current as Component;
    expect(dialog).toBeTruthy();
    dialog.handleInput!("1");
    const result = await promise;
    expect(result?.label).toBe("Option 1");
  });

  test("digit '3' confirms the third option", async () => {
    const { host, focusState, ui } = makeHarness();
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      items: items(4),
      numberShortcuts: true
    });
    (focusState.current as Component).handleInput!("3");
    const result = await promise;
    expect(result?.label).toBe("Option 3");
  });

  test("digits beyond the item count do nothing", async () => {
    const { host, focusState, ui } = makeHarness();
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      items: items(4),
      numberShortcuts: true
    });
    const dialog = focusState.current as Component;
    dialog.handleInput!("9"); // out of range -> no confirm
    // settle the promise via Escape
    dialog.handleInput!("\x1b");
    const result = await promise;
    expect(result).toBeNull();
  });

  test("digit is filter input when filter is active (no confirm)", async () => {
    const { root, host, focusState, ui } = makeHarness();
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      items: items(4),
      numberShortcuts: true
    });
    const dialog = focusState.current as Component;
    dialog.handleInput!("O"); // starts filter with "O"
    dialog.handleInput!("2"); // continues filter, must NOT confirm option 2
    expect(rendered(root)).toContain("Filter: O2");
    // Cancel to settle the promise; result should be null (nothing was confirmed)
    dialog.handleInput!("\x1b");
    const result = await promise;
    expect(result).toBeNull();
  });

  test("labels carry number hints and the number-selects help by default", async () => {
    const { root, host, focusState, ui } = makeHarness();
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      items: items(4),
      numberShortcuts: true
    });
    const output = rendered(root);
    expect(output).toContain("1. Option 1");
    expect(output).toContain("4. Option 4");
    expect(output).not.toContain("5. Option");
    expect(output.replace(/\n/g, " ")).toContain("number selects");
    focusState.current?.handleInput?.("\x1b");
    expect(await promise).toBeNull();
  });

  test("number shortcuts are opt-in for generic choice dialogs", async () => {
    const { root, host, focusState, ui } = makeHarness();
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      items: items(4)
    });
    const output = rendered(root);
    expect(output).not.toContain("1. Option 1");
    expect(output).not.toContain("number selects");
    focusState.current?.handleInput?.("1");
    expect(rendered(root)).toContain("Filter: 1");
    focusState.current?.handleInput?.("\x1b");
    expect(await promise).toBeNull();
  });

  test("numberShortcuts: false omits hints and keeps digits as filter input", async () => {
    const { root, host, focusState, ui } = makeHarness();
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      items: items(4),
      numberShortcuts: false
    });
    const output = rendered(root);
    expect(output).not.toContain("1. Option 1");
    expect(output).toContain("Option 1");
    expect(output.replace(/\n/g, " ")).not.toContain("number selects");
    // The shortcut is off: the digit must remain filter input.
    focusState.current?.handleInput?.("1");
    expect(rendered(root)).toContain("Filter: 1");
    focusState.current?.handleInput?.("\x1b");
    const result = await promise;
    expect(result).toBeNull();
  });

  test("more than 9 items: no hints, no shortcut, help line not advertised", async () => {
    const { root, host, focusState, ui } = makeHarness();
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      items: items(12),
      numberShortcuts: true
    });
    const output = rendered(root);
    expect(output).not.toContain("1. Option 1");
    expect(output.replace(/\n/g, " ")).not.toContain("number selects");
    // A digit must remain filter input because lists over 9 items never expose
    // single-key numeric selection.
    focusState.current?.handleInput?.("3");
    expect(rendered(root)).toContain("Filter: 3");
    focusState.current?.handleInput?.("\x1b");
    const result = await promise;
    expect(result).toBeNull();
  });

  test("custom help suppresses hints and the shortcut by default", async () => {
    const { root, host, focusState, ui } = makeHarness();
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      help: "custom help line",
      items: items(4)
    });
    const output = rendered(root);
    expect(output).toContain("custom help line");
    expect(output).not.toContain("1. Option 1");
    focusState.current?.handleInput?.("1");
    expect(rendered(root)).toContain("Filter: 1");
    focusState.current?.handleInput?.("\x1b");
    const result = await promise;
    expect(result).toBeNull();
  });

  test("numberShortcuts: true force-enables the shortcut despite custom help", async () => {
    const { host, focusState, ui } = makeHarness();
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      help: "custom help line",
      items: items(4),
      numberShortcuts: true
    });
    const dialog = focusState.current as Component;
    dialog.handleInput!("2");
    const result = await promise;
    expect(result?.label).toBe("Option 2");
  });
});
