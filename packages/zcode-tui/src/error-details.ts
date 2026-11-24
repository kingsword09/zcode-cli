import { sanitizeTerminalText } from "./terminal-text.ts";
import { isRecord, type UnknownRecord } from "./types.ts";

export interface ErrorDetails {
  message?: string;
  detail?: string;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeTerminalText(value, { preserveSgr: false }).trim() || undefined;
}

function genericMessage(value: string): boolean {
  return /^(?:(?:turn|model request|model stream|model creation)(?: execution)? failed|fetch failed|unknown error)[.!]?$/iu.test(value);
}

/** Read the runtime's projected error payload and native Error causes, without dumping request data. */
export function describeError(value: unknown, fallback?: ErrorDetails): ErrorDetails {
  const messages: string[] = [];
  const details: string[] = [];
  const metadata: string[] = [];
  const wrappers: string[] = [];
  const seen = new Set<object>();
  const add = (list: string[], value: unknown): void => {
    const result = text(value);
    if (result && !list.includes(result)) list.push(result);
  };
  const addMetadata = (record: UnknownRecord): void => {
    for (const [label, keys] of [
      ["Code", ["errorCode", "code", "providerErrorCode", "providerCode"]],
      ["HTTP", ["statusCode", "status"]],
      ["Phase", ["errorPhase"]],
      ["Reason", ["reason"]],
      ["Provider", ["providerId", "provider"]],
      ["Model", ["modelId", "model"]],
      ["Request", ["requestId"]]
    ] as const) {
      const raw = keys.map(key => record[key]).find(value => text(value)
        || (typeof value === "number" && Number.isFinite(value)));
      const result = typeof raw === "number" ? String(raw) : text(raw);
      if (label === "HTTP" && !/^[1-5]\d{2}$/u.test(result ?? "")) continue;
      if (result) add(metadata, `${label}: ${result}`);
    }
  };
  const visit = (current: unknown, depth: number): void => {
    if (depth >= 8) return;
    if (typeof current === "string") { add(messages, current); return; }
    if (!isRecord(current) || seen.has(current)) return;
    seen.add(current);
    const context = isRecord(current.context) ? current.context : undefined;
    const wrapper = (current.errorPayloadRole ?? context?.errorPayloadRole) === "wrapper";
    add(wrapper ? wrappers : messages, current.message);
    add(messages, current.underlyingErrorMessage);
    for (const key of ["detail", "details", "errorDetails", "underlyingErrorDetail"]) add(details, current[key]);
    addMetadata(current);
    if (context) addMetadata(context);
    if (isRecord(current.attribution)) addMetadata(current.attribution);
    for (const key of ["cause", "lastError", "error"]) visit(current[key], depth + 1);
  };
  visit(value, 0);
  const detailLines = details.flatMap(value => value.split("\n")).map(value => value.trim()).filter(Boolean);
  const message = messages.findLast(value => !genericMessage(value))
    ?? (fallback?.message && !genericMessage(fallback.message) ? fallback.message : undefined)
    ?? detailLines.find(value => !genericMessage(value))
    ?? fallback?.message
    ?? messages[0]
    ?? wrappers[0]
    ?? metadata[0];
  const detail = [...new Set([message, ...messages, ...details, ...wrappers, ...metadata, fallback?.detail]
    .flatMap(value => value?.split("\n") ?? []))].join("\n") || undefined;
  return { message, detail };
}
