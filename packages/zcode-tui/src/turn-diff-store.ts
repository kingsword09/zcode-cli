import type { FileDiffData } from "./file-diff-view.ts";

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
    this.current.tools.set(toolCallId, diffs);
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
}
