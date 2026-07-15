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

  test("uses the official assistant message identity and result duration", () => {
    expect(normalizeEvent({
      type: "model.streaming",
      payload: {
        kind: "tool_call",
        assistantMessageId: "message_assistant",
        toolCallId: "call_1",
        toolName: "Bash"
      }
    })).toMatchObject({
      messageId: "message_assistant",
      toolCallId: "call_1"
    });

    expect(normalizeEvent({
      type: "tool_call_result",
      payload: {
        toolCallId: "call_1",
        duration: 1_250,
        result: { success: true }
      }
    })).toMatchObject({
      durationMs: 1_250,
      progress: { durationMs: 1_250 }
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

  test("normalizes the pending and committed identities for active-turn steering", () => {
    expect(normalizeEvent({
      type: "turn_steer_queued",
      payload: {
        inputId: "input_1",
        pendingInputId: "pending_1",
        targetTurnId: "turn_1"
      }
    })).toMatchObject({
      type: "turn_steer_queued",
      inputId: "input_1",
      pendingInputId: "pending_1"
    });

    expect(normalizeEvent({
      type: "turn_steer_drained",
      payload: {
        pendingInputIds: ["pending_1"],
        injectedMessageIds: ["message_steer_1"]
      }
    })).toMatchObject({
      type: "turn_steer_drained",
      pendingInputIds: ["pending_1"],
      injectedMessageIds: ["message_steer_1"]
    });
  });

  test("normalizes subagent lifecycle metadata for the parent tool card", () => {
    expect(normalizeEvent({
      type: "subagent_stopped",
      payload: {
        parentToolCallId: "call_agent",
        agentId: "agent_1",
        agentType: "explore",
        childSessionId: "session_child",
        totalToolUseCount: 4,
        totalTokens: 2_000,
        outputFile: "/tmp/agent.output"
      }
    })?.progress).toMatchObject({
      parentToolCallId: "call_agent",
      agentId: "agent_1",
      agentType: "explore",
      childSessionId: "session_child",
      totalToolUseCount: 4,
      totalTokens: 2_000,
      outputFile: "/tmp/agent.output"
    });
  });

  test("formats model, history and restored transcript shapes", () => {
    expect(modelLabel({ providerId: "zai", modelId: "glm-5" })).toBe("zai/glm-5");
    expect(historyText({ text: "previous prompt" })).toBe("previous prompt");
    expect(restoredMessages([
      { info: { role: "user" }, parts: [{ text: "hello" }] },
      { info: { role: "assistant" }, parts: [{ text: "world" }] }
    ])).toEqual([
      { role: "user", parts: [{ type: "text", text: "hello" }] },
      { role: "assistant", parts: [{ type: "text", text: "world" }] }
    ]);
  });

  test("preserves official rich transcript parts", () => {
    expect(restoredMessages([{
      info: { role: "agent" },
      content: "final answer",
      parts: [
        { type: "text", text: "final answer" },
        { type: "thought", text: "reasoning" },
        {
          type: "tool",
          toolCallId: "call_1",
          toolName: "Bash",
          input: { command: "bun test" },
          output: "ok",
          status: "completed"
        }
      ]
    }])).toEqual([{
      role: "assistant",
      parts: [
        { type: "text", text: "final answer" },
        { type: "thought", text: "reasoning" },
        {
          type: "tool",
          toolCallId: "call_1",
          toolName: "Bash",
          input: { command: "bun test" },
          output: "ok",
          resultDisplay: undefined,
          error: undefined,
        status: "completed",
        title: undefined,
        parentToolCallId: undefined,
        childToolCallId: undefined,
        agentId: undefined,
        agentType: undefined,
        childSessionId: undefined
        }
      ]
    }]);
  });

  test("reads official nested tool state without losing failures or inputs", () => {
    expect(restoredMessages([{
      info: { role: "assistant", messageId: "message_1" },
      parts: [{
        type: "tool",
        partId: "part_1",
        messageId: "message_1",
        sessionId: "session_1",
        callId: "call_1",
        tool: "Bash",
        state: {
          status: "error",
          input: { command: "false" },
          error: "Command exited with code 1",
          startedAt: "2026-07-14T00:00:00Z",
          completedAt: "2026-07-14T00:00:01Z"
        }
      }]
    }])).toEqual([{
      messageId: "message_1",
      role: "assistant",
      parts: [{
        partId: "part_1",
        messageId: "message_1",
        sessionId: "session_1",
        type: "tool",
        toolCallId: "call_1",
        toolName: "Bash",
        input: { command: "false" },
        output: undefined,
        resultDisplay: undefined,
        error: "Command exited with code 1",
        status: "error",
        title: undefined,
        metadata: undefined,
        parentToolCallId: undefined,
        childToolCallId: undefined,
        agentId: undefined,
        agentType: undefined,
        childSessionId: undefined
      }]
    }]);
  });

  test("preserves restored tool relationships from state metadata", () => {
    expect(restoredMessages([{
      info: { role: "assistant" },
      parts: [{
        type: "tool",
        callId: "child_1",
        tool: "Read",
        state: {
          status: "completed",
          metadata: {
            parentToolCallId: "agent_1",
            agentId: "researcher",
            agentType: "explore",
            childSessionId: "session_child"
          }
        }
      }]
    }])[0]?.parts[0]).toMatchObject({
      type: "tool",
      toolCallId: "child_1",
      parentToolCallId: "agent_1",
      agentId: "researcher",
      agentType: "explore",
      childSessionId: "session_child"
    });
  });

  test("normalizes official part mutation events", () => {
    expect(normalizeEvent({
      type: "part.upserted",
      payload: {
        part: {
          type: "text",
          partId: "part_text",
          messageId: "message_1",
          sessionId: "session_1",
          text: "updated"
        }
      }
    })).toMatchObject({
      type: "part.upserted",
      partId: "part_text",
      messageId: "message_1",
      part: { type: "text", text: "updated" }
    });

    expect(normalizeEvent({
      method: "session/event",
      params: {
        type: "part.delta",
        payload: { messageId: "message_1", partId: "part_text", field: "text", delta: "!" }
      }
    })).toMatchObject({
      type: "part.delta",
      messageId: "message_1",
      partId: "part_text",
      field: "text",
      delta: "!"
    });
  });
});
