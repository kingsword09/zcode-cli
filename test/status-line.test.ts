import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { StatusLine } from "../packages/zcode-tui/src/status-line.ts";

const fields = [
  { text: "alpha/model", priority: 100, required: true },
  { text: "build", priority: 70 },
  { text: "max", priority: 60 },
  { text: "75% context left", compactText: "ctx 75%", priority: 90 },
  { text: "18.4K tokens", compactText: "18.4K tok", priority: 20 }
];

describe("TUI status line", () => {
  test("shows all session metadata when space is available", () => {
    const status = new StatusLine();
    status.setFields(fields);
    const [line] = status.render(80);
    expect(line).toContain("alpha/model · build · max · 75% context left · 18.4K tokens");
    expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(80);
  });

  test("keeps model and context while dropping lower-priority fields", () => {
    const status = new StatusLine();
    status.setFields(fields);
    const [line] = status.render(22);
    expect(line).toBe(" alpha/model · ctx 75%");
    expect(line).not.toContain("tokens");
    expect(line).not.toContain("build");
    expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(22);
  });
});
