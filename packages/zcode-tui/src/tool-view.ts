import {
  Box,
  Container,
  Image,
  Spacer,
  Text
} from "@earendil-works/pi-tui";

import {
  fileDiffCard,
  fileDiffsForTool,
  FileDiffView,
  type FileDiffData
} from "./file-diff-view.ts";
import { BoundedToolText, toolTextValue } from "./bounded-tool-text.ts";
import { isPlanUpdateTool, planCard, planHasHiddenItems, PlanUpdateView } from "./plan-view.ts";
import { sanitizeTerminalText, truncateGraphemes } from "./terminal-text.ts";
import { asString, isRecord } from "./types.ts";
import { createTheme, type ZCodeTheme } from "./theme.ts";
import {
  compactToolPayloads,
  isOmittedBinaryPayload
} from "./tool-payload.ts";
import {
  canonicalToolName,
  isKnownTool,
  oneLine,
  recordString,
  specializedToolRender,
  toolSummary,
  type ToolProgressData
} from "./tool-renderers.ts";

const maxPreviewGraphemes = 2_400;
const maxPreviewLines = 16;
const maxPreviewImages = 4;

export interface ToolViewOptions {
  name: string;
  state: string;
  input?: unknown;
  inputText?: string | BoundedToolText;
  result?: unknown;
  error?: unknown;
  progress?: ToolProgressData;
  diffs?: FileDiffData[];
  activeInputOmittedCharacters?: number;
  activeOutputOmittedCharacters?: number;
  retainedPayloadCompacted?: true;
  retainedPayloadTruncated?: boolean;
}

interface ToolImage {
  data: string;
  mimeType: string;
}

function truncate(value: string, expanded: boolean): { text: string; truncated: boolean } {
  const normalized = value.replace(/\r/g, "");
  if (expanded) return { text: normalized, truncated: false };
  const lines = normalized.split("\n");
  if (lines.length > maxPreviewLines) {
    const visible = lines.slice(0, maxPreviewLines).join("\n");
    return {
      text: `${visible}\n… ${lines.length - maxPreviewLines} more lines · Ctrl+O to expand`,
      truncated: true
    };
  }
  const visible = truncateGraphemes(normalized, maxPreviewGraphemes, "");
  if (visible === normalized) return { text: normalized, truncated: false };
  return {
    text: `${visible}\n… output truncated · Ctrl+O to expand`,
    truncated: true
  };
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
  if (typeof value === "string") return sanitizeTerminalText(value);
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, jsonReplacer, 2);
  } catch {
    return sanitizeTerminalText(String(value), { preserveSgr: false });
  }
}

function parsedInput(options: ToolViewOptions): unknown {
  if (options.input !== undefined) return options.input;
  const text = toolTextValue(options.inputText)?.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function materializeToolText(options: ToolViewOptions): ToolViewOptions {
  const activeInputOmittedCharacters = options.inputText instanceof BoundedToolText
    && options.inputText.isTruncated()
    ? options.inputText.omittedCharacters
    : options.activeInputOmittedCharacters;
  const activeOutputOmittedCharacters = options.result instanceof BoundedToolText
    && options.result.isTruncated()
    ? options.result.omittedCharacters
    : options.activeOutputOmittedCharacters;
  const inputText = toolTextValue(options.inputText);
  const result = options.result instanceof BoundedToolText
    ? options.result.value()
    : options.result;
  if (inputText === options.inputText
    && result === options.result
    && activeInputOmittedCharacters === options.activeInputOmittedCharacters
    && activeOutputOmittedCharacters === options.activeOutputOmittedCharacters) {
    return options;
  }
  return {
    ...options,
    inputText,
    result,
    activeInputOmittedCharacters,
    activeOutputOmittedCharacters
  };
}

export function isTerminalToolState(state: string): boolean {
  return ["complete", "completed", "success", "failed", "error", "cancelled", "rejected", "interrupted"]
    .includes(state.toLowerCase());
}

export function compactTerminalToolOptions(options: ToolViewOptions): ToolViewOptions {
  if (options.retainedPayloadCompacted || !isTerminalToolState(options.state)) return options;
  const activeTextTruncated = (options.inputText instanceof BoundedToolText
      && options.inputText.isTruncated())
    || (options.result instanceof BoundedToolText
      && options.result.isTruncated());
  const materialized = materializeToolText(options);
  const input = parsedInput(materialized);
  const diffs = materialized.diffs
    ?? fileDiffsForTool(materialized.name, input, materialized.result, materialized.state);
  const compacted = compactToolPayloads([
    materialized.input,
    materialized.inputText,
    materialized.result,
    materialized.error,
    materialized.progress
  ]);
  return {
    ...materialized,
    input: compacted.values[0],
    inputText: typeof compacted.values[1] === "string" ? compacted.values[1] : undefined,
    result: compacted.values[2],
    error: compacted.values[3],
    progress: compacted.values[4] as ToolProgressData | undefined,
    diffs: diffs.length > 0 ? diffs : undefined,
    retainedPayloadCompacted: true,
    retainedPayloadTruncated: options.retainedPayloadTruncated
      || activeTextTruncated
      || compacted.truncated
      || undefined
  };
}

function mutationInput(name: string, input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const canonical = canonicalToolName(name);
  if (canonical !== "Write" && canonical !== "Edit" && canonical !== "ApplyPatch") return undefined;
  return recordString(input, ["patch_text", "patchText", "patch", "diff", "new_string", "newString", "content"]);
}

function isKnownCompactTool(name: string): boolean {
  return isKnownTool(name);
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
  if (isOmittedBinaryPayload(rawData)) return undefined;
  const dataUrl = /^data:([^;]+);base64,(.+)$/su.exec(rawData);
  const data = dataUrl?.[2] ?? rawData;
  const mimeType = rawMime ?? dataUrl?.[1];
  return mimeType?.startsWith("image/") ? { data, mimeType } : undefined;
}

function resultContent(
  value: unknown,
  expanded: boolean
): { text?: string; images: ToolImage[]; totalImages: number } {
  const images: ToolImage[] = [];
  const text: string[] = [];
  const append = (item: unknown): void => {
    if (typeof item === "string") {
      text.push(sanitizeTerminalText(item));
      return;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      text.push(String(item));
      return;
    }
    if (Array.isArray(item)) {
      for (const nested of item) append(nested);
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
      if (value) append(value);
      return;
    }
    const nested = item.output ?? item.stdout ?? item.text ?? item.message ?? item.value;
    if (nested !== undefined && nested !== item) {
      append(nested);
      return;
    }
    const fallback = stringify(item);
    if (fallback) text.push(fallback);
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

  return {
    text: text.filter(Boolean).join("\n"),
    images: expanded ? images : images.slice(0, maxPreviewImages),
    totalImages: images.length
  };
}

function errorText(value: unknown): string | undefined {
  if (value instanceof Error) return sanitizeTerminalText(value.message, { preserveSgr: false });
  const direct = asString(value);
  return direct ? sanitizeTerminalText(direct, { preserveSgr: false }) : stringify(value);
}

function statePresentation(state: string, theme: ZCodeTheme): { icon: string; suffix?: string } {
  const normalized = state.toLowerCase();
  if (normalized === "complete" || normalized === "completed" || normalized === "success") {
    return { icon: theme.success("✓") };
  }
  if (normalized === "failed" || normalized === "error") {
    return { icon: theme.error("✗"), suffix: "failed" };
  }
  if (normalized === "cancelled") return { icon: theme.warning("■"), suffix: "cancelled" };
  if (normalized === "rejected") return { icon: theme.warning("■"), suffix: "rejected" };
  if (normalized === "interrupted") return { icon: theme.warning("■"), suffix: "interrupted" };
  if (normalized === "scheduled" || normalized === "queued") return { icon: theme.muted("○"), suffix: "queued" };
  if (normalized === "waiting_permission") return { icon: theme.warning("◆"), suffix: "waiting for permission" };
  if (normalized === "preparing") return { icon: theme.muted("○"), suffix: "preparing" };
  if (normalized === "prepared") return { icon: theme.muted("○"), suffix: "prepared" };
  if (normalized === "running") return { icon: theme.accent("●"), suffix: "running" };
  return { icon: theme.muted("○") };
}

function stateBackground(state: string, theme: ZCodeTheme): ((text: string) => string) | undefined {
  const normalized = state.toLowerCase();
  if (normalized === "failed" || normalized === "error" || normalized === "cancelled") {
    return theme.toolErrorBackground;
  }
  return normalized === "waiting_permission" ? theme.toolPendingBackground : undefined;
}

function stylePreview(value: string, theme: ZCodeTheme, expanded: boolean): { text: string; truncated: boolean } {
  const preview = truncate(sanitizeTerminalText(value), expanded);
  return {
    truncated: preview.truncated,
    text: preview.text.split("\n").map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return theme.success(line);
      if (line.startsWith("-") && !line.startsWith("---")) return theme.error(line);
      if (line.startsWith("@@")) return theme.accent(line);
      return theme.muted(line);
    }).join("\n")
  };
}

function toolText(
  options: ToolViewOptions,
  theme: ZCodeTheme,
  input = parsedInput(options),
  expanded = false
): { header: string; body?: string; images: ToolImage[]; truncated: boolean } {
  const presentation = statePresentation(options.state, theme);
  const specialized = specializedToolRender({
    name: options.name,
    state: options.state,
    input,
    result: options.result,
    progress: options.progress,
    expanded,
    theme
  });
  const summary = specialized?.summary ?? toolSummary(options.name, input);
  const displayName = sanitizeTerminalText(
    specialized?.displayName ?? options.name,
    { preserveSgr: false }
  );
  const header = [
    presentation.icon,
    theme.bold(displayName || "Tool"),
    summary && theme.muted(oneLine(summary)),
    presentation.suffix && theme.muted(`· ${presentation.suffix}`)
  ].filter(Boolean).join(" ");

  const sections: string[] = [];
  let truncated = false;
  const mutation = mutationInput(options.name, input);
  if (mutation) {
    const preview = stylePreview(mutation, theme, expanded);
    sections.push(preview.text);
    truncated ||= preview.truncated;
  }
  else if (input !== undefined && !isKnownCompactTool(options.name)) {
    const generic = stringify(input);
    if (generic) {
      const preview = stylePreview(generic, theme, expanded);
      sections.push(preview.text);
      truncated ||= preview.truncated;
    }
  }

  const result = resultContent(options.result, expanded);
  if (specialized?.body) {
    const preview = truncate(specialized.body, expanded);
    const expansionHint = specialized.hiddenContent && !preview.truncated
      ? theme.muted("Ctrl+O to expand")
      : undefined;
    sections.push([preview.text, expansionHint].filter(Boolean).join("\n"));
    truncated ||= preview.truncated || specialized.hiddenContent === true;
  }
  if (result.text && !specialized?.consumesResult) {
    const preview = stylePreview(result.text, theme, expanded);
    sections.push(preview.text);
    truncated ||= preview.truncated;
  }
  if (result.totalImages > 1) {
    const hiddenImages = result.totalImages - result.images.length;
    sections.push(theme.muted(hiddenImages > 0
      ? `${result.images.length} of ${result.totalImages} images shown · Ctrl+O to show all`
      : `${result.totalImages} images`));
    truncated ||= hiddenImages > 0;
  }
  if (options.retainedPayloadTruncated) {
    sections.push(theme.muted("… completed tool payload retained as a bounded preview"));
    truncated = true;
  }
  if (!isTerminalToolState(options.state)) {
    if (options.activeInputOmittedCharacters) {
      sections.push(theme.muted(
        `… ${options.activeInputOmittedCharacters} input characters omitted from active tool stream`
      ));
      truncated = true;
    }
    if (options.activeOutputOmittedCharacters) {
      sections.push(theme.muted(
        `… ${options.activeOutputOmittedCharacters} output characters omitted from active tool stream`
      ));
      truncated = true;
    }
  }
  const embeddedError = isRecord(options.result) ? options.result.error : undefined;
  const error = errorText(options.error ?? embeddedError);
  if (error) {
    const preview = truncate(error, expanded);
    sections.push(theme.error(`Error: ${preview.text}`));
    truncated ||= preview.truncated;
  }
  return { header, body: sections.filter(Boolean).join("\n"), images: result.images, truncated };
}

export class ToolExecutionView extends Container {
  private options: ToolViewOptions;
  private expanded = false;
  private hiddenContent = false;
  private dirty = true;
  private readonly card = new Box(1, 0);
  private readonly imageHost = new Container();

  constructor(private readonly theme: ZCodeTheme, options: ToolViewOptions) {
    super();
    this.options = compactTerminalToolOptions(options);
    this.addChild(this.card);
    this.addChild(this.imageHost);
  }

  update(options: ToolViewOptions): void {
    this.options = compactTerminalToolOptions(options);
    this.dirty = true;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.dirty = true;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    this.ensureRebuilt();
    return this.hiddenContent;
  }

  override render(width: number): string[] {
    this.ensureRebuilt();
    return super.render(width);
  }

  getSearchText(): string {
    const options = materializeToolText(this.options);
    return [
      options.name,
      stringify(parsedInput(options)),
      stringify(options.result),
      stringify(options.diffs),
      errorText(options.error)
    ]
      .filter(Boolean)
      .join("\n");
  }

  getState(): string {
    return this.options.state;
  }

  getName(): string {
    return this.options.name;
  }

  getSummary(): string | undefined {
    const options = materializeToolText(this.options);
    return toolSummary(options.name, parsedInput(options));
  }

  isTerminal(): boolean {
    return isTerminalToolState(this.options.state);
  }

  private ensureRebuilt(): void {
    if (!this.dirty) return;
    this.rebuild();
    this.dirty = false;
  }

  private rebuild(): void {
    const options = materializeToolText(this.options);
    this.card.clear();
    this.imageHost.clear();
    this.hiddenContent = false;
    this.card.setBgFn(stateBackground(options.state, this.theme));
    const input = parsedInput(options);
    if (isPlanUpdateTool(options.name)) {
      this.card.addChild(new PlanUpdateView(this.theme, {
        state: options.state,
        input,
        result: options.result,
        error: options.error,
        expanded: this.expanded
      }));
      this.hiddenContent = !this.expanded && planHasHiddenItems(input, options.result);
      return;
    }
    const diffs = options.diffs
      ?? fileDiffsForTool(options.name, input, options.result, options.state);
    if (diffs.length > 0) {
      this.card.setBgFn(undefined);
      this.card.addChild(new FileDiffView(this.theme, {
        toolName: options.name,
        state: options.state,
        diffs,
        expanded: this.expanded
      }));
      this.hiddenContent = !this.expanded && diffs.some((diff) => diff.truncated
        || diff.structuredPatch.length > 8
        || diff.structuredPatch.reduce((total, hunk) => total + hunk.lines.length, 0) > 160);
      return;
    }
    const rendered = toolText(options, this.theme, input, this.expanded);
    this.hiddenContent = rendered.truncated;
    this.card.addChild(new Text(rendered.header, 0, 0));
    if (rendered.body) this.card.addChild(new Text(rendered.body, 1, 0));
    if (rendered.images.length > 0) this.imageHost.addChild(new Spacer(1));
    for (const image of rendered.images) {
      this.imageHost.addChild(new Image(
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
  const retained = materializeToolText(compactTerminalToolOptions(options));
  if (isPlanUpdateTool(retained.name)) {
    return planCard({
      state: retained.state,
      input: parsedInput(retained),
      result: retained.result,
      error: retained.error
    });
  }
  const input = parsedInput(retained);
  const diffs = retained.diffs
    ?? fileDiffsForTool(retained.name, input, retained.result, retained.state);
  if (diffs.length > 0) {
    return fileDiffCard({ toolName: retained.name, state: retained.state, diffs });
  }
  const rendered = toolText(retained, createTheme(false), input);
  return [rendered.header, rendered.body].filter(Boolean).join("\n");
}
