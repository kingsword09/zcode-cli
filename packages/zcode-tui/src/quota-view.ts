import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { QuotaOverview, QuotaSlot } from "../../../src/quota.ts";
import type { ZCodeTheme } from "./theme.ts";

/**
 * `/quota` card: plan header + one bar per model slot the plan carries.
 *
 * Width-safe by contract: every component implements `render(width)` and
 * re-renders at the new size on resize/zoom; bars clamp to the viewport
 * (8–40 chars, the same formula `context-status-view.ts` uses) and every
 * line is truncated so nothing wraps or breaks. Renders whatever model
 * slots `billing/balance` returns — plans with one, two or many models
 * all work without hardcoded rows.
 */

const MAX_RENDERED_SLOTS = 8;
const BAR_MIN = 8;
const BAR_MAX = 40;

function formatUnits(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

function formatExpiry(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export class QuotaView implements Component {
  constructor(
    private readonly theme: ZCodeTheme,
    private readonly overview: QuotaOverview,
    private readonly updatedAt: string | undefined = undefined
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [];
    const plan = this.overview.plans[0];
    if (plan?.name) {
      const status = plan.status && plan.status !== "active" ? ` (${plan.status})` : "";
      lines.push(this.theme.accent(`${plan.name}${status}`));
    }
    const expiry = formatExpiry(plan?.endsAt);
    if (expiry) lines.push(this.theme.muted(`Expires ${expiry} · server clock`));
    if (plan?.name || expiry) lines.push("");

    const slots = this.overview.balances.slice(0, MAX_RENDERED_SLOTS);
    if (slots.length === 0) {
      lines.push(this.theme.muted("No plan balances on this account."));
      if (!plan) lines.push(this.theme.muted("Sign in with /login to use Start Plan and Coding Plan providers."));
    }

    for (const slot of slots) {
      lines.push(this.slotTitle(slot, safeWidth));
      lines.push(this.slotBar(slot, safeWidth));
      lines.push(this.theme.muted(this.slotDetail(slot)));
      lines.push("");
    }
    const hidden = this.overview.balances.length - slots.length;
    if (hidden > 0) lines.push(this.theme.muted(`+${hidden} more…`));

    const footnote = this.updatedAt
      ? `updated ${this.updatedAt} · billing/balance · /quota refreshes`
      : "billing/balance · /quota refreshes";
    lines.push(this.theme.muted(footnote));
    return lines.map(line => truncateToWidth(line, safeWidth, "…"));
  }

  invalidate(): void {}

  private slotTint(slot: QuotaSlot): (text: string) => string {
    const percentLeft = slot.percentLeft;
    if (percentLeft === undefined) return this.theme.muted;
    if (percentLeft <= 0) return this.theme.error;
    if (percentLeft <= 20) return this.theme.warning;
    return this.theme.accent;
  }

  private slotTitle(slot: QuotaSlot, safeWidth: number): string {
    const name = slot.name ?? "model";
    const tint = this.slotTint(slot);
    const percent = slot.percentLeft === undefined
      ? undefined
      : slot.percentLeft <= 0
        ? "exhausted"
        : `${Math.round(slot.percentLeft)}% left`;
    if (percent === undefined) return truncateToWidth(name, safeWidth, "…");
    const gap = Math.max(1, safeWidth - visibleWidth(name) - visibleWidth(percent) - 1);
    const padded = name + " ".repeat(Math.min(gap, 64)) + tint(percent);
    return truncateToWidth(padded, safeWidth, "…");
  }

  private slotBar(slot: QuotaSlot, safeWidth: number): string {
    const safe = Math.max(1, safeWidth);
    const barWidth = Math.max(BAR_MIN, Math.min(BAR_MAX, safe - 2));
    const total = slot.totalUnits;
    const remaining = slot.remainingUnits ?? 0;
    const filled = total && total > 0
      ? Math.max(0, Math.min(barWidth, Math.round((remaining / total) * barWidth)))
      : 0;
    const tint = this.slotTint(slot);
    const bar = tint("█".repeat(filled)) + this.theme.muted("░".repeat(Math.max(0, barWidth - filled)));
    return truncateToWidth(bar, safe, "…");
  }

  private slotDetail(slot: QuotaSlot): string {
    const reset = formatExpiry(slot.expiresAt);
    const exhausted = slot.remainingUnits !== undefined && slot.remainingUnits <= 0;
    const totals = `${formatUnits(slot.remainingUnits)} / ${formatUnits(slot.totalUnits)}`;
    if (exhausted) return `${totals} · exhausted`;
    return reset ? `${totals} · resets ${reset}` : totals;
  }
}
