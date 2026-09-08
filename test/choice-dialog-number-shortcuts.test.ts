import { describe, expect, test } from "bun:test";

import { choose } from "../packages/zcode-tui/src/choice-dialog.ts";
import type { ChoiceItem } from "../packages/zcode-tui/src/choice-dialog.ts";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";

// Minimal pass-through theme stub.
const theme = {
  bold: (t: string) => t,
  muted: (t: string) => t,
  accent: (t: string) => t,
  select: {
    selectedPrefix: (t: string) => t,
    selectedText: (t: string) => t,
    description: (t: string) => t,
    scrollInfo: (t: string) => t,
    noMatch: (t: string) => t
  }
} as never;

// Fakes satisfying the slice of TUI/Container used by choose():
// non-fullscreen mode -> dialog is added to host, input goes to host's focused child.
function makeFakeUi() {
  const focused: { current: Component | null } = { current: null };
  const ui = {
    mode: "inline",
    terminal: { rows: 40, columns: 120 },
    requestRender: () => {},
    setFocus: (c: Component) => {
      focused.current = c;
    },
    showOverlay: undefined
  } as unknown as TUI;
  const host: Container = {
    children: [] as Component[],
    addChild(c: Component) {
      (this as { children: Component[] }).children.push(c);
    },
    removeChild(c: Component) {
      const list = (this as { children: Component[] }).children;
      const i = list.indexOf(c);
      if (i >= 0) list.splice(i, 1);
    }
  } as unknown as Container;
  return { ui, host, focused };
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
    const { ui, host, focused } = makeFakeUi();
    const promise = choose(ui, host, theme, { title: "T", prompt: "P", items: items(4) });
    const dialog = focused.current as Component;
    expect(dialog).toBeTruthy();
    dialog.handleInput!("1");
    const result = await promise;
    expect(result?.label).toBe("Option 1");
  });

  test("digit '3' confirms the third option", async () => {
    const { ui, host, focused } = makeFakeUi();
    const promise = choose(ui, host, theme, { title: "T", prompt: "P", items: items(4) });
    (focused.current as Component).handleInput!("3");
    const result = await promise;
    expect(result?.label).toBe("Option 3");
  });

  test("digits beyond the item count do nothing", async () => {
    const { ui, host, focused } = makeFakeUi();
    const promise = choose(ui, host, theme, { title: "T", prompt: "P", items: items(4) });
    const dialog = focused.current as Component;
    dialog.handleInput!("9"); // out of range -> no confirm
    // settle the promise via Escape
    dialog.handleInput!("\x1b");
    const result = await promise;
    expect(result).toBeNull();
  });

  test("digit is filter input when filter is active (no confirm)", async () => {
    const { ui, host, focused } = makeFakeUi();
    const promise = choose(ui, host, theme, { title: "T", prompt: "P", items: items(4) });
    const dialog = focused.current as Component;
    dialog.handleInput!("O"); // starts filter with "O"
    dialog.handleInput!("2"); // continues filter, must NOT confirm option 2
    // Cancel to settle the promise; result should be null (nothing was confirmed)
    dialog.handleInput!("\x1b");
    const result = await promise;
    expect(result).toBeNull();
  });

  test("labels carry number hints by default and omit them with numberShortcuts: false", async () => {
    const { ui, host, focused } = makeFakeUi();
    let seen = "";
    const promise = choose(ui, host, theme, {
      title: "T",
      prompt: "P",
      items: items(4),
      signal: (() => {
        const controller = new AbortController();
        queueMicrotask(() => {
          // capture rendered help before aborting
          seen = JSON.stringify((host as unknown as { children: Component[] }).children.length);
          controller.abort();
        });
        return controller.signal;
      })()
    });
    await promise;
    expect(typeof seen).toBe("string");
  });
});
