import { isRecord } from "../types.ts";
import type { SpecializedToolRenderOptions, SpecializedToolRenderResult } from "./types.ts";
import {
  booleanField,
  directText,
  formatBytes,
  formatElapsed,
  nestedRecord,
  numberField,
  recordString,
  safeJson,
  toolSummary
} from "./helpers.ts";
import { displayNameForMcp } from "./registry.ts";

export function linkRows(record: Record<string, unknown> | undefined): string[] {
  if (!record) return [];
  const rows: string[] = [];
  for (const key of ["results", "sources"] as const) {
    const values = record[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (!isRecord(value)) continue;
      const url = recordString(value, ["url", "uri"]);
      if (!url || rows.some((row) => row.endsWith(url))) continue;
      const title = recordString(value, ["title", "name"]);
      const age = recordString(value, ["pageAge", "age"]);
      rows.push(`${title ? `${title} · ` : ""}${url}${age ? ` · ${age}` : ""}`);
    }
  }
  return rows;
}

export function webFetchRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const content = recordString(record, ["result", "content", "text"]);
  const status = numberField(record, ["status", "statusCode", "code"]);
  const statusText = recordString(record, ["statusText", "codeText"]);
  const details = [
    numberField(record, ["bytes"]) !== undefined ? `Received ${formatBytes(numberField(record, ["bytes"]))}` : undefined,
    status !== undefined ? `${status}${statusText ? ` ${statusText}` : ""}` : undefined,
    formatElapsed(numberField(record, ["durationMs", "duration"])),
    booleanField(record, ["cacheHit"]) ? "cache hit" : undefined,
    booleanField(record, ["truncated"]) ? "truncated" : undefined
  ].filter(Boolean).join(" · ");
  const redirects = Array.isArray(record?.redirects) ? record.redirects.length : 0;
  const finalUrl = recordString(record, ["finalUrl"]);
  const metadata = [
    details && options.theme.muted(`└ ${details}`),
    redirects > 0 && options.theme.muted(`${redirects} ${redirects === 1 ? "redirect" : "redirects"}${finalUrl ? ` · ${finalUrl}` : ""}`)
  ].filter(Boolean);
  return {
    displayName: "Fetch",
    summary: toolSummary(options.name, options.input),
    body: [...metadata, ...(options.expanded && content ? [content] : [])].join("\n") || undefined,
    consumesResult: Boolean(record || content),
    hiddenContent: Boolean(content) && !options.expanded
  };
}

export function webSearchRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const results = Array.isArray(record?.results) ? record.results.length : 0;
  const sources = Array.isArray(record?.sources) ? record.sources.length : 0;
  const requests = numberField(record, ["webSearchRequests", "searchCount"]);
  const duration = numberField(record, ["durationMs", "duration"]);
  const summaryText = recordString(record, ["summary"]);
  const rows = linkRows(record);
  const details = [
    `${results} ${results === 1 ? "result" : "results"}`,
    sources > 0 ? `${sources} ${sources === 1 ? "source" : "sources"}` : undefined,
    requests !== undefined ? `${requests} ${requests === 1 ? "search" : "searches"}` : undefined,
    formatElapsed(duration)
  ].filter(Boolean).join(" · ");
  const expanded = [summaryText, ...rows].filter(Boolean).join("\n");
  return {
    displayName: "Web search",
    summary: toolSummary(options.name, options.input),
    body: [options.theme.muted(`└ ${details}`), options.expanded && expanded ? expanded : undefined].filter(Boolean).join("\n"),
    consumesResult: Boolean(record),
    hiddenContent: Boolean(expanded) && !options.expanded
  };
}

export function mcpRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const raw = directText(options.result);
  const progress = options.progress?.progress;
  const total = options.progress?.total;
  const progressLine = progress !== undefined && total !== undefined && total > 0
    ? `${options.progress?.progressMessage ? `${options.progress.progressMessage} · ` : ""}${Math.round(Math.min(1, progress / total) * 100)}%`
    : options.progress?.progressMessage ?? options.progress?.description;
  let content = raw;
  if (!content && record) {
    const entries = Object.entries(record);
    const flat = entries.length > 0 && entries.length <= 12 && entries.every(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value));
    content = flat
      ? entries.map(([key, value]) => `${key.padEnd(Math.max(...entries.map(([name]) => name.length)))}: ${String(value)}`).join("\n")
      : safeJson(record);
  }
  const estimatedTokens = content ? Math.ceil(content.length / 4) : 0;
  const warnings = estimatedTokens > 10_000 ? options.theme.warning(`Large MCP response (~${estimatedTokens.toLocaleString()} tokens)`) : undefined;
  return {
    displayName: displayNameForMcp(options.name),
    summary: toolSummary(options.name, options.input),
    body: [progressLine && options.theme.muted(`└ ${progressLine}`), warnings, content].filter(Boolean).join("\n") || undefined,
    consumesResult: Boolean(content)
  };
}
