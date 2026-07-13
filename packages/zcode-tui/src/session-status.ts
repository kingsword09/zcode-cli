import { isRecord } from "./types.ts";

export interface SessionMetrics {
  contextUsed?: number;
  contextWindow?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  modelRequestCount?: number;
  modelErrorCount?: number;
  turnCount?: number;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export function projectionMetrics(value: unknown): SessionMetrics | undefined {
  if (!isRecord(value)) return undefined;
  const metrics: SessionMetrics = {
    contextUsed: nonNegativeNumber(value.contextUsed),
    contextWindow: nonNegativeNumber(value.contextWindow),
    totalTokens: nonNegativeNumber(value.totalTokenCount),
    turnCount: nonNegativeNumber(value.turnCount)
  };
  return Object.values(metrics).some((metric) => metric !== undefined) ? metrics : undefined;
}

export function usageMetrics(value: unknown): SessionMetrics | undefined {
  if (!isRecord(value)) return undefined;
  const metrics: SessionMetrics = {
    totalTokens: nonNegativeNumber(value.totalTokens),
    inputTokens: nonNegativeNumber(value.inputTokens),
    outputTokens: nonNegativeNumber(value.outputTokens),
    reasoningTokens: nonNegativeNumber(value.reasoningTokens),
    cacheCreationTokens: nonNegativeNumber(value.cacheCreationTokens),
    cacheReadTokens: nonNegativeNumber(value.cacheReadTokens),
    modelRequestCount: nonNegativeNumber(value.modelRequestCount),
    modelErrorCount: nonNegativeNumber(value.modelErrorCount)
  };
  return Object.values(metrics).some((metric) => metric !== undefined) ? metrics : undefined;
}

export function mergeMetrics(current: SessionMetrics, update: SessionMetrics | undefined): SessionMetrics {
  return update ? { ...current, ...update } : current;
}

export function contextRemainingPercent(metrics: SessionMetrics): number | undefined {
  if (metrics.contextUsed === undefined || !metrics.contextWindow) return undefined;
  return Math.max(0, Math.min(100, Math.round((1 - metrics.contextUsed / metrics.contextWindow) * 100)));
}
