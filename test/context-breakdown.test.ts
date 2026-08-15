import { describe, expect, test } from "bun:test";

import { estimateTranscriptContextBreakdown } from "../packages/zcode-tui/src/context-breakdown.ts";

describe("context breakdown estimation", () => {
  test("separates retained user, assistant and tool content", () => {
    expect(estimateTranscriptContextBreakdown([
      { role: "user", content: "hello" },
      {
        role: "agent",
        content: "done",
        parts: [
          { type: "text", text: "done" },
          { type: "thought", text: "reason" },
          { type: "tool", input: { path: "src/index.ts" }, output: "contents" }
        ]
      }
    ])).toEqual([
      { source: "user_messages", chars: 5 },
      { source: "assistant_messages", chars: 10 },
      { source: "tool_io", chars: 31 }
    ]);
  });

  test("accepts wrapped transcript data and ignores unsupported entries", () => {
    expect(estimateTranscriptContextBreakdown({
      messages: [null, { role: "system", content: "hidden" }, { role: "user", content: "go" }]
    })).toEqual([{ source: "user_messages", chars: 2 }]);
  });
});
