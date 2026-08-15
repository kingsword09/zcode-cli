import type { RuntimeContextBreakdownItem } from "./runtime-projection.ts";
import { asString, isRecord } from "./types.ts";

function valueLength(value: unknown): number {
  const text = asString(value);
  if (text !== undefined) return text.length;
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function assistantPartLength(value: unknown): { assistant: number; tool: number } {
  if (!isRecord(value)) return { assistant: 0, tool: 0 };
  const type = asString(value.type);
  if (type === "thought" || type === "reasoning") {
    return { assistant: valueLength(value.text), tool: 0 };
  }
  if (type !== "tool") return { assistant: 0, tool: 0 };
  return {
    assistant: 0,
    tool: valueLength(value.input) + valueLength(value.output) + valueLength(value.error)
  };
}

export function estimateTranscriptContextBreakdown(value: unknown): RuntimeContextBreakdownItem[] {
  const messages = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.messages) ? value.messages : [];
  let userChars = 0;
  let assistantChars = 0;
  let toolChars = 0;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const role = asString(message.role);
    if (role === "user") {
      userChars += valueLength(message.content);
      continue;
    }
    if (role !== "agent" && role !== "assistant") continue;
    assistantChars += valueLength(message.content);
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (const part of parts) {
      const lengths = assistantPartLength(part);
      assistantChars += lengths.assistant;
      toolChars += lengths.tool;
    }
  }
  const breakdown: RuntimeContextBreakdownItem[] = [
    { source: "user_messages", chars: userChars },
    { source: "assistant_messages", chars: assistantChars },
    { source: "tool_io", chars: toolChars }
  ];
  return breakdown.filter((item) => item.chars > 0);
}
