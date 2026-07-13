import { asString, isRecord } from "./types.ts";

const maxPreviewCharacters = 1_600;

function truncate(value: string): string {
  if (value.length <= maxPreviewCharacters) return value;
  return `${value.slice(0, maxPreviewCharacters)}\n… ${value.length - maxPreviewCharacters} more characters`;
}

function stringify(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resultValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  for (const key of ["output", "content", "stdout", "text", "message", "value"]) {
    if (value[key] !== undefined) return value[key];
  }
  return value;
}

export function toolSucceeded(value: unknown): boolean {
  if (!isRecord(value)) return true;
  const status = asString(value.status)?.toLowerCase();
  return value.success !== false && !status?.includes("error") && status !== "failed" && status !== "cancelled";
}

export function toolCard(options: {
  name: string;
  state: string;
  input?: unknown;
  inputText?: string;
  result?: unknown;
  error?: unknown;
}): string {
  const lines = [`#### ⚙ ${options.name} · ${options.state}`];
  const input = options.inputText?.trim() || stringify(options.input);
  if (input) lines.push("", "Input:", "```json", truncate(input), "```");
  const result = stringify(resultValue(options.result));
  if (result) lines.push("", "Result:", "```text", truncate(result), "```");
  const error = options.error instanceof Error
    ? options.error.message
    : asString(options.error) ?? stringify(options.error);
  if (error) lines.push("", `Error: ${truncate(error)}`);
  return lines.join("\n");
}
