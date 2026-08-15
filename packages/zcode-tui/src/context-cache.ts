import { asString, isRecord } from "./types.ts";

export type ContextCacheTurnState = "hit" | "miss" | "unknown";

export interface ContextCacheTurn {
  index: number;
  messageId?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  hitRate?: number;
  state: ContextCacheTurnState;
  active: boolean;
}

export interface ContextCacheSummary {
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  hitRate?: number;
  latestHitRate?: number;
  minHitRate?: number;
  maxHitRate?: number;
}

export interface ContextCacheTrend {
  turns: ContextCacheTurn[];
  active: ContextCacheSummary;
  wholeTree: ContextCacheSummary;
}

export function findActiveBranchMessageIds(value: unknown): ReadonlySet<string> | undefined {
  const messages = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.messages) ? value.messages : [];
  const byId = new Map<string, Record<string, unknown>>();
  const ids: string[] = [];
  for (const item of messages) {
    if (!isRecord(item)) continue;
    const info = isRecord(item.info) ? item.info : item;
    const id = recordString(info, "id", "messageId", "messageID")
      ?? recordString(item, "id", "messageId", "messageID");
    if (!id) continue;
    byId.set(id, info);
    ids.push(id);
  }
  const latest = ids.at(-1);
  if (!latest) return undefined;
  const active = new Set<string>();
  let current: string | undefined = latest;
  let followedParent = false;
  while (current && !active.has(current)) {
    active.add(current);
    const info = byId.get(current);
    const parent = info ? recordString(info, "parentID", "parentId", "parentMessageId") : undefined;
    followedParent ||= parent !== undefined;
    current = parent;
  }
  // Older stores do not persist parent links. In that case all records are the
  // only honest representation of the active branch.
  return followedParent || byId.size <= 1 ? active : new Set(ids);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function recordString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = asString(value[key])?.trim();
    if (candidate) return candidate;
  }
  return undefined;
}

function tokenValue(value: unknown, ...keys: string[]): number {
  if (!isRecord(value)) return 0;
  for (const key of keys) {
    const candidate = nonNegativeInteger(value[key]);
    if (candidate !== undefined) return candidate;
  }
  return 0;
}

interface TokenUsage {
  input: number;
  read: number;
  write: number;
}

function messageTokens(info: Record<string, unknown>, parts: unknown): TokenUsage {
  const raw = isRecord(info.tokens) ? info.tokens : undefined;
  let usage: TokenUsage = {
    input: tokenValue(raw, "input"),
    read: isRecord(raw?.cache) ? tokenValue(raw.cache, "read") : 0,
    write: isRecord(raw?.cache) ? tokenValue(raw.cache, "write") : 0
  };

  // Some runtime versions persist token counts on the step-finish part only.
  if (usage.input > 0 || usage.read > 0 || usage.write > 0 || !Array.isArray(parts)) return usage;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!isRecord(part) || asString(part.type) !== "step-finish" || !isRecord(part.tokens)) continue;
    const tokens = part.tokens;
    const candidate = {
      input: tokenValue(tokens, "input"),
      read: isRecord(tokens.cache) ? tokenValue(tokens.cache, "read") : 0,
      write: isRecord(tokens.cache) ? tokenValue(tokens.cache, "write") : 0
    };
    if (candidate.input > 0 || candidate.read > 0 || candidate.write > 0) {
      usage = candidate;
      break;
    }
  }
  return usage;
}

function summary(turns: ContextCacheTurn[]): ContextCacheSummary {
  let requests = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const rates: number[] = [];
  for (const turn of turns) {
    const input = turn.inputTokens ?? 0;
    const read = turn.cacheReadTokens ?? 0;
    const write = turn.cacheWriteTokens ?? 0;
    if (input <= 0 && read <= 0 && write <= 0) continue;
    requests += 1;
    inputTokens += input;
    cacheReadTokens += read;
    cacheWriteTokens += write;
    if (turn.hitRate !== undefined) rates.push(turn.hitRate);
  }
  const aggregateRate = inputTokens > 0 ? Math.max(0, Math.min(1, cacheReadTokens / inputTokens)) : undefined;
  return {
    requests,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    hitRate: aggregateRate,
    latestHitRate: rates.at(-1),
    minHitRate: rates.length > 0 ? Math.min(...rates) : undefined,
    maxHitRate: rates.length > 0 ? Math.max(...rates) : undefined
  };
}

/**
 * Extracts request-level cache usage from raw session messages. Unknown token
 * records remain in the trend so a runtime restart is rendered as a gap rather
 * than an invented smooth line.
 */
export function extractContextCacheTrend(
  value: unknown,
  activeMessageIds?: ReadonlySet<string>
): ContextCacheTrend {
  const messages = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.messages) ? value.messages : [];
  const assistantMessages = messages.filter((item): item is Record<string, unknown> => {
    if (!isRecord(item)) return false;
    const info = isRecord(item.info) ? item.info : item;
    return asString(info.role) === "assistant" && !info.summary;
  });
  const hasActiveFilter = Boolean(activeMessageIds && activeMessageIds.size > 0);
  const turns = assistantMessages.map((item, index): ContextCacheTurn => {
    const info = isRecord(item.info) ? item.info : item;
    const usage = messageTokens(info, item.parts);
    const input = usage.input > 0 ? usage.input : undefined;
    const read = usage.read > 0 ? usage.read : usage.input > 0 ? 0 : undefined;
    const write = usage.write > 0 ? usage.write : usage.input > 0 ? 0 : undefined;
    const id = recordString(info, "id", "messageId", "messageID")
      ?? recordString(item, "id", "messageId", "messageID");
    const active = !hasActiveFilter || (id !== undefined && activeMessageIds!.has(id));
    const hitRate = input !== undefined ? Math.max(0, Math.min(1, usage.read / input)) : undefined;
    return {
      index: index + 1,
      messageId: id,
      inputTokens: input,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      hitRate,
      state: input === undefined ? "unknown" : usage.read > 0 ? "hit" : "miss",
      active
    };
  });
  const active = summary(turns.filter((turn) => turn.active));
  const wholeTree = summary(turns);
  return {
    turns,
    active,
    wholeTree
  };
}
