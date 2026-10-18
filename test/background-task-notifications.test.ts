import { describe, expect, test } from "bun:test";

import { deliveredBackgroundTaskIds } from "../packages/zcode-tui/src/background-task-notifications.ts";

describe("background task notifications", () => {
  test("collects delivered task ids from user notification messages only", () => {
    const delivered = deliveredBackgroundTaskIds([
      {
        role: "user",
        parts: [{
          type: "text",
          text: "<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n</task-notification>"
        }]
      },
      { role: "assistant", parts: [{ type: "text", text: "<task-id>bg-9</task-id>" }] },
      { role: "user", parts: [{ type: "text", text: "a plain user message" }] }
    ]);

    expect([...delivered]).toEqual(["bg-1"]);
  });
});
