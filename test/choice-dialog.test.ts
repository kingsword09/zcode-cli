import { describe, expect, test } from "bun:test";
import {
  Container,
  Text,
  visibleWidth,
  type Component,
  type TUI
} from "@earendil-works/pi-tui";

import { choose, promptText } from "../packages/zcode-tui/src/choice-dialog.ts";
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

  test("masked prompts return the secret without rendering it", async () => {
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

    const pending = promptText(ui, host, createTheme(false), {
      title: "Enter API key",
      prompt: "The key stays hidden.",
      mask: true,
      placeholder: "Paste API key"
    });

    expect(root.render(80).join("\n")).toContain("Paste API key");
    focusState.current?.handleInput?.("secret-value-123");
    const rendered = root.render(80).join("\n");
    expect(rendered).not.toContain("secret-value-123");
    expect(rendered).toContain("****************");

    focusState.current?.handleInput?.("\r");
    expect(await pending).toBe("secret-value-123");
    expect(host.children).toHaveLength(0);
  });

  test("expands and scrolls long plan details without changing the selected action", async () => {
    const root = new Container();
    const host = new Container();
    const focusState: { current: Component | null } = { current: null };
    const ui = {
      terminal: { rows: 18 },
      requestRender() {},
      setFocus(component: Component | null) {
        focusState.current = component;
      }
    } as unknown as TUI;
    root.addChild(host);

    const pending = choose(ui, host, createTheme(false), {
      title: "Ready to implement?",
      prompt: "Review the plan and choose how ZCode should continue.",
      contentLabel: "Plan",
      content: new Text(
        Array.from({ length: 30 }, (_, index) => `plan line ${index + 1}`).join("\n"),
        0,
        0
      ),
      items: [
        { value: "approve", label: "Approve and continue" },
        { value: "refine", label: "Keep planning" }
      ]
    });

    let output = root.render(60).join("\n");
    expect(output).toContain("plan line 1");
    expect(output).not.toContain("plan line 30");
    expect(output).toContain("Plan 1–6 of 30");
    expect(output).toContain("Ctrl+O details");

    focusState.current?.handleInput?.("\x0f");
    output = root.render(60).join("\n");
    expect(output).toContain("Ready to implement? · Plan");
    expect(output).not.toContain("Approve and continue");
    expect(output).toContain("Plan 1–9 of 30");

    focusState.current?.handleInput?.("\x1b[6~");
    output = root.render(60).join("\n");
    expect(output).toContain("plan line 9");
    expect(output).toContain("Plan 9–17 of 30");

    focusState.current?.handleInput?.("\x1b[F");
    output = root.render(60).join("\n");
    expect(output).toContain("plan line 30");
    expect(output).toContain("Plan 22–30 of 30");

    focusState.current?.handleInput?.("\x1b");
    output = root.render(60).join("\n");
    expect(output).toContain("Approve and continue");
    focusState.current?.handleInput?.("\x1b[B");
    focusState.current?.handleInput?.("\r");
    expect(await pending).toMatchObject({ value: "refine" });
  });

  test("pages windowed plan content without materializing the full document", async () => {
    const root = new Container();
    const host = new Container();
    const focusState: { current: Component | null } = { current: null };
    let fullRenders = 0;
    const content: Component & {
      renderWindow(width: number, start: number, count: number): { lines: string[]; totalLines: number };
    } = {
      invalidate() {},
      render() {
        fullRenders += 1;
        throw new Error("windowed content must not use full render");
      },
      renderWindow(_width, start, count) {
        return {
          lines: Array.from({ length: Math.min(count, 50_000 - start) }, (_, index) => `plan line ${start + index + 1}`),
          totalLines: 50_000
        };
      }
    };
    const ui = {
      terminal: { rows: 18, columns: 60 },
      requestRender() {},
      setFocus(component: Component | null) {
        focusState.current = component;
      }
    } as unknown as TUI;
    root.addChild(host);

    const pending = choose(ui, host, createTheme(false), {
      title: "Ready to implement?",
      prompt: "Review the plan.",
      contentLabel: "Plan",
      content,
      items: [{ value: "approve", label: "Approve" }]
    });
    expect(root.render(60).join("\n")).toContain("Plan 1–7 of 50000");
    focusState.current?.handleInput?.("\x0f");
    focusState.current?.handleInput?.("\x1b[6~");
    expect(root.render(60).join("\n")).toContain("plan line 9");
    expect(fullRenders).toBe(0);
    focusState.current?.handleInput?.("\x1b");
    focusState.current?.handleInput?.("\x1b");
    expect(await pending).toBeNull();
  });

  test("keeps the moved selection explicit on light terminals", async () => {
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

    const pending = choose(ui, host, createTheme(true, "light"), {
      title: "Choose action",
      prompt: "Select one.",
      items: [
        { value: "first", label: "First action" },
        { value: "second", label: "Second action" }
      ]
    });

    expect(root.render(60).find((line) => line.includes("First action")))
      .toContain("\x1b[38;5;25m");
    focusState.current?.handleInput?.("\x1b[B");
    expect(root.render(60).find((line) => line.includes("Second action")))
      .toContain("\x1b[38;5;25m");
    focusState.current?.handleInput?.("\r");
    expect(await pending).toMatchObject({ value: "second" });
  });

  test("wraps the selected item's complete label and description in a details viewport", async () => {
    const root = new Container();
    const host = new Container();
    const focusState: { current: Component | null } = { current: null };
    const ui = {
      terminal: { rows: 24, columns: 52 },
      requestRender() {},
      setFocus(component: Component | null) {
        focusState.current = component;
      }
    } as unknown as TUI;
    root.addChild(host);

    const firstDescription = "Reuse the deterministic offline fixture so the recording remains reproducible without provider credentials.";
    const secondDescription = "Record a live provider session whose unique ending remains visible after moving the selection.";
    const pending = choose(ui, host, createTheme(false), {
      title: "Demo driver · 1/4",
      prompt: "How should the recording be produced?",
      contentLabel: "Option details",
      showSelectedItemDetails: true,
      items: [
        {
          value: "fixture",
          label: "Fixture-based recording with a deliberately long recommended label",
          description: firstDescription
        },
        { value: "live", label: "Live headless prompt", description: secondDescription }
      ]
    });

    const normalized = () => root.render(52).join("\n").replace(/\s+/gu, " ");
    expect(normalized()).toContain("Fixture-based recording with a deliberately long recommended label");
    expect(normalized()).toContain(firstDescription);
    expect(normalized()).not.toContain("unique ending remains visible");
    expect(root.render(52).every((line) => visibleWidth(line) <= 52)).toBe(true);

    focusState.current?.handleInput?.("\x1b[B");
    expect(normalized()).toContain(secondDescription);
    expect(normalized()).not.toContain("remains reproducible without provider credentials");
    focusState.current?.handleInput?.("\r");
    expect(await pending).toMatchObject({ value: "live" });
  });

  test("keeps choice and text prompt chrome within narrow terminal widths", async () => {
    for (const width of [8, 20, 40, 60, 80, 100, 120]) {
      const choiceRoot = new Container();
      const choiceHost = new Container();
      const choiceFocus: { current: Component | null } = { current: null };
      const choiceUi = {
        terminal: { rows: 24, columns: width },
        requestRender() {},
        setFocus(component: Component | null) {
          choiceFocus.current = component;
        }
      } as unknown as TUI;
      choiceRoot.addChild(choiceHost);
      const choicePending = choose(choiceUi, choiceHost, createTheme(true, "dark"), {
        title: "A deliberately long choice dialog title that must remain width-safe",
        prompt: "Review every available action and select how ZCode should continue from this point.",
        help: "Type to filter · Up/Down choose · Ctrl+O details · PgUp/PgDn scroll · Enter confirm · Esc cancel",
        items: [{ value: "close", label: "Close this width verification dialog" }]
      });
      expect(choiceRoot.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      choiceFocus.current?.handleInput?.("\x1b");
      expect(await choicePending).toBeNull();

      const promptRoot = new Container();
      const promptHost = new Container();
      const promptFocus: { current: Component | null } = { current: null };
      const promptUi = {
        terminal: { rows: 24, columns: width },
        requestRender() {},
        setFocus(component: Component | null) {
          promptFocus.current = component;
        }
      } as unknown as TUI;
      promptRoot.addChild(promptHost);
      const promptPending = promptText(promptUi, promptHost, createTheme(true, "light"), {
        title: "A deliberately long prompt title that must remain width-safe",
        prompt: "Enter a value while retaining all instructions on narrow terminal screens.",
        help: "Enter confirm · Esc cancel · pasted values remain local to this prompt"
      });
      expect(promptRoot.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      promptFocus.current?.handleInput?.("\x1b");
      expect(await promptPending).toBeNull();
    }
  });
});
