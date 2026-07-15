import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { AttachmentBar } from "../packages/zcode-tui/src/attachment-bar.ts";
import type { PromptImageAttachment } from "../packages/zcode-tui/src/attachments.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

const images = (count: number): PromptImageAttachment[] => Array.from(
  { length: count },
  (_, index) => ({
    type: "image",
    content: `data:image/png;base64,${index}`,
    mediaType: "image/png",
    sizeBytes: 1_024
  })
);

describe("TUI attachment bar", () => {
  test("renders complete image tokens and a discoverable management hint", () => {
    const bar = new AttachmentBar(createTheme(false), {
      onExit: () => {},
      onRemove: () => {},
      onRender: () => {}
    });
    bar.setAttachments(images(2));

    const lines = bar.render(80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Images · [Image #1] · [Image #2]");
    expect(lines[0]).toContain("↑ manage");
  });

  test("selects, wraps, removes, and relabels attachments without touching the editor", () => {
    let attachments = images(2);
    const removed: number[] = [];
    let renderRequests = 0;
    let exits = 0;
    let bar!: AttachmentBar;
    bar = new AttachmentBar(createTheme(false), {
      onExit: () => {
        exits += 1;
        bar.deactivate();
      },
      onRemove: (index) => {
        removed.push(index);
        attachments.splice(index, 1);
        bar.setAttachments(attachments);
      },
      onRender: () => {
        renderRequests += 1;
      }
    });
    bar.setAttachments(attachments);

    expect(bar.activate()).toBeTrue();
    expect(bar.getSelectedIndex()).toBe(1);
    expect(bar.render(80).join("\n")).toContain("› [Image #2]");

    bar.handleInput("\x1b[D");
    expect(bar.getSelectedIndex()).toBe(0);
    bar.handleInput("\x1b[C");
    expect(bar.getSelectedIndex()).toBe(1);
    bar.handleInput("\x1b[C");
    expect(bar.getSelectedIndex()).toBe(0);
    bar.handleInput("\x1b[D");
    expect(bar.getSelectedIndex()).toBe(1);
    expect(renderRequests).toBe(4);

    bar.handleInput("\x1b[3~");
    expect(removed).toEqual([1]);
    expect(bar.getSelectedIndex()).toBe(0);
    expect(bar.render(80).join("\n")).toContain("› [Image #1]");
    expect(bar.render(80).join("\n")).not.toContain("Image #2");

    bar.handleInput("\x1b[B");
    expect(exits).toBe(1);
    expect(bar.isActive()).toBeFalse();

    bar.activate();
    bar.handleInput("\x7f");
    expect(removed).toEqual([1, 0]);
    expect(bar.render(80)).toEqual([]);
    expect(bar.isActive()).toBeFalse();
  });

  test("uses a complete compact selection at narrow terminal widths", () => {
    const bar = new AttachmentBar(createTheme(false), {
      onExit: () => {},
      onRemove: () => {},
      onRender: () => {}
    });
    bar.setAttachments(images(3));
    bar.activate();

    const lines = bar.render(24);
    expect(lines[0]).toContain("› Image 3/3");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBeTrue();
  });

  test("returns to the editor through every documented exit key", () => {
    let exits = 0;
    let bar!: AttachmentBar;
    bar = new AttachmentBar(createTheme(false), {
      onExit: () => {
        exits += 1;
        bar.deactivate();
      },
      onRemove: () => {},
      onRender: () => {}
    });
    bar.setAttachments(images(1));

    for (const key of ["\x1b[B", "\x1b", "\x03", "\r"]) {
      bar.activate();
      bar.handleInput(key);
      expect(bar.isActive()).toBeFalse();
    }
    expect(exits).toBe(4);
  });

  test("marks selection structurally when colors are disabled", () => {
    const bar = new AttachmentBar(createTheme(false), {
      onExit: () => {},
      onRemove: () => {},
      onRender: () => {}
    });
    bar.setAttachments(images(1));
    bar.activate();

    expect(bar.render(80)[0]).toContain("› [Image #1]");
  });
});
