import { describe, expect, test } from "bun:test";

import {
  buildExitSummary,
  formatTokenUsage,
  resumeCommand
} from "../packages/zcode-tui/src/exit-summary.ts";

describe("TUI exit summary", () => {
  test("matches Codex-style elapsed time, token accounting, and resume guidance", () => {
    const summary = buildExitSummary({
      elapsedMilliseconds: 105_000,
      metrics: {
        totalTokens: 417_202,
        inputTokens: 411_755,
        outputTokens: 5_447,
        reasoningTokens: 2_008,
        cacheReadTokens: 345_600
      },
      sessionId: "sess_019f5575",
      width: 80
    });

    expect(summary.divider).toStartWith("─ Worked for 1m 45s ─");
    expect(summary.divider).toHaveLength(80);
    expect(summary.tokenUsage).toBe(
      "Token usage: total=71,602 input=66,155 (+ 345,600 cached) output=5,447 (reasoning 2,008)"
    );
    expect(summary.resumeCommand).toBe("zcode --resume sess_019f5575");
  });

  test("omits unavailable values without inventing metrics", () => {
    expect(buildExitSummary({
      elapsedMilliseconds: 30_000,
      metrics: {},
      sessionId: "sess_resume",
      width: 40
    })).toEqual({
      divider: undefined,
      tokenUsage: undefined,
      resumeCommand: "zcode --resume sess_resume"
    });
    expect(formatTokenUsage({ totalTokens: 0 })).toBeUndefined();
  });

  test("quotes unusual session identifiers and rejects terminal control text", () => {
    expect(resumeCommand("session with space")).toBe("zcode --resume='session with space'");
    expect(resumeCommand("line\nbreak")).toBeUndefined();
    expect(resumeCommand("\x1b[31m\x1b[0m")).toBeUndefined();
    expect(resumeCommand("sess_\x1b[31munsafe\x1b[0m")).toBeUndefined();
  });
});
