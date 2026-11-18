import { describe, expect, test } from "bun:test";

import { resolveToolCallStyle } from "../../packages/zcode-tui/src/tool-call-style.ts";

describe("tool call display setting", () => {
  test("defaults to regular for missing or invalid configuration", () => {
    expect(resolveToolCallStyle(undefined)).toBe("regular");
    expect(resolveToolCallStyle({ ui: { toolCallStyle: "unknown" } })).toBe("regular");
  });

  test("accepts compact configuration", () => {
    expect(resolveToolCallStyle({ ui: { toolCallStyle: "compact" } })).toBe("compact");
  });
});
