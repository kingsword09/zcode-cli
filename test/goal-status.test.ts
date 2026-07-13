import { describe, expect, test } from "bun:test";

import {
  formatTokens,
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
    expect(goalStatusText(active)).toBe("Pursuing goal (40K / 50K)");
    expect(goalStatusText({ ...active, status: "paused" })).toBe("Goal paused (/goal resume)");
    expect(goalStatusText({ ...active, status: "budget_limited" })).toBe("Goal unmet (40K / 50K)");
    expect(goalStatusText({ ...active, status: "complete", timeUsedSeconds: 7_200 })).toBe("Goal achieved (2h)");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});
