import type { FileDiffData } from "./file-diff-view.ts";
import {
  boundedFileDiffs,
  FILE_DIFF_RETENTION_LIMITS,
  fileDiffRetentionSize,
  type FileDiffRetentionLimits
} from "./file-diff-budget.ts";

export const MAX_RETAINED_TURN_DIFFS = 20;

export interface TurnDiffSnapshot {
  id: string;
  index: number;
  prompt?: string;
  files: FileDiffData[];
  additions: number;
  deletions: number;
}

interface TurnRecord {
  id: string;
  index: number;
  prompt?: string;
  tools: Map<string, FileDiffData[]>;
}

export class TurnDiffStore {
  private readonly turns: TurnRecord[] = [];
  private current?: TurnRecord;
  private nextIndex = 1;

  beginTurn(prompt?: string): void {
    this.finishTurn();
    this.current = {
      id: `turn_${crypto.randomUUID()}`,
      index: this.nextIndex,
      prompt: prompt?.trim() || undefined,
      tools: new Map()
    };
    this.nextIndex += 1;
    this.turns.push(this.current);
  }

  finishTurn(): void {
    if (!this.current) return;
    if (this.current.tools.size === 0) this.turns.pop();
    else if (this.turns.length > MAX_RETAINED_TURN_DIFFS) {
      this.turns.splice(0, this.turns.length - MAX_RETAINED_TURN_DIFFS);
    }
    this.current = undefined;
  }

  upsertTool(toolCallId: string, diffs: FileDiffData[]): void {
    if (!this.current || diffs.length === 0) return;
    this.current.tools.delete(toolCallId);
    this.current.tools.set(toolCallId, boundedFileDiffs(diffs));
    this.enforceCurrentBudget();
  }

  snapshots(): TurnDiffSnapshot[] {
    return this.turns.flatMap((turn): TurnDiffSnapshot[] => {
      const files = [...turn.tools.values()].flat();
      if (files.length === 0) return [];
      return [{
        id: turn.id,
        index: turn.index,
        prompt: turn.prompt,
        files,
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0)
      }];
    });
  }

  clear(): void {
    this.turns.length = 0;
    this.current = undefined;
    this.nextIndex = 1;
  }

  private enforceCurrentBudget(): void {
    if (!this.current) return;
    const retained: Array<[string, FileDiffData[]]> = [];
    const remaining: FileDiffRetentionLimits = { ...FILE_DIFF_RETENTION_LIMITS };
    let omitted = false;

    for (const [toolCallId, diffs] of [...this.current.tools.entries()].reverse()) {
      const bounded = boundedFileDiffs(diffs, remaining);
      if (bounded.length === 0) {
        omitted = true;
        continue;
      }
      const before = fileDiffRetentionSize(diffs);
      const after = fileDiffRetentionSize(bounded);
      if (after.files < before.files
        || after.lines < before.lines
        || after.characters < before.characters) {
        omitted = true;
      }
      remaining.files -= after.files;
      remaining.lines -= after.lines;
      remaining.characters -= after.characters;
      retained.push([toolCallId, bounded]);
    }

    retained.reverse();
    if (omitted && retained[0]?.[1][0]) {
      const [toolCallId, files] = retained[0];
      retained[0] = [toolCallId, [{ ...files[0]!, truncated: true }, ...files.slice(1)]];
    }
    this.current.tools.clear();
    for (const [toolCallId, diffs] of retained) this.current.tools.set(toolCallId, diffs);
  }
}
