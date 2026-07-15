import { asString, isRecord, type UnknownRecord } from "./types.ts";
import type { ToolProgressData } from "./tool-renderers.ts";

export interface StreamEvent {
  type?: string;
  kind?: string;
  delta?: string;
  field?: "text" | "reasoning" | "input" | "output";
  messageId?: string;
  partId?: string;
  inputId?: string;
  pendingInputId?: string;
  pendingInputIds?: string[];
  injectedMessageIds?: string[];
  reason?: string;
  part?: RestoredPart;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  result?: unknown;
  error?: unknown;
  message?: string;
  progress?: ToolProgressData;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  durationMs?: number;
  dependencies?: string[];
  parallelGroupIndex?: number;
  canRunParallel?: boolean;
  retryable?: boolean;
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
    case "tool_call_closed": return "closed";
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
  const partValue = body.part;
  const part = normalizeRestoredPart(partValue);
  const error = body.error;
  const errorRecord = isRecord(error) ? error : undefined;
  const number = (key: string): number | undefined => {
    const field = body[key];
    return typeof field === "number" && Number.isFinite(field) ? field : undefined;
  };
  const strings = (key: string): string[] | undefined => {
    const field = body[key];
    return Array.isArray(field)
      ? field.filter((item): item is string => typeof item === "string")
      : undefined;
  };

  return {
    type,
    kind: asString(body.kind) ?? runtimeToolKind(type),
    delta: asString(body.delta),
    field: ["text", "reasoning", "input", "output"].includes(asString(body.field) ?? "")
      ? asString(body.field) as StreamEvent["field"]
      : undefined,
    messageId: asString(body.messageId)
      ?? asString(body.messageID)
      ?? asString(body.assistantMessageId)
      ?? part?.messageId,
    partId: asString(body.partId) ?? asString(body.partID) ?? part?.partId,
    inputId: asString(body.inputId) ?? asString(body.inputID),
    pendingInputId: asString(body.pendingInputId) ?? asString(body.pendingInputID),
    pendingInputIds: strings("pendingInputIds") ?? strings("pendingInputIDs"),
    injectedMessageIds: strings("injectedMessageIds") ?? strings("injectedMessageIDs"),
    reason: asString(body.reason),
    part,
    toolName: asString(body.toolName)
      ?? (toolCall && (asString(toolCall.name) ?? asString(toolCall.toolName)))
      ?? (part?.type === "tool" ? part.toolName : undefined),
    toolCallId: asString(body.toolCallId)
      ?? (toolCall && (asString(toolCall.id) ?? asString(toolCall.toolCallId)))
      ?? (part?.type === "tool" ? part.toolCallId : undefined),
    input: body.input ?? toolCall?.input ?? (part?.type === "tool" ? part.input : undefined),
    result: body.result ?? body.output ?? (part?.type === "tool" ? part.output : undefined),
    error: error ?? (part?.type === "tool" ? part.error : undefined),
    message: asString(body.message) ?? (errorRecord && asString(errorRecord.message)),
    progress: {
      elapsedMs: number("elapsedMs"),
      durationMs: number("durationMs") ?? number("duration"),
      pid: number("pid"),
      stdoutBytes: number("stdoutBytes"),
      stderrBytes: number("stderrBytes"),
      outputBytes: number("outputBytes"),
      stdoutTail: asString(body.stdoutTail),
      stderrTail: asString(body.stderrTail),
      description: asString(body.description),
      progress: number("progress"),
      total: number("total"),
      progressMessage: asString(body.progressMessage),
      parentToolCallId: asString(body.parentToolCallId),
      agentId: asString(body.agentId),
      agentType: asString(body.agentType),
      childSessionId: asString(body.childSessionId),
      childToolCallId: asString(body.childToolCallId),
      totalToolUseCount: number("totalToolUseCount"),
      totalTokens: number("totalTokens"),
      outputFile: asString(body.outputFile),
      backgroundTaskId: asString(body.backgroundTaskId)
    },
    attempt: number("attempt"),
    maxAttempts: number("maxAttempts") ?? number("maxRetries"),
    delayMs: number("delayMs") ?? number("retryDelayMs"),
    durationMs: number("durationMs") ?? number("duration"),
    dependencies: Array.isArray(body.dependencies)
      ? body.dependencies.filter((item): item is string => typeof item === "string")
      : undefined,
    parallelGroupIndex: number("parallelGroupIndex"),
    canRunParallel: typeof body.canRunParallel === "boolean" ? body.canRunParallel : undefined,
    retryable: typeof body.retryable === "boolean" ? body.retryable : undefined,
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

export interface PartIdentity {
  partId?: string;
  messageId?: string;
  sessionId?: string;
}

export type RestoredPart = PartIdentity & (
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | {
    type: "tool";
    toolCallId?: string;
    toolName: string;
    input?: unknown;
    output?: unknown;
    resultDisplay?: unknown;
    error?: unknown;
    status: string;
    title?: string;
    metadata?: UnknownRecord;
    parentToolCallId?: string;
    childToolCallId?: string;
    agentId?: string;
    agentType?: string;
    childSessionId?: string;
  }
  | { type: "file"; text: string; filename?: string; mime?: string; url?: string; metadata?: UnknownRecord }
  | { type: "step-start"; text: string; snapshot?: string }
  | { type: "step-finish"; text: string; reason?: string; snapshot?: string; cost?: number; tokens?: unknown }
  | { type: "snapshot"; text: string; snapshot?: string }
  | { type: "patch"; text: string; hash?: string; files: string[] }
  | { type: "retry"; text: string; attempt?: number; error?: unknown }
  | { type: "compaction"; text: string; reason?: string; summaryMessageId?: string; metadata?: UnknownRecord }
  | {
    type: "subagent";
    text: string;
    agent?: string;
    description?: string;
    prompt?: string;
    model?: string;
    command?: string;
  }
  | { type: "agent"; text: string; name?: string }
);

export interface RestoredMessage {
  messageId?: string;
  role: "user" | "assistant" | "system";
  parts: RestoredPart[];
}

function partIdentity(value: UnknownRecord): PartIdentity {
  return {
    partId: asString(value.partId) ?? asString(value.partID) ?? asString(value.id),
    messageId: asString(value.messageId) ?? asString(value.messageID),
    sessionId: asString(value.sessionId) ?? asString(value.sessionID)
  };
}

function errorMessage(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return isRecord(value) ? asString(value.message) ?? asString(value.name) : undefined;
}

function modelReference(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const provider = asString(value.providerId) ?? asString(value.providerID);
  const model = asString(value.modelId) ?? asString(value.modelID) ?? asString(value.id);
  return provider && model ? `${provider}/${model}` : model;
}

export function normalizeRestoredPart(value: unknown): RestoredPart | undefined {
  if (typeof value === "string") return value ? { type: "text", text: value } : undefined;
  if (!isRecord(value)) return undefined;
  const identity = partIdentity(value);
  const type = asString(value.type)?.toLowerCase();
  if (type === "text") {
    const text = asString(value.text) ?? asString(value.content) ?? asString(value.value);
    return text !== undefined ? { ...identity, type: "text", text } : undefined;
  }
  if (type === "thought" || type === "reasoning") {
    const text = asString(value.text) ?? asString(value.content);
    return text !== undefined ? { ...identity, type: "thought", text } : undefined;
  }
  if (type === "tool") {
    const state = nestedRecord(value, "state");
    const metadata = (state && nestedRecord(state, "metadata")) ?? nestedRecord(value, "metadata");
    const toolName = asString(value.toolName) ?? asString(value.tool) ?? asString(value.name) ?? "tool";
    const relation = (key: string): string | undefined => asString(value[key])
      ?? (state && asString(state[key]))
      ?? (metadata && asString(metadata[key]));
    return {
      ...identity,
      type: "tool",
      toolCallId: asString(value.toolCallId) ?? asString(value.callId) ?? asString(value.callID),
      toolName,
      input: state?.input ?? value.input,
      output: state?.output ?? value.output,
      resultDisplay: value.resultDisplay ?? value.display ?? metadata?.resultDisplay ?? metadata?.display,
      error: state?.error ?? value.error,
      status: (state && asString(state.status)) ?? asString(value.status) ?? "completed",
      title: (state && asString(state.title)) ?? asString(value.title),
      metadata,
      parentToolCallId: relation("parentToolCallId"),
      childToolCallId: relation("childToolCallId"),
      agentId: relation("agentId"),
      agentType: relation("agentType"),
      childSessionId: relation("childSessionId")
    };
  }
  if (type === "file" || type === "image") {
    const filename = asString(value.filename);
    const url = asString(value.url);
    const mime = asString(value.mime) ?? asString(value.mimeType) ?? asString(value.mediaType);
    const label = filename ?? url ?? "attachment";
    return {
      ...identity,
      type: "file",
      text: `[Attached file: ${label}]`,
      filename,
      url,
      mime,
      metadata: nestedRecord(value, "metadata")
    };
  }
  if (type === "step-start") {
    return { ...identity, type: "step-start", text: "Model step started", snapshot: asString(value.snapshot) };
  }
  if (type === "step-finish") {
    const reason = asString(value.reason);
    const cost = typeof value.cost === "number" && Number.isFinite(value.cost) ? value.cost : undefined;
    const total = isRecord(value.tokens) && typeof value.tokens.total === "number" ? value.tokens.total : undefined;
    const details = [reason, total !== undefined ? `${total.toLocaleString()} tokens` : undefined].filter(Boolean).join(" · ");
    return {
      ...identity,
      type: "step-finish",
      text: details ? `Model step finished · ${details}` : "Model step finished",
      reason,
      snapshot: asString(value.snapshot),
      cost,
      tokens: value.tokens
    };
  }
  if (type === "snapshot") {
    return { ...identity, type: "snapshot", text: "Workspace snapshot created", snapshot: asString(value.snapshot) };
  }
  if (type === "patch") {
    const files = Array.isArray(value.files)
      ? value.files.filter((item): item is string => typeof item === "string")
      : [];
    return {
      ...identity,
      type: "patch",
      text: files.length > 0 ? `Checkpoint recorded · ${files.length} ${files.length === 1 ? "file" : "files"}` : "Checkpoint recorded",
      hash: asString(value.hash),
      files
    };
  }
  if (type === "retry") {
    const attempt = typeof value.attempt === "number" ? `attempt ${value.attempt}` : "retry";
    const error = errorMessage(value.error);
    return {
      ...identity,
      type: "retry",
      text: [attempt, error].filter(Boolean).join(" · "),
      attempt: typeof value.attempt === "number" ? value.attempt : undefined,
      error: value.error
    };
  }
  if (type === "compaction") {
    const reason = asString(value.reason);
    return {
      ...identity,
      type: "compaction",
      text: reason ? `Conversation compacted · ${reason}` : "Conversation compacted",
      reason,
      summaryMessageId: asString(value.summaryMessageId),
      metadata: nestedRecord(value, "metadata")
    };
  }
  if (type === "subagent" || type === "subtask") {
    const description = asString(value.description) ?? asString(value.name) ?? asString(value.agent) ?? "Subagent";
    return {
      ...identity,
      type: "subagent",
      text: description,
      agent: asString(value.agent),
      description,
      prompt: asString(value.prompt),
      model: modelReference(value.model),
      command: asString(value.command)
    };
  }
  if (type === "agent") {
    const name = asString(value.name) ?? asString(value.agent) ?? "Agent";
    return { ...identity, type: "agent", text: name, name };
  }
  const text = asString(value.text) ?? asString(value.content) ?? asString(value.value);
  return text ? { ...identity, type: "text", text } : undefined;
}

export function restoredMessages(value: unknown): RestoredMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: RestoredMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const info = nestedRecord(item, "info");
    const rawRole = asString(item.role) ?? (info && asString(info.role));
    const role = rawRole === "user"
      ? "user"
      : rawRole === "assistant" || rawRole === "agent"
        ? "assistant"
        : "system";
    const direct = asString(item.text) ?? asString(item.content);
    const structured = Array.isArray(item.parts)
      ? item.parts.map(normalizeRestoredPart).filter((part): part is RestoredPart => Boolean(part))
      : [];
    const hasTextPart = structured.some((part) => part.type === "text");
    const parts = direct && !hasTextPart ? [{ type: "text", text: direct } satisfies RestoredPart, ...structured] : structured;
    if (parts.length > 0) {
      messages.push({
        messageId: asString(item.messageId) ?? asString(item.messageID) ?? (info && (asString(info.messageId) ?? asString(info.id))),
        role,
        parts
      });
    }
  }
  return messages;
}

export function historyText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return asString(value.text) ?? asString(value.input) ?? asString(value.content);
}
