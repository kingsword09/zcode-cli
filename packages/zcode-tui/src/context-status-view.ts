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
import type { ContextCacheTrend, ContextCacheTurn } from "./context-cache.ts";
import type { SessionMetrics } from "./session-status.ts";
import type { ZCodeTheme } from "./theme.ts";

const contextLabels: Record<RuntimeContextBreakdownItem["source"], string> = {
  system_prompt: "System prompt",
  meta_user_context: "User context",
  skills: "Skills",
  tool_prompt: "Tool prompts",
  system_tool_schemas: "System tool schemas",
  mcp_tool_schemas: "MCP tool schemas",
  messages: "Messages",
  user_messages: "User messages",
  assistant_messages: "Assistant messages",
  tool_io: "Tool input/output"
};

function contextStyle(source: RuntimeContextBreakdownItem["source"], theme: ZCodeTheme): (text: string) => string {
  if (source === "messages" || source === "assistant_messages") return theme.accent;
  if (source === "user_messages" || source === "skills" || source === "mcp_tool_schemas") return theme.success;
  if (source === "tool_io" || source === "system_prompt" || source === "system_tool_schemas") return theme.warning;
  return theme.muted;
}

function percent(value: number, total: number): string {
  return total > 0 ? `${(value / total * 100).toFixed(1)}%` : "0%";
}

function rate(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function summaryLine(
  label: string,
  summary: ContextCacheTrend["active"],
  theme: ZCodeTheme
): string {
  const tokens = `${formatTokens(summary.inputTokens)} input · ${formatTokens(summary.cacheReadTokens)} read · ${formatTokens(summary.cacheWriteTokens)} write`;
  return `${theme.bold(label)}  ${rate(summary.hitRate)} hit · ${summary.requests} requests · ${theme.muted(tokens)}`;
}

function turnMarker(turn: ContextCacheTurn, theme: ZCodeTheme): string {
  if (turn.state === "unknown") return theme.muted("?");
  if (turn.state === "hit") return theme.success("█");
  return theme.warning("░");
}

function trendGraph(turns: ContextCacheTurn[], width: number, theme: ZCodeTheme): string[] {
  const points = turns.slice(-Math.max(1, Math.min(80, width - 8)));
  if (points.length === 0) return [theme.muted("No request-level cache data yet.")];
  const height = 4;
  const columns = Array.from({ length: height }, () => "");
  for (let row = height; row >= 1; row -= 1) {
    columns[height - row] = points.map((turn) => {
      if (turn.state === "unknown") return " ";
      const level = Math.max(0, Math.min(height, Math.round((turn.hitRate ?? 0) * height)));
      return level >= row ? turnMarker(turn, theme) : " ";
    }).join("");
  }
  const labels = points.map((turn) => turn.state === "unknown" ? " " : "·").join("");
  return [
    `${theme.muted("100% ")} ${columns[0]}`,
    `${theme.muted(" 75% ")} ${columns[1]}`,
    `${theme.muted(" 50% ")} ${columns[2]}`,
    `${theme.muted(" 25% ")} ${columns[3]}`,
    `${theme.muted("  0% ")} ${labels}`,
    theme.muted("█ cache hit · ░ uncached request · blank gap = unavailable")
  ];
}

function recentTurnLine(turn: ContextCacheTurn, theme: ZCodeTheme): string {
  const id = turn.messageId ? turn.messageId.slice(-8) : "unknown";
  const usage = turn.inputTokens === undefined
    ? "cache data unavailable"
    : `${rate(turn.hitRate)} hit · ${formatTokens(turn.inputTokens)} input · ${formatTokens(turn.cacheReadTokens ?? 0)} read`;
  return `${turnMarker(turn, theme)} ${String(turn.index).padStart(3, " ")}  ${theme.muted(id)}  ${usage}`;
}

export interface ContextDetailRefreshData {
  usage?: RuntimeContextUsage;
  trend?: ContextCacheTrend;
}

export class ContextDetailView implements Component {
  private usage?: RuntimeContextUsage;
  private trend?: ContextCacheTrend;
  private page: "overview" | "trend" | "composition" = "overview";
  private refreshing = false;

  constructor(
    private readonly theme: ZCodeTheme,
    usage?: RuntimeContextUsage,
    trend?: ContextCacheTrend,
    private readonly refresh?: () => Promise<ContextDetailRefreshData>,
    private readonly requestRender?: () => void
  ) {
    this.usage = usage;
    this.trend = trend;
  }

  invalidate(): void {}

  setData(usage: RuntimeContextUsage | undefined, trend: ContextCacheTrend | undefined): void {
    this.usage = usage;
    this.trend = trend;
  }

  handleInput(data: string): boolean {
    const key = data.length === 1 ? data.toLowerCase() : data;
    if (key === "1" || key === "2" || key === "3" || key === "v") {
      const pages = ["overview", "trend", "composition"] as const;
      this.page = key === "v"
        ? pages[(pages.indexOf(this.page) + 1) % pages.length]!
        : pages[Number(key) - 1]!;
      this.requestRender?.();
      return true;
    }
    if (key !== "r" || !this.refresh || this.refreshing) return false;
    this.refreshing = true;
    this.requestRender?.();
    void this.refresh().then((data) => {
      this.setData(data.usage, data.trend);
    }).catch(() => {
      // A context refresh is supplementary; keep the last good snapshot.
    }).finally(() => {
      this.refreshing = false;
      this.requestRender?.();
    });
    return true;
  }

  render(width: number): string[] {
    if (this.page === "trend") return this.renderTrend(width);
    if (this.page === "composition") return this.renderComposition(width);
    return this.renderOverview(width);
  }

  private renderOverview(width: number): string[] {
    if (!this.usage) return [this.theme.muted("Context usage is unavailable in this runtime.")];
    const safeWidth = Math.max(1, width);
    const totalChars = this.usage.breakdown.reduce((total, item) => total + item.chars, 0);
    const barWidth = Math.max(8, Math.min(40, safeWidth - 2));
    const bar = this.usage.breakdown.map((item) => {
      const columns = totalChars > 0 ? Math.max(1, Math.round(item.chars / totalChars * barWidth)) : 0;
      return contextStyle(item.source, this.theme)("█".repeat(columns));
    }).join("");
    const usedPercent = Math.max(0, Math.round(this.usage.used / this.usage.size * 100));
    const remaining = Math.max(0, this.usage.size - this.usage.used);
    const usageStyle = usedPercent >= 90 ? this.theme.error : usedPercent >= 70 ? this.theme.warning : (text: string) => text;
    const lines = [
      this.theme.bold("Context overview"),
      usageStyle(`${formatTokens(this.usage.used)} / ${formatTokens(this.usage.size)} tokens · ${usedPercent}% used · ${formatTokens(remaining)} remaining`)
    ];
    if (this.refreshing) lines.push(this.theme.muted("Refreshing context data…"));
    if (this.trend) {
      lines.push(
        "",
        this.theme.bold("Cache health · exact runtime tokens"),
        summaryLine("Active branch", this.trend.active, this.theme),
        summaryLine("Whole tree", this.trend.wholeTree, this.theme),
        this.theme.muted(`Latest ${rate(this.trend.wholeTree.latestHitRate)} · min ${rate(this.trend.wholeTree.minHitRate)} · max ${rate(this.trend.wholeTree.maxHitRate)} · ${this.trend.turns.length} turns`),
        ...trendGraph(this.trend.turns, safeWidth, this.theme),
        "",
        this.theme.bold("Recent cache requests")
      );
      lines.push(...this.trend.turns.slice(-8).map((turn) => recentTurnLine(turn, this.theme)));
      if (this.trend.turns.some((turn) => turn.state === "unknown")) {
        lines.push(this.theme.muted("Request-level token data is unavailable; gaps are intentional."));
      }
    }
    if (totalChars > 0) {
      lines.push("", this.theme.bold("Estimated prompt composition by characters"), truncateToWidth(bar, safeWidth));
      for (const item of this.usage.breakdown.slice().sort((left, right) => right.chars - left.chars)) {
        const label = contextLabels[item.source];
        const value = `${item.chars.toLocaleString()} chars · ${percent(item.chars, totalChars)}`;
        const available = Math.max(1, safeWidth - visibleWidth(value) - 3);
        lines.push(`${contextStyle(item.source, this.theme)("●")} ${truncateToWidth(label, available)} ${this.theme.muted(value)}`);
      }
    } else {
      lines.push("", this.theme.muted("Prompt source composition is unavailable for this turn."));
    }
    const cache = this.usage.cache;
    if (cache) {
      lines.push("", this.theme.bold("Session cache totals"));
      const latest = [
        cache.latestHitRate !== undefined && cache.latestHitRate !== null ? `${Math.round(cache.latestHitRate * 100)}% hit` : undefined,
        cache.cacheReadTokens !== undefined ? `${formatTokens(cache.cacheReadTokens)} read` : undefined,
        cache.cacheWriteTokens !== undefined ? `${formatTokens(cache.cacheWriteTokens)} written` : undefined,
        cache.inputTokens !== undefined ? `${formatTokens(cache.inputTokens)} input` : undefined
      ].filter(Boolean);
      if (latest.length > 0) {
        const latestLabel = cache.latestHitRate !== undefined && cache.latestHitRate !== null
          ? `${Math.round(cache.latestHitRate * 100)}% hit rate`
          : latest.join(" · ");
        lines.push(this.theme.muted(`Latest request  ${latestLabel}${latest.length > 1 ? ` · ${latest.slice(1).join(" · ")}` : ""}`));
      }
      const aggregateTokens = [
        cache.totalCacheReadTokens !== undefined ? `${formatTokens(cache.totalCacheReadTokens)} read` : undefined,
        cache.totalCacheWriteTokens !== undefined ? `${formatTokens(cache.totalCacheWriteTokens)} written` : undefined,
        cache.totalInputTokens !== undefined ? `${formatTokens(cache.totalInputTokens)} input` : undefined
      ].filter(Boolean);
      if (aggregateTokens.length > 0) lines.push(this.theme.muted(`Session tokens  ${aggregateTokens.join(" · ")}`));
      if (cache.hitRate !== undefined && cache.hitRate !== null) {
        lines.push(this.theme.muted(`Session total   ${Math.round(cache.hitRate * 100)}% hit rate · ${cache.hitRateRequestCount ?? 0} requests`));
      }
    }
    if (this.usage.cost) lines.push(this.theme.muted(`Cost: ${this.usage.cost.amount} ${this.usage.cost.currency}`));
    lines.push("", this.theme.muted("1 overview · 2 cache trend · 3 composition · v cycle · r refresh"));
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  private renderTrend(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (!this.trend) return [this.theme.bold("Cache trend"), this.theme.muted("Per-turn cache data is unavailable in this runtime."), this.theme.muted("1 overview · 3 composition · r refresh")];
    const lines = [
      this.theme.bold("Context cache · per request"),
      summaryLine("Active branch", this.trend.active, this.theme),
      summaryLine("Whole tree", this.trend.wholeTree, this.theme),
      this.theme.muted(`Latest ${rate(this.trend.wholeTree.latestHitRate)} · min ${rate(this.trend.wholeTree.minHitRate)} · max ${rate(this.trend.wholeTree.maxHitRate)} · ${this.trend.turns.length} turns`),
      "",
      ...trendGraph(this.trend.turns, safeWidth, this.theme),
      this.theme.muted("Misses and gaps are kept; runtime restarts are not smoothed."),
      "",
      this.theme.bold("Recent 8 requests"),
      ...this.trend.turns.slice(-8).map((turn) => recentTurnLine(turn, this.theme)),
      this.theme.muted("1 overview · 2 cache trend · 3 composition · v cycle · r refresh")
    ];
    if (this.trend.turns.some((turn) => turn.state === "unknown")) {
      lines.splice(lines.length - 1, 0, this.theme.muted("Unknown usage stays blank; no interpolation is applied."));
    }
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  private renderComposition(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (!this.usage) return [this.theme.muted("Prompt composition is unavailable in this runtime.")];
    const totalChars = this.usage.breakdown.reduce((total, item) => total + item.chars, 0);
    if (totalChars <= 0) return [this.theme.bold("Estimated prompt composition by characters"), this.theme.muted("Prompt source composition is unavailable for this turn."), this.theme.muted("1 overview · 2 cache trend · v cycle · r refresh")];
    const barWidth = Math.max(8, Math.min(40, safeWidth - 2));
    const bar = this.usage.breakdown.map((item) => {
      const columns = Math.max(1, Math.round(item.chars / totalChars * barWidth));
      return contextStyle(item.source, this.theme)("█".repeat(columns));
    }).join("");
    const lines = [this.theme.bold("Estimated prompt composition by characters"), truncateToWidth(bar, safeWidth)];
    for (const item of this.usage.breakdown.slice().sort((left, right) => right.chars - left.chars)) {
      const label = contextLabels[item.source];
      const value = `${item.chars.toLocaleString()} chars · ${percent(item.chars, totalChars)}`;
      const available = Math.max(1, safeWidth - visibleWidth(value) - 3);
      lines.push(`${contextStyle(item.source, this.theme)("●")} ${truncateToWidth(label, available)} ${this.theme.muted(value)}`);
    }
    lines.push("", this.theme.muted("These values are character estimates, not provider token counts."), this.theme.muted("1 overview · 2 cache trend · 3 composition · v cycle · r refresh"));
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }
}

export interface StatusDetailData {
  cliVersion?: string;
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
      ["CLI version", this.data.cliVersion],
      ["Runtime version", this.data.version],
      ["Model", this.data.model],
      ["Mode", [this.data.mode, this.data.effort].filter(Boolean).join(" · ")],
      ["Workspace", this.data.workspace],
      ["Git branch", this.data.branch],
      ["Session", projection?.sessionId],
      ["Runtime state", projection?.status],
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
