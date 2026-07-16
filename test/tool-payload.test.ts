import { describe, expect, test } from "bun:test";

import {
  compactToolPayloads,
  MAX_RETAINED_TOOL_PAYLOAD_CHARACTERS,
  MAX_RETAINED_TOOL_PAYLOAD_NODES,
  toolPayloadSize
} from "../packages/zcode-tui/src/tool-payload.ts";

describe("completed tool payload compaction", () => {
  test("keeps small payload shapes and shared references intact", () => {
    const shared = { value: "same" };
    const compacted = compactToolPayloads([{ first: shared, second: shared }]);

    const retained = compacted.values[0] as { first: unknown; second: unknown };
    expect(compacted.truncated).toBeFalse();
    expect(retained).toEqual({ first: { value: "same" }, second: { value: "same" } });
    expect(retained.second).toBe(retained.first);
  });

  test("clones Error payloads without losing their display type", () => {
    const source = new Error("boom");
    const compacted = compactToolPayloads([source]);
    const retained = compacted.values[0];

    expect(retained).not.toBe(source);
    expect(retained).toBeInstanceOf(Error);
    expect((retained as Error).name).toBe("Error");
    expect((retained as Error).message).toBe("boom");
    expect((retained as Error).stack).toBeUndefined();
  });

  test("bounds strings, nodes, depth, arrays, and records", () => {
    let deep: unknown = "end";
    for (let level = 0; level < 12; level += 1) deep = { next: deep };
    const payload = {
      large: "x".repeat(1_000_000),
      array: Array.from({ length: 2_000 }, (_, index) => ({ index, value: `item ${index}` })),
      deep
    };
    const compacted = compactToolPayloads([payload]);
    const actual = toolPayloadSize(compacted.values);

    expect(compacted.truncated).toBeTrue();
    expect(compacted.size.characters).toBeLessThanOrEqual(MAX_RETAINED_TOOL_PAYLOAD_CHARACTERS);
    expect(compacted.size.nodes).toBeLessThanOrEqual(MAX_RETAINED_TOOL_PAYLOAD_NODES);
    expect(actual.characters).toBeLessThanOrEqual(MAX_RETAINED_TOOL_PAYLOAD_CHARACTERS);
  });

  test("replaces completed image data without retaining base64", () => {
    const data = "a".repeat(1_000_000);
    const compacted = compactToolPayloads([{
      content: [{ type: "image", mimeType: "image/png", data }]
    }]);
    const retained = JSON.stringify(compacted.values);

    expect(compacted.truncated).toBeTrue();
    expect(retained).toContain("binary payload omitted: 1000000 characters");
    expect(retained).not.toContain(data.slice(0, 10_000));
  });

  test("keeps both ends of a clipped text string without broken surrogates", () => {
    const value = `start 👨‍👩‍👧‍👦 ${"x".repeat(100)} finish ✅`;
    const compacted = compactToolPayloads([value], {
      characters: 60,
      depth: 8,
      entries: 64,
      nodes: 64
    });
    const retained = compacted.values[0] as string;

    expect(retained).toContain("retained tool payload truncated");
    expect(retained).not.toMatch(/^[\uDC00-\uDFFF]/u);
    expect(retained).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
});
