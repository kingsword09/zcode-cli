import { describe, expect, test } from "bun:test";

import { formatElapsed, turnStatusText } from "../packages/zcode-tui/src/turn-status.ts";

describe("TUI turn status", () => {
  test("formats elapsed time compactly", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(185_000)).toBe("3m 05s");
    expect(formatElapsed(3_661_000)).toBe("1h 01m 01s");
  });

  test("keeps elapsed time visible with or without turn activity", () => {
    expect(turnStatusText(undefined, 0)).toBe("[0s]");
    expect(turnStatusText("thinking…", 3_000)).toBe("thinking… · [3s]");
  });
});
