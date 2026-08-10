import { describe, expect, test } from "bun:test";

import { workedDurationLabel, WorkDurationView } from "../packages/zcode-tui/src/work-duration-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("work duration view", () => {
  test("uses the Codex threshold and compact duration format", () => {
    expect(workedDurationLabel(60_000)).toBeUndefined();
    expect(workedDurationLabel(61_000)).toBe("Worked for 1m 01s");
    expect(workedDurationLabel(3_661_000)).toBe("Worked for 1h 01m 01s");
  });

  test("renders a width-safe settled-work divider", () => {
    const view = new WorkDurationView(125_000, createTheme(false));
    const lines = view.render(32);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Worked for 2m 05s");
    expect(lines[0]!.length).toBeLessThanOrEqual(32);
  });
});
