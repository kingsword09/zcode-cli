import {
  Container,
  Image,
  Text
} from "@earendil-works/pi-tui";

import { asString, isRecord } from "./types.ts";
import { createTheme, type ZCodeTheme } from "./theme.ts";

const maxPreviewCharacters = 2_400;
const maxPreviewLines = 16;

export interface ToolViewOptions {
  name: string;
  state: string;
  input?: unknown;
  inputText?: string;
  result?: unknown;
  error?: unknown;
}

interface ToolImage {
  data: string;
  mimeType: string;
}

function truncate(value: string): string {
  const normalized = value.replace(/\r/g, "");
  const lines = normalized.split("\n");
  if (lines.length > maxPreviewLines) {
    const visible = lines.slice(0, maxPreviewLines).join("\n");
    return `${visible}\n… ${lines.length - maxPreviewLines} more lines`;
  }
  if (normalized.length <= maxPreviewCharacters) return normalized;
  return `${normalized.slice(0, maxPreviewCharacters)}\n… ${normalized.length - maxPreviewCharacters} more characters`;
}

function jsonReplacer(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (/^data:[^;]+;base64,/iu.test(value)) return `[data URL: ${value.length} characters]`;
  if ((key === "data" || key === "base64") && value.length > 256) {
    return `[binary data: ${value.length} characters]`;
  }
  return value;
}

function stringify(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, jsonReplacer, 2);
  } catch {
    return String(value);
  }
}

function parsedInput(options: ToolViewOptions): unknown {
  if (options.input !== undefined) return options.input;
  const text = options.inputText?.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function recordString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = asString(record[key]);
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function oneLine(value: string, limit = 100): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, Math.max(1, limit - 1))}…`;
}

function quoted(value: string): string {
  return value.includes(" ") ? JSON.stringify(value) : value;
}

function toolSummary(name: string, input: unknown): string | undefined {
  const record = isRecord(input) ? input : undefined;
  const normalized = name.toLowerCase().replace(/[^a-z]/gu, "");
  const path = recordString(record, ["file_path", "filePath", "path"]);

  if (normalized.includes("bash") || normalized.includes("shell") || normalized === "exec") {
    const command = recordString(record, ["command", "cmd", "script"]);
    return command ? oneLine(command) : undefined;
  }
  if (normalized.includes("grep") || normalized.includes("searchtext")) {
    const pattern = recordString(record, ["pattern", "query", "regex"]);
    return [pattern && quoted(oneLine(pattern, 60)), path && `in ${path}`].filter(Boolean).join(" ") || undefined;
  }
  if (normalized.includes("glob") || normalized.includes("find")) {
    const pattern = recordString(record, ["pattern", "glob", "query"]);
    return [pattern && quoted(oneLine(pattern, 60)), path && `in ${path}`].filter(Boolean).join(" ") || undefined;
  }
  if (normalized.includes("webfetch") || normalized === "fetch") {
    return recordString(record, ["url", "uri"]);
  }
  if (normalized.includes("websearch")) {
    return recordString(record, ["query", "q"]);
  }
  if (normalized.includes("skill")) {
    return recordString(record, ["skill", "name"]);
  }
  if (normalized.includes("sendmessage")) {
    const recipient = recordString(record, ["recipient", "target", "to"]);
    return recipient ? `to ${recipient}` : undefined;
  }
  if (normalized === "agent" || normalized.includes("task")) {
    return recordString(record, ["description", "task", "prompt", "subagent_type"]);
  }
  if (path) return path;
  return recordString(record, ["name", "id", "target"]);
}

function mutationInput(name: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const normalized = name.toLowerCase().replace(/[^a-z]/gu, "");
  if (!normalized.includes("write") && !normalized.includes("edit") && !normalized.includes("patch")) return undefined;
  return recordString(input, ["patch", "diff", "new_string", "newString", "content"]);
}

function isKnownCompactTool(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z]/gu, "");
  return [
    "read", "write", "edit", "patch", "bash", "shell", "exec", "grep", "glob", "find",
    "webfetch", "websearch", "skill", "task", "agent", "sendmessage"
  ].some((part) => normalized.includes(part));
}

function imageValue(value: unknown): ToolImage | undefined {
  if (!isRecord(value)) return undefined;
  const source = isRecord(value.source) ? value.source : undefined;
  const rawData = asString(value.data) ?? asString(value.base64) ?? (source && asString(source.data));
  const rawMime = asString(value.mimeType)
    ?? asString(value.mediaType)
    ?? asString(value.media_type)
    ?? (source && (asString(source.mediaType) ?? asString(source.media_type)));
  if (!rawData) return undefined;
  const dataUrl = /^data:([^;]+);base64,(.+)$/su.exec(rawData);
  const data = dataUrl?.[2] ?? rawData;
  const mimeType = rawMime ?? dataUrl?.[1];
  return mimeType?.startsWith("image/") ? { data, mimeType } : undefined;
}

function resultContent(value: unknown): { text?: string; images: ToolImage[] } {
  const images: ToolImage[] = [];
  const text: string[] = [];
  const append = (item: unknown): void => {
    if (typeof item === "string") {
      text.push(item);
      return;
    }
    if (!isRecord(item)) return;
    const image = imageValue(item);
    if (image) {
      images.push(image);
      return;
    }
    const type = asString(item.type)?.toLowerCase();
    if (type === "text") {
      const value = asString(item.text) ?? asString(item.content);
      if (value) text.push(value);
      return;
    }
    const nested = item.output ?? item.stdout ?? item.text ?? item.message ?? item.value;
    if (nested !== undefined && nested !== item) append(nested);
  };

  if (Array.isArray(value)) {
    for (const item of value) append(item);
  } else if (isRecord(value) && Array.isArray(value.content)) {
    for (const item of value.content) append(item);
    const direct = value.output ?? value.stdout ?? value.text ?? value.message ?? value.value;
    if (direct !== undefined) append(direct);
  } else if (isRecord(value)) {
    const direct = value.output ?? value.stdout ?? value.text ?? value.message ?? value.value;
    if (direct !== undefined) append(direct);
    else if (!Object.keys(value).every((key) => ["success", "status", "error", "code"].includes(key))) {
      const fallback = stringify(value);
      if (fallback) text.push(fallback);
    }
  } else {
    append(value);
  }

  return { text: text.filter(Boolean).join("\n"), images: images.slice(0, 4) };
}

function errorText(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  return asString(value) ?? stringify(value);
}

function statePresentation(state: string, theme: ZCodeTheme): { icon: string; suffix?: string } {
  const normalized = state.toLowerCase();
  if (normalized === "complete" || normalized === "completed" || normalized === "success") {
    return { icon: theme.success("✓") };
  }
  if (normalized === "failed" || normalized === "error" || normalized === "cancelled") {
    return { icon: theme.error("✗"), suffix: "failed" };
  }
  if (normalized === "running") return { icon: theme.accent("●"), suffix: "running" };
  return { icon: theme.muted("○") };
}

function stylePreview(value: string, theme: ZCodeTheme): string {
  return truncate(value).split("\n").map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) return theme.success(line);
    if (line.startsWith("-") && !line.startsWith("---")) return theme.error(line);
    if (line.startsWith("@@")) return theme.accent(line);
    return theme.muted(line);
  }).join("\n");
}

function toolText(options: ToolViewOptions, theme: ZCodeTheme): { header: string; body?: string; images: ToolImage[] } {
  const input = parsedInput(options);
  const presentation = statePresentation(options.state, theme);
  const summary = toolSummary(options.name, input);
  const header = [
    presentation.icon,
    theme.bold(options.name),
    summary && theme.muted(oneLine(summary)),
    presentation.suffix && theme.muted(`· ${presentation.suffix}`)
  ].filter(Boolean).join(" ");

  const sections: string[] = [];
  const mutation = mutationInput(options.name, input);
  if (mutation) sections.push(stylePreview(mutation, theme));
  else if (input !== undefined && !isKnownCompactTool(options.name)) {
    const generic = stringify(input);
    if (generic) sections.push(stylePreview(generic, theme));
  }

  const result = resultContent(options.result);
  if (result.text) sections.push(stylePreview(result.text, theme));
  const embeddedError = isRecord(options.result) ? options.result.error : undefined;
  const error = errorText(options.error ?? embeddedError);
  if (error) sections.push(theme.error(`Error: ${truncate(error)}`));
  return { header, body: sections.filter(Boolean).join("\n"), images: result.images };
}

export class ToolExecutionView extends Container {
  private options: ToolViewOptions;

  constructor(private readonly theme: ZCodeTheme, options: ToolViewOptions) {
    super();
    this.options = options;
    this.rebuild();
  }

  update(options: ToolViewOptions): void {
    this.options = options;
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();
    const rendered = toolText(this.options, this.theme);
    this.addChild(new Text(rendered.header, 1, 0));
    if (rendered.body) this.addChild(new Text(rendered.body, 2, 0));
    for (const image of rendered.images) {
      this.addChild(new Image(
        image.data,
        image.mimeType,
        { fallbackColor: this.theme.muted },
        { maxWidthCells: 60, maxHeightCells: 24 }
      ));
    }
  }
}

export function toolSucceeded(value: unknown): boolean {
  if (!isRecord(value)) return true;
  const status = asString(value.status)?.toLowerCase();
  return value.success !== false && !status?.includes("error") && status !== "failed" && status !== "cancelled";
}

// Pure text helper retained for focused tests and non-interactive consumers.
export function toolCard(options: ToolViewOptions): string {
  const rendered = toolText(options, createTheme(false));
  return [rendered.header, rendered.body].filter(Boolean).join("\n");
}
