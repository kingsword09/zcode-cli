import { asString, isRecord, type UnknownRecord } from "./types.ts";

export interface StreamEvent {
  type?: string;
  kind?: string;
  delta?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  result?: unknown;
  error?: unknown;
  raw: UnknownRecord;
}

function nestedRecord(record: UnknownRecord, key: string): UnknownRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function runtimeToolKind(type: string | undefined): string | undefined {
  switch (type) {
    case "tool_call_scheduled": return "scheduled";
    case "tool_call_started": return "started";
    case "tool_call_progress": return "progress";
    case "tool_call_result": return "result";
    case "tool_call_error": return "error";
    default: return undefined;
  }
}

export function normalizeEvent(value: unknown): StreamEvent | null {
  if (!isRecord(value)) return null;
  const params = nestedRecord(value, "params");
  const payload = nestedRecord(value, "payload") ?? (params && nestedRecord(params, "payload"));
  const event = payload && (nestedRecord(payload, "event") ?? nestedRecord(payload, "streamEvent"));
  const body = event ?? payload ?? value;
  const toolCall = nestedRecord(body, "toolCall");
  const type = asString(value.type) ?? (params && asString(params.type));

  return {
    type,
    kind: asString(body.kind) ?? runtimeToolKind(type),
    delta: asString(body.delta),
    toolName: asString(body.toolName) ?? (toolCall && (asString(toolCall.name) ?? asString(toolCall.toolName))),
    toolCallId: asString(body.toolCallId) ?? (toolCall && (asString(toolCall.id) ?? asString(toolCall.toolCallId))),
    input: body.input ?? toolCall?.input,
    result: body.result ?? body.output,
    error: body.error,
    raw: value
  };
}

export function responseText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return asString(value.response) ?? asString(value.message) ?? asString(value.text);
}

export function modelLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "default";
  const model = asString(value.modelId) ?? asString(value.id) ?? asString(value.name);
  const provider = asString(value.providerId) ?? asString(value.provider);
  if (provider && model && !model.includes("/")) return `${provider}/${model}`;
  return model ?? "default";
}

export interface RestoredMessage {
  role: "user" | "assistant" | "system";
  text: string;
}

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!isRecord(part)) return "";
  return asString(part.text) ?? asString(part.content) ?? asString(part.value) ?? "";
}

export function restoredMessages(value: unknown): RestoredMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: RestoredMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const info = nestedRecord(item, "info");
    const rawRole = asString(item.role) ?? (info && asString(info.role));
    const role = rawRole === "user" || rawRole === "assistant" ? rawRole : "system";
    const direct = asString(item.text) ?? asString(item.content);
    const parts = Array.isArray(item.parts) ? item.parts.map(partText).filter(Boolean).join("\n") : "";
    const text = direct ?? parts;
    if (text) messages.push({ role, text });
  }
  return messages;
}

export function historyText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return asString(value.text) ?? asString(value.input) ?? asString(value.content);
}
