import type { FileDiffData } from "./file-diff-view.ts";

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

  beginTurn(prompt?: string): void {
    this.current = {
      id: `turn_${crypto.randomUUID()}`,
      index: this.turns.length + 1,
      prompt: prompt?.trim() || undefined,
      tools: new Map()
    };
    this.turns.push(this.current);
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
  }
}
