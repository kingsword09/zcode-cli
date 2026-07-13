import {
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

import { formatTokens, goalStatusText, type GoalState } from "./goal-status.ts";
import type {
  RuntimeContextBreakdownItem,
  RuntimeContextUsage,
  RuntimeProjectionSnapshot
} from "./runtime-projection.ts";
import type { SessionMetrics } from "./session-status.ts";
import type { ZCodeTheme } from "./theme.ts";

const contextLabels: Record<RuntimeContextBreakdownItem["source"], string> = {
  system_prompt: "System prompt",
  meta_user_context: "User context",
  skills: "Skills",
  tool_prompt: "Tool prompts",
  system_tool_schemas: "System tool schemas",
  mcp_tool_schemas: "MCP tool schemas",
  messages: "Messages"
};

function contextStyle(source: RuntimeContextBreakdownItem["source"], theme: ZCodeTheme): (text: string) => string {
  if (source === "messages") return theme.accent;
  if (source === "skills" || source === "mcp_tool_schemas") return theme.success;
  if (source === "system_prompt" || source === "system_tool_schemas") return theme.warning;
  return theme.muted;
}

function percent(value: number, total: number): string {
  return total > 0 ? `${(value / total * 100).toFixed(1)}%` : "0%";
}

export class ContextDetailView implements Component {
  constructor(
    private readonly theme: ZCodeTheme,
    private readonly usage?: RuntimeContextUsage
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.usage) return [this.theme.muted("Context usage is unavailable in this runtime.")];
    const totalChars = this.usage.breakdown.reduce((total, item) => total + item.chars, 0);
    const barWidth = Math.max(8, Math.min(40, width - 2));
    const bar = this.usage.breakdown.map((item) => {
      const columns = totalChars > 0 ? Math.max(1, Math.round(item.chars / totalChars * barWidth)) : 0;
      return contextStyle(item.source, this.theme)("█".repeat(columns));
    }).join("");
    const cache = this.usage.cache;
    const cacheHitRate = cache?.latestHitRate ?? cache?.hitRate;
    const lines = [
      this.theme.bold("Context Usage"),
      `${formatTokens(this.usage.used)} / ${formatTokens(this.usage.size)} tokens · ${Math.round(this.usage.used / this.usage.size * 100)}% used`,
      truncateToWidth(bar, width),
      "",
      this.theme.muted("Estimated prompt composition by characters")
    ];
    for (const item of this.usage.breakdown.slice().sort((left, right) => right.chars - left.chars)) {
      const label = contextLabels[item.source];
      const value = `${item.chars.toLocaleString()} chars · ${percent(item.chars, totalChars)}`;
      const available = Math.max(1, width - visibleWidth(value) - 3);
      lines.push(`${contextStyle(item.source, this.theme)("●")} ${truncateToWidth(label, available)} ${this.theme.muted(value)}`);
    }
    if (cache) {
      lines.push("", this.theme.bold("Prompt cache"));
      lines.push(this.theme.muted([
        cacheHitRate !== undefined && cacheHitRate !== null ? `${Math.round(cacheHitRate * 100)}% hit rate` : undefined,
        cache.cacheReadTokens !== undefined ? `${formatTokens(cache.cacheReadTokens)} read` : undefined,
        cache.cacheWriteTokens !== undefined ? `${formatTokens(cache.cacheWriteTokens)} written` : undefined,
        cache.inputTokens !== undefined ? `${formatTokens(cache.inputTokens)} input` : undefined
      ].filter(Boolean).join(" · ")));
      if (cache.totalInputTokens !== undefined || cache.hitRateRequestCount !== undefined) {
        lines.push(this.theme.muted([
          cache.hitRateRequestCount !== undefined ? `${cache.hitRateRequestCount} requests` : undefined,
          cache.totalInputTokens !== undefined ? `${formatTokens(cache.totalInputTokens)} total input` : undefined,
          cache.totalCacheReadTokens !== undefined ? `${formatTokens(cache.totalCacheReadTokens)} total read` : undefined,
          cache.totalCacheWriteTokens !== undefined ? `${formatTokens(cache.totalCacheWriteTokens)} total written` : undefined
        ].filter(Boolean).join(" · ")));
      }
    }
    if (this.usage.cost) {
      lines.push(this.theme.muted(`Cost: ${this.usage.cost.amount} ${this.usage.cost.currency}`));
    }
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }
}

export interface StatusDetailData {
  version?: string;
  model: string;
  mode: string;
  effort?: string;
  workspace: string;
  branch?: string;
  locale?: string;
  developerMode?: boolean;
  projection?: RuntimeProjectionSnapshot;
  metrics: SessionMetrics;
  goal?: GoalState;
  openTodos: number;
  mcpSummary?: string;
}

export class StatusDetailView implements Component {
  constructor(
    private readonly theme: ZCodeTheme,
    private readonly data: StatusDetailData
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const projection = this.data.projection;
    const metrics = this.data.metrics;
    const rows: Array<[string, string | undefined]> = [
      ["Version", this.data.version],
      ["Model", this.data.model],
      ["Mode", [this.data.mode, this.data.effort].filter(Boolean).join(" · ")],
      ["Workspace", this.data.workspace],
      ["Git branch", this.data.branch],
      ["Session", projection?.sessionId],
      ["Runtime", projection?.status],
      ["Last error", projection?.lastError
        ? [projection.lastError.code, projection.lastError.message].filter(Boolean).join(" · ")
        : undefined],
      ["Turns", String(metrics.turnCount ?? projection?.turnCount ?? 0)],
      ["Tokens", metrics.totalTokens !== undefined ? formatTokens(metrics.totalTokens) : undefined],
      ["Requests", metrics.modelRequestCount !== undefined
        ? `${metrics.modelRequestCount}${metrics.modelErrorCount ? ` · ${metrics.modelErrorCount} errors` : ""}`
        : undefined],
      ["Active tools", projection ? String(projection.activeToolCalls.length) : undefined],
      ["Background", projection ? String(projection.backgroundJobs.filter((job) => job.status === "running").length) : undefined],
      ["Open tasks", String(this.data.openTodos)],
      ["Goal", goalStatusText(this.data.goal)],
      ["MCP", this.data.mcpSummary],
      ["Locale", this.data.locale],
      ["Developer mode", this.data.developerMode === undefined ? undefined : this.data.developerMode ? "enabled" : "disabled"]
    ];
    const visible = rows.filter((row): row is [string, string] => Boolean(row[1]));
    const labelWidth = Math.max(...visible.map(([label]) => visibleWidth(label)), 1);
    return [
      this.theme.bold("ZCode Status"),
      ...visible.map(([label, value]) => truncateToWidth(
        `${this.theme.muted(label.padEnd(labelWidth))}  ${value}`,
        Math.max(1, width)
      ))
    ];
  }
}
