import { describe, expect, test } from "bun:test";
import {
  Container,
  type Component,
  type TUI
} from "@earendil-works/pi-tui";

import { choose, promptText } from "../packages/zcode-tui/src/choice-dialog.ts";
import { PermissionRequestQueue, permissionRequestSignal } from "../packages/zcode-tui/src/permission-request-queue.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

function dialogHarness(): {
  focus: { current: Component | null };
  host: Container;
  ui: TUI;
} {
  const focus: { current: Component | null } = { current: null };
  const host = new Container();
  const ui = {
    terminal: { columns: 100, rows: 24 },
    requestRender() {},
    setFocus(component: Component | null) {
      focus.current = component;
    }
  } as unknown as TUI;
  return { focus, host, ui };
}

function permissionDialog(ui: TUI, host: Container, title: string, signal?: AbortSignal) {
  return choose(ui, host, createTheme(false), {
    title,
    prompt: `${title} requests permission to continue.`,
    items: [{ value: "allow", label: "Allow" }],
    signal
  });
}

describe("permission request queue", () => {
  test("presents concurrent permission dialogs one at a time", async () => {
    const queue = new PermissionRequestQueue();
    const { focus, host, ui } = dialogHarness();

    const first = queue.run(async () => {
      const decision = await permissionDialog(ui, host, "First tool");
      const feedback = await promptText(ui, host, createTheme(false), {
        title: "First tool follow-up",
        prompt: "Complete the first permission interaction."
      });
      return { decision, feedback };
    });
    const second = queue.run(() => permissionDialog(ui, host, "Second tool"));
    await Promise.resolve();

    expect(host.children).toHaveLength(1);
    expect(host.render(100).join("\n")).toContain("First tool");
    expect(focus.current).toBe(host.children[0] ?? null);

    host.children[0]?.handleInput?.("\r");
    await Promise.resolve();

    expect(host.children).toHaveLength(1);
    expect(host.render(100).join("\n")).toContain("First tool follow-up");
    expect(host.render(100).join("\n")).not.toContain("Second tool");
    focus.current?.handleInput?.("Approved after review.");
    focus.current?.handleInput?.("\r");
    expect(await first).toEqual({
      decision: expect.objectContaining({ value: "allow" }),
      feedback: "Approved after review."
    });
    await Promise.resolve();

    expect(host.children).toHaveLength(1);
    expect(host.render(100).join("\n")).toContain("Second tool");
    expect(focus.current).toBe(host.children[0] ?? null);

    host.children[0]?.handleInput?.("\x1b");
    expect(await second).toBeNull();
    expect(host.children).toHaveLength(0);
  });

  test("settles active and queued dialogs when their turn is aborted", async () => {
    const queue = new PermissionRequestQueue();
    const { host, ui } = dialogHarness();
    const controller = new AbortController();

    const first = queue.run(() => permissionDialog(ui, host, "First tool", controller.signal));
    const second = queue.run(() => permissionDialog(ui, host, "Second tool", controller.signal));
    await Promise.resolve();

    expect(host.children).toHaveLength(1);
    controller.abort();

    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(host.children).toHaveLength(0);
  });

  test("closes a dialog when the runtime settles its request elsewhere", async () => {
    const queue = new PermissionRequestQueue();
    const { focus, host, ui } = dialogHarness();
    // The runtime's permission broker options: a PermissionRequest hook that
    // answers first aborts this signal.
    const hookRace = new AbortController();
    const context = { signal: hookRace.signal, claimResponse: () => true, timeoutMs: 60_000 };

    const settled = queue.run(() => permissionDialog(ui, host, "Write", permissionRequestSignal(context)));
    const next = queue.run(() => permissionDialog(ui, host, "Bash"));
    await Promise.resolve();

    expect(host.render(100).join("\n")).toContain("Write");
    hookRace.abort();

    expect(await settled).toBeNull();
    await Promise.resolve();
    expect(host.children).toHaveLength(1);
    expect(host.render(100).join("\n")).toContain("Bash");
    expect(focus.current).toBe(host.children[0] ?? null);
    host.children[0]?.handleInput?.("\r");
    expect(await next).toMatchObject({ value: "allow" });
  });

  test("reads the request signal from runtime or TUI options", () => {
    const runtime = new AbortController();
    const tui = new AbortController();
    expect(permissionRequestSignal({ signal: runtime.signal })).toBe(runtime.signal);
    expect(permissionRequestSignal({ abortSignal: tui.signal })).toBe(tui.signal);
    expect(permissionRequestSignal({ signal: runtime.signal, abortSignal: tui.signal })).toBe(runtime.signal);
    expect(permissionRequestSignal({ signal: "nope" })).toBeUndefined();
    expect(permissionRequestSignal(undefined)).toBeUndefined();
  });

  test("continues with the next request after an exception", async () => {
    const queue = new PermissionRequestQueue();
    const { host, ui } = dialogHarness();

    const failed = queue.run(async () => {
      throw new Error("permission rendering failed");
    });
    const next = queue.run(() => permissionDialog(ui, host, "Next tool"));

    await expect(failed).rejects.toThrow("permission rendering failed");
    await Promise.resolve();

    expect(host.children).toHaveLength(1);
    expect(host.render(100).join("\n")).toContain("Next tool");
    host.children[0]?.handleInput?.("\r");
    expect(await next).toMatchObject({ value: "allow" });
  });
});
