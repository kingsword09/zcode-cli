import { describe, expect, test } from "bun:test";

import {
  BoundedToolText,
  MAX_ACTIVE_TOOL_TEXT_CHARACTERS
} from "../packages/zcode-tui/src/bounded-tool-text.ts";

describe("active tool text buffer", () => {
  test("keeps text below the limit byte-for-byte", () => {
    const buffer = new BoundedToolText();
    buffer.append("first");
    buffer.append(" second");

    expect(buffer.value()).toBe("first second");
    expect(buffer.totalCharacters).toBe(12);
    expect(buffer.omittedCharacters).toBe(0);
    expect(buffer.isTruncated()).toBeFalse();
  });

  test("retains bounded head and tail across many deltas", () => {
    const buffer = new BoundedToolText();
    for (let index = 0; index < 100_000; index += 1) buffer.append("0123456789");
    const retained = buffer.value();

    expect(buffer.totalCharacters).toBe(1_000_000);
    expect(buffer.retainedCharacters).toBeLessThan(MAX_ACTIVE_TOOL_TEXT_CHARACTERS);
    expect(retained.length).toBeLessThanOrEqual(MAX_ACTIVE_TOOL_TEXT_CHARACTERS);
    expect(retained.startsWith("0123456789")).toBeTrue();
    expect(retained.endsWith("0123456789")).toBeTrue();
    expect(retained).toContain(`${buffer.omittedCharacters} characters omitted`);
    expect(buffer.isTruncated()).toBeTrue();
  });

  test("does not split surrogate pairs while rotating the tail", () => {
    const buffer = new BoundedToolText("start 👨‍👩‍👧‍👦", 80);
    buffer.append(" x".repeat(100));
    buffer.append(" finish ✅");
    const retained = buffer.value();

    expect(retained).not.toMatch(/^[\uDC00-\uDFFF]/u);
    expect(retained).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(retained).toContain("finish ✅");
  });

  test("replaces and clears previous stream state", () => {
    const buffer = new BoundedToolText("x".repeat(100), 40);
    expect(buffer.isTruncated()).toBeTrue();
    buffer.replace("authoritative");
    expect(buffer.value()).toBe("authoritative");
    buffer.clear();
    expect(buffer.value()).toBe("");
    expect(buffer.totalCharacters).toBe(0);
  });
});
