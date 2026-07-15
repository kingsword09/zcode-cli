import { describe, expect, test } from "bun:test";

import {
  ContextDetailView,
  StatusDetailView
} from "../packages/zcode-tui/src/context-status-view.ts";
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
      cache: { cacheReadTokens: 10_000, latestHitRate: 0.75 },
      cost: { amount: 0.2, currency: "USD" }
    }).render(80).join("\n");
    expect(output).toContain("30K / 100K tokens · 30% used");
    expect(output).toContain("Messages");
    expect(output).toContain("75% hit rate");
    expect(output).toContain("0.2 USD");
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
