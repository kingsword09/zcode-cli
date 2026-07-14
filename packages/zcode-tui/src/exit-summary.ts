import type { SessionMetrics } from "./session-status.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import { formatElapsed } from "./turn-status.ts";

export interface ExitSummary {
  divider?: string;
  tokenUsage?: string;
  resumeCommand?: string;
}

export interface ExitSummaryOptions {
  elapsedMilliseconds: number;
  metrics: SessionMetrics;
  sessionId?: string;
  width: number;
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function formattedInteger(value: number): string {
  return numberFormat.format(Math.max(0, Math.floor(value)));
}

function workedDivider(elapsedMilliseconds: number, width: number): string | undefined {
  if (Math.floor(elapsedMilliseconds / 1_000) <= 60) return undefined;
  const available = Math.max(1, Math.floor(width));
  const label = `─ Worked for ${formatElapsed(elapsedMilliseconds)} ─`;
  if (label.length >= available) return label.slice(0, available);
  return `${label}${"─".repeat(available - label.length)}`;
}

export function formatTokenUsage(metrics: SessionMetrics): string | undefined {
  if (metrics.totalTokens === undefined || metrics.totalTokens <= 0) return undefined;

  const cached = (metrics.cacheCreationTokens ?? 0) + (metrics.cacheReadTokens ?? 0);
  const total = Math.max(0, metrics.totalTokens - cached);
  const input = metrics.inputTokens === undefined
    ? undefined
    : Math.max(0, metrics.inputTokens - cached);
  const sections = [`Token usage: total=${formattedInteger(total)}`];

  if (input !== undefined) {
    sections.push(`input=${formattedInteger(input)}${cached > 0 ? ` (+ ${formattedInteger(cached)} cached)` : ""}`);
  }
  if (metrics.outputTokens !== undefined) {
    const reasoning = metrics.reasoningTokens && metrics.reasoningTokens > 0
      ? ` (reasoning ${formattedInteger(metrics.reasoningTokens)})`
      : "";
    sections.push(`output=${formattedInteger(metrics.outputTokens)}${reasoning}`);
  }
  return sections.join(" ");
}

export function resumeCommand(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  const rawTarget = sessionId.trim();
  const target = sanitizeTerminalText(rawTarget, { preserveSgr: false });
  if (!target || target !== rawTarget || target.length > 512 || /[\u0000-\u001f\u007f]/u.test(target)) return undefined;
  if (/^[A-Za-z0-9_./:@%+,=-]+$/u.test(target) && !target.startsWith("-")) {
    return `zcode --resume ${target}`;
  }
  return `zcode --resume='${target.replaceAll("'", "'\"'\"'")}'`;
}

export function buildExitSummary(options: ExitSummaryOptions): ExitSummary {
  return {
    divider: workedDivider(options.elapsedMilliseconds, options.width),
    tokenUsage: formatTokenUsage(options.metrics),
    resumeCommand: resumeCommand(options.sessionId)
  };
}
