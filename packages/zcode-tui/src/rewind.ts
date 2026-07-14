import { restoredMessages } from "./events.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import { asString, isRecord } from "./types.ts";

export type RewindScope = "conversation" | "workspace" | "both";

export interface RewindTarget {
  checkpointMessageIds: string[];
  messageId: string;
  text: string;
}

export interface FileRewindEntry {
  action?: string;
  operationCount?: number;
  path: string;
  reason?: string;
  toolNames: string[];
}

export interface FileRewindPreview {
  canApply: boolean;
  ignoredFiles: FileRewindEntry[];
  safeFiles: FileRewindEntry[];
  unsafeFiles: FileRewindEntry[];
}

function targetText(parts: ReturnType<typeof restoredMessages>[number]["parts"]): string {
  return sanitizeTerminalText(parts
    .map((part) => part.type === "text" || part.type === "file" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim(), { preserveSgr: false });
}

export function rewindTargets(value: unknown): RewindTarget[] {
  const messages = restoredMessages(value);
  return messages
    .flatMap((message, index): RewindTarget[] => {
      if (message.role !== "user" || !message.messageId) return [];
      const text = targetText(message.parts);
      const checkpointMessageIds = Array.from(new Set(
        messages.slice(index).flatMap((candidate) => candidate.messageId ? [candidate.messageId] : [])
      ));
      return text ? [{ checkpointMessageIds, messageId: message.messageId, text }] : [];
    })
    .reverse();
}

function rewindEntries(value: unknown): FileRewindEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): FileRewindEntry[] => {
    if (!isRecord(item)) return [];
    const rawPath = asString(item.path)?.trim();
    const path = rawPath ? sanitizeTerminalText(rawPath, { preserveSgr: false }) : undefined;
    if (!path) return [];
    const action = asString(item.action);
    const reason = asString(item.reason);
    return [{
      action: action ? sanitizeTerminalText(action, { preserveSgr: false }) : undefined,
      operationCount: typeof item.operationCount === "number" && Number.isFinite(item.operationCount)
        ? Math.max(0, Math.floor(item.operationCount))
        : undefined,
      path,
      reason: reason ? sanitizeTerminalText(reason, { preserveSgr: false }) : undefined,
      toolNames: Array.isArray(item.toolNames)
        ? item.toolNames
            .filter((tool): tool is string => typeof tool === "string")
            .map((tool) => sanitizeTerminalText(tool, { preserveSgr: false }))
        : []
    }];
  });
}

export function fileRewindPreview(value: unknown): FileRewindPreview {
  if (!isRecord(value)) {
    return { canApply: false, ignoredFiles: [], safeFiles: [], unsafeFiles: [] };
  }
  return {
    canApply: value.canApply === true,
    ignoredFiles: rewindEntries(value.ignoredFiles),
    safeFiles: rewindEntries(value.safeFiles),
    unsafeFiles: rewindEntries(value.unsafeFiles)
  };
}

export function rewindTargetLabel(text: string, maximum = 100): string {
  const normalized = sanitizeTerminalText(text, { preserveSgr: false }).replace(/\s+/gu, " ").trim();
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(normalized),
    (entry) => entry.segment
  );
  return graphemes.length <= maximum
    ? normalized
    : `${graphemes.slice(0, Math.max(1, maximum - 1)).join("")}…`;
}

export function rewindCommand(scope: "conversation", messageId: string): string {
  if (!messageId || /[\s\u0000-\u001f\u007f]/u.test(messageId)) {
    throw new Error("The selected conversation message has an invalid identifier.");
  }
  return `/rewind cascade ${scope} ${messageId}`;
}
