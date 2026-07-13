import { describe, expect, test } from "bun:test";

import {
  attachmentSummary,
  clipboardImageAttachment,
  promptInput
} from "../packages/zcode-tui/src/attachments.ts";

describe("TUI image attachments", () => {
  test("normalizes clipboard image data into official prompt attachments", () => {
    const attachment = clipboardImageAttachment({
      dataUrl: "data:image/png;base64,aGVsbG8=",
      mediaType: "image/png",
      sizeBytes: 2048
    });

    expect(attachment).toEqual({
      type: "image",
      content: "data:image/png;base64,aGVsbG8=",
      mediaType: "image/png",
      sizeBytes: 2048
    });
    expect(promptInput("inspect", attachment ? [attachment] : [])).toEqual({
      text: "inspect",
      attachments: [attachment]
    });
    expect(attachmentSummary(attachment ? [attachment] : [])).toBe("1 image attached · 2 KB");
  });

  test("rejects malformed or non-image clipboard values", () => {
    expect(clipboardImageAttachment(null)).toBeUndefined();
    expect(clipboardImageAttachment({ dataUrl: "data:text/plain;base64,aGk=" })).toBeUndefined();
    expect(promptInput("plain", [])).toBe("plain");
  });
});
