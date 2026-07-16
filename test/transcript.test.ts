import { describe, expect, test } from "bun:test";
import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";

import {
  MAX_RETAINED_TRANSCRIPT_BLOCKS,
  MAX_RETAINED_TRANSCRIPT_HISTORY_CHARACTERS,
  Transcript
} from "../packages/zcode-tui/src/transcript.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("TUI transcript", () => {
  test("separates top-level conversation blocks by one line", () => {
    const transcript = new Transcript();
    transcript.addBlock(new Text("› user", 0, 0));
    transcript.addBlock(new Text("assistant", 0, 0));
    transcript.addBlock(new Text("› next", 0, 0));

    expect(transcript.render(80).map((line) => line.trimEnd())).toEqual([
      "› user",
      "",
      "assistant",
      "",
      "› next",
      ""
    ]);
  });

  test("keeps only the intentional bottom margin after clearing", () => {
    const transcript = new Transcript();
    transcript.addBlock(new Text("first", 0, 0));
    transcript.clear();
    transcript.addBlock(new Text("restored", 0, 0));

    expect(transcript.render(80).map((line) => line.trimEnd())).toEqual(["restored", ""]);
  });

  test("does not reserve a bottom margin for an empty transcript", () => {
    expect(new Transcript().render(80)).toEqual([]);
  });

  test("upserts protocol blocks in place and removes complete messages", () => {
    const transcript = new Transcript();
    transcript.addBlock(new Text("old", 0, 0), { id: "part_1", messageId: "message_1" });
    transcript.addBlock(new Text("second", 0, 0), { id: "part_2", messageId: "message_1" });
    transcript.addBlock(new Text("other", 0, 0), { id: "part_3", messageId: "message_2" });
    transcript.addBlock(new Text("updated", 0, 0), { id: "part_1", messageId: "message_1" });

    expect(transcript.blockCount).toBe(3);
    expect(transcript.render(80).join("\n")).not.toContain("old");
    expect(transcript.render(80).join("\n")).toContain("updated");
    expect(transcript.removeMessage("message_1")).toBe(2);
    expect(transcript.blockCount).toBe(1);
    expect(transcript.render(80).join("\n")).toContain("other");
  });

  test("navigates individual blocks and expands only the focused component", () => {
    const transcript = new Transcript((text) => `[${text}]`);
    transcript.addBlock(new Text("first", 0, 0), { kind: "user", searchText: "first prompt" });
    transcript.addBlock(new Text("second", 0, 0), { kind: "assistant", searchText: "second response" });

    expect(transcript.selectLatest()).toEqual({ current: 2, total: 2, kind: "assistant" });
    expect(transcript.selectedText()).toBe("second response");
    expect(transcript.render(80).join("\n")).toContain("› second");
    expect(transcript.moveCursor(-1)).toEqual({ current: 1, total: 2, kind: "user" });
  });

  test("highlights search matches and exposes n/N-compatible cursor state", () => {
    const transcript = new Transcript((text) => `<${text}>`);
    transcript.addBlock(new Text("Alpha result", 0, 0), { searchText: "Alpha result" });
    transcript.addBlock(new Text("Other", 0, 0), { searchText: "Other" });
    transcript.addBlock(new Text("alpha again", 0, 0), { searchText: "alpha again" });

    expect(transcript.searchFor("alpha")).toEqual({ query: "alpha", current: 1, total: 2 });
    expect(transcript.render(80).join("\n")).toContain("<Alpha>");
    expect(transcript.nextSearchMatch(1)).toEqual({ query: "alpha", current: 2, total: 2 });
    expect(transcript.selectedText()).toBe("alpha again");
  });

  test("marks no-color matches without exceeding the terminal width", () => {
    const transcript = new Transcript(createTheme(false).searchMatch);
    transcript.addBlock(new Text("Alpha result on a narrow line", 0, 0), {
      searchText: "Alpha result on a narrow line"
    });
    transcript.searchFor("Alpha");
    const lines = transcript.render(18);
    expect(lines.join("\n")).toContain("⟦Alpha⟧");
    expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
  });

  test("pages oversized selected blocks without rendering every line", () => {
    const transcript = new Transcript();
    transcript.setNavigationViewportRows(4);
    transcript.addBlock(new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0), {
      kind: "assistant",
      searchText: "long response"
    });
    transcript.selectLatest();

    const first = transcript.render(80).join("\n");
    expect(first).toContain("Page 1/3");
    expect(first).toContain("line 1");
    expect(first).not.toContain("line 10");
    expect(transcript.movePage(1, 80)).toEqual({ current: 2, total: 3 });
    const second = transcript.render(80).join("\n");
    expect(second).toContain("Page 2/3");
    expect(second).toContain("line 5");
    expect(second).not.toContain("line 1\n");
  });

  test("uses the windowed component path without materializing a full block", () => {
    let fullRenders = 0;
    const component: Component & {
      renderWindow(width: number, start: number, count: number): { lines: string[]; totalLines: number };
    } = {
      invalidate() {},
      render() {
        fullRenders += 1;
        throw new Error("full render should not run while paging");
      },
      renderWindow(_width, start, count) {
        return {
          lines: Array.from({ length: Math.min(count, Math.max(0, 50_000 - start)) }, (_, index) => `line ${start + index + 1}`),
          totalLines: 50_000
        };
      }
    };
    const transcript = new Transcript();
    transcript.setNavigationViewportRows(20);
    transcript.addBlock(component, { kind: "assistant", searchText: "large output" });
    transcript.selectLatest();

    expect(transcript.render(80).join("\n")).toContain("Page 1/2500");
    expect(transcript.movePage(1, 80)).toEqual({ current: 2, total: 2_500 });
    expect(transcript.render(80).join("\n")).toContain("line 21");
    expect(fullRenders).toBe(0);
  });

  test("reuses width presentation for stable blocks and refreshes changed content", () => {
    let sourceLines = ["界".repeat(20)];
    const component: Component = {
      invalidate() {},
      render: () => [...sourceLines]
    };
    const transcript = new Transcript();
    transcript.addBlock(component);
    const internal = transcript as unknown as {
      blocks: Array<{ renderCache?: { lines: string[] } }>;
    };

    const firstLine = transcript.render(10)[0] ?? "";
    expect(firstLine).toContain("界界界");
    expect(visibleWidth(firstLine)).toBeLessThanOrEqual(10);
    const firstCache = internal.blocks[0]?.renderCache;
    transcript.render(10);
    expect(internal.blocks[0]?.renderCache).toBe(firstCache);

    sourceLines = ["changed"];
    expect(transcript.render(10)[0]).toBe("changed");
    expect(internal.blocks[0]?.renderCache).not.toBe(firstCache);
  });

  test("releases component and presentation caches when blocks leave the render window", () => {
    const invalidations = Array<number>(301).fill(0);
    const transcript = new Transcript();
    for (let index = 0; index < 300; index += 1) {
      transcript.addBlock({
        invalidate: () => { invalidations[index] = (invalidations[index] ?? 0) + 1; },
        render: () => [`block ${index}`]
      });
    }
    transcript.render(80);
    const internal = transcript as unknown as {
      blocks: Array<{ renderCache?: unknown }>;
    };
    expect(internal.blocks[0]?.renderCache).toBeDefined();

    transcript.addBlock({
      invalidate: () => { invalidations[300] = (invalidations[300] ?? 0) + 1; },
      render: () => ["block 300"]
    });

    expect(internal.blocks[0]?.renderCache).toBeUndefined();
    expect(invalidations[0]).toBe(1);
    expect(invalidations[60]).toBe(1);
    expect(invalidations[61]).toBe(0);
  });

  test("bounds retained blocks while preserving the current render window", () => {
    const transcript = new Transcript();
    for (let index = 0; index < 10_000; index += 1) {
      const text = index === 0
        ? "content-oldest-released"
        : index === 9_999
          ? "content-latest-retained"
          : `content-${index}`;
      transcript.addBlock(new Text(text, 0, 0), { kind: "assistant", searchText: text });
    }

    expect(transcript.blockCount).toBe(MAX_RETAINED_TRANSCRIPT_BLOCKS);
    expect(transcript.discardedBlockCount).toBe(10_000 - MAX_RETAINED_TRANSCRIPT_BLOCKS);
    const rendered = transcript.render(80).join("\n");
    expect(rendered).toContain("older blocks released from in-app history");
    expect(rendered).toContain("content-latest-retained");
    expect(rendered).not.toContain("content-oldest-released");
    expect(transcript.searchFor("content-oldest-released")).toMatchObject({ current: 0, total: 0 });
    expect(transcript.searchFor("content-latest-retained")).toMatchObject({ current: 1, total: 1 });
  });

  test("bounds searchable characters outside the active render window", () => {
    const transcript = new Transcript();
    for (let index = 0; index < 1_000; index += 1) {
      const text = `${index}:${"x".repeat(9_995)}`;
      transcript.addBlock({ invalidate() {}, render: () => [text] }, {
        kind: "assistant",
        searchText: text
      });
    }

    expect(transcript.retainedHistoryCharacters)
      .toBeLessThanOrEqual(MAX_RETAINED_TRANSCRIPT_HISTORY_CHARACTERS);
    expect(transcript.blockCount).toBeLessThan(MAX_RETAINED_TRANSCRIPT_BLOCKS);
    expect(transcript.render(80).join("\n")).toContain("999:");
  });
});
