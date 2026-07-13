import { asString, isRecord } from "./types.ts";

export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

export interface GoalState {
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
}

const statuses = new Set<GoalStatus>(["active", "paused", "budget_limited", "complete"]);

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function normalizeGoal(value: unknown): GoalState | undefined {
  if (!isRecord(value)) return undefined;
  const status = asString(value.status) as GoalStatus | undefined;
  const tokensUsed = nonNegativeNumber(value.tokensUsed);
  const timeUsedSeconds = nonNegativeNumber(value.timeUsedSeconds);
  const tokenBudget = value.tokenBudget === null ? null : nonNegativeNumber(value.tokenBudget);
  if (!status || !statuses.has(status) || tokensUsed === undefined || timeUsedSeconds === undefined) {
    return undefined;
  }
  if (tokenBudget === undefined) return undefined;
  return { status, tokenBudget, tokensUsed, timeUsedSeconds };
}

export function formatTokens(value: number): string {
  if (value < 1_000) return Math.floor(value).toString();
  if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return `${Number((value / 1_000_000).toFixed(1))}M`;
}

function formatGoalElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function goalStatusText(goal: GoalState | undefined): string | undefined {
  if (!goal) return undefined;
  const usage = goal.tokenBudget === null
    ? undefined
    : `${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)}`;
  if (goal.status === "active") return usage ? `Pursuing goal (${usage})` : "Pursuing goal";
  if (goal.status === "paused") return "Goal paused (/goal resume)";
  if (goal.status === "budget_limited") return usage ? `Goal unmet (${usage})` : "Goal abandoned";
  return goal.timeUsedSeconds > 0
    ? `Goal achieved (${formatGoalElapsed(goal.timeUsedSeconds)})`
    : "Goal achieved";
}
