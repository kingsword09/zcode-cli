import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { StatusLine } from "../packages/zcode-tui/src/status-line.ts";

const fields = [
  { text: "◈ alpha/model", priority: 100, required: true },
  { text: "◉ build", priority: 70 },
  { text: "⚡ max", priority: 60 },
  { text: "ctx 75% left", compactText: "ctx 75%", priority: 90 },
  { text: "18.4K tokens", compactText: "18.4K tok", priority: 20 }
];

describe("TUI status line", () => {
  test("shows all session metadata when space is available", () => {
    const status = new StatusLine();
    status.setFields(fields, " ─ ");
    const [compactLine] = status.render(60);
    const [fullLine] = status.render(80);
    expect(compactLine).toContain("◈ alpha/model ─ ◉ build ─ ⚡ max ─ ctx 75% ─ 18.4K tok");
    expect(fullLine).toContain("◈ alpha/model ─ ◉ build ─ ⚡ max ─ ctx 75% left ─ 18.4K tokens");
    expect(visibleWidth(compactLine ?? "")).toBeLessThanOrEqual(60);
    expect(visibleWidth(fullLine ?? "")).toBeLessThanOrEqual(80);
  });

  test("keeps model and context while dropping lower-priority fields", () => {
    const status = new StatusLine();
    status.setFields(fields, " ─ ");
    const [line] = status.render(24);
    expect(line).toBe(" ◈ alpha/model ─ ctx 75%");
    expect(line).not.toContain("tokens");
    expect(line).not.toContain("build");
    expect(visibleWidth(line ?? "")).toBeLessThanOrEqual(24);
  });
});
