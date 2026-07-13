import { describe, expect, test } from "bun:test";

import { toolCard, toolSucceeded } from "../packages/zcode-tui/src/tool-view.ts";

describe("TUI tool cards", () => {
  test("renders structured input and a concise result", () => {
    const card = toolCard({
      name: "Read",
      state: "complete",
      input: { file_path: "/tmp/example.ts" },
      result: { output: "source text", success: true }
    });

    expect(card).toContain("⚙ Read · complete");
    expect(card).toContain('"file_path": "/tmp/example.ts"');
    expect(card).toContain("source text");
    expect(toolSucceeded({ success: true })).toBe(true);
    expect(toolSucceeded({ success: false })).toBe(false);
    expect(toolSucceeded({ status: "failed" })).toBe(false);
  });

  test("bounds large output previews", () => {
    const card = toolCard({ name: "Bash", state: "complete", result: "x".repeat(2_000) });
    expect(card).toContain("more characters");
    expect(card.length).toBeLessThan(1_800);
  });
});
