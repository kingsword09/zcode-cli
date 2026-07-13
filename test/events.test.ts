import { describe, expect, test } from "bun:test";

import {
  historyText,
  modelLabel,
  normalizeEvent,
  restoredMessages
} from "../packages/zcode-tui/src/events.ts";

describe("ZCode event adapter", () => {
  test("normalizes protocol streaming events", () => {
    expect(normalizeEvent({
      type: "model.streaming",
      payload: {
        kind: "text_delta",
        delta: "你好"
      }
    })).toMatchObject({
      type: "model.streaming",
      kind: "text_delta",
      delta: "你好"
    });
  });

  test("normalizes app-server envelopes", () => {
    expect(normalizeEvent({
      method: "session/event",
      params: {
        type: "model.streaming",
        payload: {
          kind: "tool_input_start",
          toolName: "Read",
          toolCallId: "call_1"
        }
      }
    })).toMatchObject({
      type: "model.streaming",
      kind: "tool_input_start",
      toolName: "Read",
      toolCallId: "call_1"
    });
  });

  test("normalizes raw runtime tool lifecycle events", () => {
    expect(normalizeEvent({
      type: "tool_call_started",
      payload: {
        toolCallId: "call_1",
        toolName: "Read",
        startedAt: 1_752_400_000_000
      }
    })).toMatchObject({
      type: "tool_call_started",
      kind: "started",
      toolCallId: "call_1",
      toolName: "Read"
    });

    expect(normalizeEvent({
      type: "tool_call_result",
      payload: {
        toolCallId: "call_1",
        result: { success: true, content: "source text" }
      }
    })).toMatchObject({
      type: "tool_call_result",
      kind: "result",
      toolCallId: "call_1",
      result: { success: true, content: "source text" }
    });

    expect(normalizeEvent({
      type: "tool_call_error",
      payload: {
        toolCallId: "call_2",
        error: { message: "Command failed" }
      }
    })).toMatchObject({
      type: "tool_call_error",
      kind: "error",
      toolCallId: "call_2",
      error: { message: "Command failed" }
    });
  });

  test("formats model, history and restored transcript shapes", () => {
    expect(modelLabel({ providerId: "zai", modelId: "glm-5" })).toBe("zai/glm-5");
    expect(historyText({ text: "previous prompt" })).toBe("previous prompt");
    expect(restoredMessages([
      { info: { role: "user" }, parts: [{ text: "hello" }] },
      { info: { role: "assistant" }, parts: [{ text: "world" }] }
    ])).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" }
    ]);
  });
});
