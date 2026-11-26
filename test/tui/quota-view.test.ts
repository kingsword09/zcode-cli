import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuotaView } from "../../packages/zcode-tui/src/quota-view.ts";
import type { QuotaOverview } from "../../src/quota.ts";

// Minimal theme stub: tints are identity transforms so assertions stay text-based.
const theme = {
  accent: (text: string) => text,
  muted: (text: string) => text,
  warning: (text: string) => text,
  error: (text: string) => text
};

function overviewFixture(): QuotaOverview {
  return {
    serverTime: 1795285880,
    plans: [{ planId: "p1", name: "ZCODE WEEKEND BUILD", status: "active", startsAt: 1, endsAt: 1795395600 }],
    balances: [
      { name: "GLM-5.3-Flash", meter: "model_usage", totalUnits: 500000000, usedUnits: 200179, remainingUnits: 499799821, availableUnits: 499799821, percentLeft: 99.96, expiresAt: 1795395600 },
      { name: "GLM-5.3", meter: "model_usage", totalUnits: 200000000, usedUnits: 200000000, remainingUnits: 0, availableUnits: 0, percentLeft: 0, expiresAt: 1795395600 }
    ]
  };
}

test("quota view renders plan header, per-model bars and stays within width", () => {
  const overview = overviewFixture();
  // No overflow at any width (pi-tui re-renders at the new size on resize/zoom).
  for (const width of [200, 120, 80, 40, 20, 10, 1]) {
    const lines = new QuotaView(theme as never, overview, "21:47:03").render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  }
  // Full content survives at usable widths (truncation only bites when narrow).
  for (const width of [200, 120, 80]) {
    const joined = new QuotaView(theme as never, overview, "21:47:03").render(width).join("\n");
    expect(joined).toContain("ZCODE WEEKEND BUILD");
    expect(joined).toContain("GLM-5.3-Flash");
    expect(joined).toContain("GLM-5.3");
    expect(joined).toContain("exhausted");
  }
});

test("quota view renders the empty state without plan or balances", () => {
  const empty: QuotaOverview = { serverTime: undefined, plans: [], balances: [] };
  const lines = new QuotaView(theme as never, empty).render(80);
  expect(lines.join("\n")).toContain("No plan balances");
  expect(lines.join("\n")).toContain("/login");
});
