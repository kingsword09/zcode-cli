import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  formatElapsed,
  turnStatusText,
  turnTimerAnimationEnabled,
  turnTimerFrame
} from "../packages/zcode-tui/src/turn-status.ts";

describe("TUI turn status", () => {
  test("formats elapsed time compactly", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(185_000)).toBe("3m 05s");
    expect(formatElapsed(3_661_000)).toBe("1h 01m 01s");
  });

  test("keeps elapsed time visible with or without turn activity", () => {
    expect(turnStatusText(undefined, 0)).toBe("[ 🕛 0s ]");
    expect(turnStatusText("thinking…", 3_000)).toBe("thinking… ── [ 🕛 3s ]");
  });

  test("animates the active timer with complete stable-width clock frames", () => {
    const frames = Array.from(
      { length: 12 },
      (_, index) => turnTimerFrame(index * 125, true)
    );
    expect(frames).toEqual(["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"]);
    expect(frames.map(visibleWidth)).toEqual(Array(12).fill(2));
    expect(turnTimerFrame(1_500, true)).toBe("🕛");
    expect(turnStatusText("thinking…", 500, true, true)).toBe("thinking… ── [ 🕓 0s ]");
  });

  test("provides an explicit reduced-motion and basic-terminal fallback", () => {
    expect(turnTimerAnimationEnabled({ TERM: "xterm-256color" })).toBeTrue();
    expect(turnTimerAnimationEnabled({ TERM: "dumb" })).toBeFalse();
    expect(turnTimerAnimationEnabled({ ZCODE_TUI_REDUCED_MOTION: "1" })).toBeFalse();
    expect(turnTimerFrame(500, false)).toBe("🕛");
  });

  test("hides idle timing without suppressing out-of-turn activity", () => {
    expect(turnStatusText(undefined, 0, false)).toBeUndefined();
    expect(turnStatusText("Esc again to rewind conversation", 0, false)).toBe("Esc again to rewind conversation");
  });
});
