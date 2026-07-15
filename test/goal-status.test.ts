import { describe, expect, test } from "bun:test";

import {
  formatTokens,
  goalStatusLabel,
  goalStatusText,
  normalizeGoal
} from "../packages/zcode-tui/src/goal-status.ts";

describe("TUI goal status", () => {
  const active = {
    status: "active",
    tokenBudget: 50_000,
    tokensUsed: 40_000,
    timeUsedSeconds: 120
  } as const;

  test("normalizes official ZCode goal snapshots", () => {
    expect(normalizeGoal(active)).toEqual(active);
    expect(normalizeGoal(null)).toBeUndefined();
    expect(normalizeGoal({ ...active, status: "unknown" })).toBeUndefined();
  });

  test("formats goal lifecycle states without repeating the active turn timer", () => {
    expect(goalStatusText(active)).toBe("Active (40K / 50K)");
    expect(goalStatusText({ ...active, status: "paused" })).toBe("Paused (/goal resume)");
    expect(goalStatusText({ ...active, status: "budget_limited" })).toBe("Unmet (40K / 50K)");
    expect(goalStatusText({ ...active, status: "complete", timeUsedSeconds: 7_200 })).toBe("Achieved (2h)");
    expect(goalStatusLabel(active)).toBe("Active");
    expect(goalStatusLabel({ ...active, status: "budget_limited", tokenBudget: null })).toBe("Abandoned");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});
