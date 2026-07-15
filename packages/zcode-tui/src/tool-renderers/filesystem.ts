import type { SpecializedToolRenderOptions, SpecializedToolRenderResult } from "./types.ts";
import {
  booleanField,
  directText,
  formatElapsed,
  nestedRecord,
  numberField,
  recordString,
  toolSummary
} from "./helpers.ts";
import { canonicalToolName } from "./registry.ts";

export function readRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const raw = directText(options.result);
  const count = numberField(record, ["numLines", "lineCount", "count", "numPages", "pageCount"])
    ?? (raw ? raw.replace(/\r/g, "").split("\n").length : undefined);
  const type = recordString(record, ["type", "kind"]);
  const unit = type?.includes("pdf") || record?.numPages !== undefined || record?.pageCount !== undefined
    ? "pages"
    : type?.includes("image")
      ? "image"
      : "lines";
  const status = count !== undefined
    ? `Read ${count} ${count === 1 ? unit.replace(/s$/u, "") : unit}`
    : type?.includes("image")
      ? "Read image"
      : undefined;
  return {
    displayName: "Read",
    summary: toolSummary(options.name, options.input),
    body: options.expanded && raw
      ? [status && options.theme.muted(status), raw].filter(Boolean).join("\n")
      : status && options.theme.muted(status),
    consumesResult: true,
    hiddenContent: Boolean(raw) && !options.expanded
  };
}

export function searchRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const amount = numberField(record, ["numMatches", "numFiles", "numLines", "count"]);
  const label = record?.numFiles !== undefined ? "files" : record?.numLines !== undefined ? "lines" : "matches";
  const duration = numberField(record, ["durationMs", "duration"]);
  const status = [
    amount !== undefined ? `Found ${amount} ${amount === 1 ? label.replace(/s$/u, "") : label}` : undefined,
    formatElapsed(duration),
    booleanField(record, ["truncated"]) ? "truncated" : undefined
  ].filter(Boolean).join(" · ");
  const filenames = Array.isArray(record?.filenames)
    ? record.filenames.filter((item): item is string => typeof item === "string").join("\n")
    : undefined;
  const content = recordString(record, ["content", "output", "text"]) ?? filenames ?? directText(options.result);
  return {
    displayName: canonicalToolName(options.name) === "Glob" ? "Glob" : "Grep",
    summary: toolSummary(options.name, options.input),
    body: options.expanded && content
      ? [status && options.theme.muted(status), content].filter(Boolean).join("\n")
      : status && options.theme.muted(status),
    consumesResult: true,
    hiddenContent: Boolean(content) && !options.expanded
  };
}

export function mutationRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  return {
    displayName: canonicalToolName(options.name),
    summary: toolSummary(options.name, options.input)
  };
}
