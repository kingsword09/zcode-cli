import { describe, expect, test } from "bun:test";

import {
  ContextDetailView,
  StatusDetailView
} from "../packages/zcode-tui/src/context-status-view.ts";
import type { ContextCacheTrend } from "../packages/zcode-tui/src/context-cache.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("context and status detail views", () => {
  test("renders context breakdown, cache usage and cost", () => {
    const output = new ContextDetailView(createTheme(false), {
      used: 30_000,
      size: 100_000,
      breakdown: [
        { source: "messages", chars: 80_000 },
        { source: "system_prompt", chars: 20_000 }
      ],
      cache: {
        inputTokens: 12_000,
        cacheReadTokens: 10_000,
        latestHitRate: 0.75,
        hitRate: 0.99,
        hitRateRequestCount: 42,
        totalInputTokens: 1_044_000_000,
        totalCacheReadTokens: 1_036_000_000,
        totalCacheWriteTokens: 0
      },
      cost: { amount: 0.2, currency: "USD" }
    }).render(100).join("\n");
    expect(output).toContain("30K / 100K tokens · 30% used");
    expect(output).toContain("70K remaining");
    expect(output).toContain("Messages");
    expect(output).toContain("Latest request");
    expect(output).toContain("75% hit rate");
    expect(output).toContain("Session total");
    expect(output).toContain("42 requests");
    expect(output).toContain("1G read");
    expect(output).toContain("0.2 USD");
  });

  test("explains when prompt source composition is unavailable", () => {
    const output = new ContextDetailView(createTheme(false), {
      used: 90_000,
      size: 100_000,
      breakdown: []
    }).render(80).join("\n");
    expect(output).toContain("90K / 100K tokens · 90% used · 10K remaining");
    expect(output).toContain("Prompt source composition is unavailable");
  });

  test("switches to the request trend view without losing gaps", () => {
    const trend: ContextCacheTrend = {
      turns: [
        { index: 1, messageId: "a1", inputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 0, hitRate: 1, state: "hit", active: true },
        { index: 2, messageId: "a2", state: "unknown", active: true },
        { index: 3, messageId: "a3", inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 100, hitRate: 0, state: "miss", active: true }
      ],
      active: { requests: 2, inputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 100, hitRate: 0.5, latestHitRate: 0, minHitRate: 0, maxHitRate: 1 },
      wholeTree: { requests: 2, inputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 100, hitRate: 0.5, latestHitRate: 0, minHitRate: 0, maxHitRate: 1 }
    };
    const view = new ContextDetailView(createTheme(false), {
      used: 20_000,
      size: 100_000,
      breakdown: []
    }, trend);
    view.handleInput("2");
    const output = view.render(100).join("\n");
    expect(output).toContain("Context cache · per request");
    expect(output).toContain("Recent 8 requests");
    expect(output).toContain("a2");
    expect(output).toContain("cache data unavailable");
  });

  test("keeps status details separate from the compact statusline", () => {
    const output = new StatusDetailView(createTheme(false), {
      cliVersion: "3.3.5-1",
      version: "1.0.0",
      model: "custom/glm",
      mode: "build",
      effort: "high",
      workspace: "/repo",
      branch: "main",
      metrics: { totalTokens: 18_000, turnCount: 4 },
      goal: { status: "active", tokenBudget: 50_000, tokensUsed: 40_000, timeUsedSeconds: 120 },
      openTodos: 2,
      mcpSummary: "2 connected"
    }).render(80).join("\n");
    expect(output).toContain("ZCode Status");
    expect(output).toContain("CLI version      3.3.5-1");
    expect(output).toContain("Runtime version  1.0.0");
    expect(output).toContain("custom/glm");
    expect(output).toMatch(/Goal\s+Active \(40K \/ 50K\)/u);
    expect(output).not.toContain("[ Goal:");
    expect(output).toContain("2 connected");
  });
});
