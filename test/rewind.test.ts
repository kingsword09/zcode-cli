import { describe, expect, test } from "bun:test";

import {
  fileRewindPreview,
  rewindCommand,
  rewindTargetLabel,
  rewindTargets
} from "../packages/zcode-tui/src/rewind.ts";

describe("conversation rewind", () => {
  test("lists rewindable user inputs newest first with stable message IDs", () => {
    expect(rewindTargets([
      { info: { id: "message-1", role: "user" }, parts: [{ type: "text", text: "First prompt" }] },
      { info: { id: "message-2", role: "assistant" }, parts: [{ type: "text", text: "Response" }] },
      { messageId: "message-3", role: "user", content: "Latest prompt" },
      { role: "user", content: "Missing identifier" }
    ])).toEqual([
      { checkpointMessageIds: ["message-3"], messageId: "message-3", text: "Latest prompt" },
      {
        checkpointMessageIds: ["message-1", "message-2", "message-3"],
        messageId: "message-1",
        text: "First prompt"
      }
    ]);
  });

  test("normalizes official safe, unsafe, and ignored file previews", () => {
    expect(fileRewindPreview({
      canApply: true,
      safeFiles: [{ path: "src/app.ts", action: "restore", operationCount: 2, toolNames: ["Edit"] }],
      unsafeFiles: [{ path: "README.md", reason: "external_modified", toolNames: ["Write"] }],
      ignoredFiles: [{ path: "generated.txt", reason: "bash_ignored", toolNames: ["Bash"] }]
    })).toEqual({
      canApply: true,
      safeFiles: [{ path: "src/app.ts", action: "restore", operationCount: 2, toolNames: ["Edit"] }],
      unsafeFiles: [{ path: "README.md", reason: "external_modified", toolNames: ["Write"] }],
      ignoredFiles: [{ path: "generated.txt", reason: "bash_ignored", toolNames: ["Bash"] }]
    });
  });

  test("builds bounded safe labels and validated native rewind commands", () => {
    expect(rewindTargetLabel("  Hello\n\x1b]9;bad\x07 world  ")).toBe("Hello world");
    expect(rewindTargetLabel("A👨‍👩‍👧‍👦BC", 3)).toBe("A👨‍👩‍👧‍👦…");
    expect(rewindCommand("conversation", "message_123")).toBe(
      "/rewind cascade conversation message_123"
    );
    expect(() => rewindCommand("conversation", "bad id")).toThrow(/invalid identifier/u);
  });
});
