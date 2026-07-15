import {
  truncateToWidth,
  type Component
} from "@earendil-works/pi-tui";

import { FileDiffView, type FileDiffData } from "./file-diff-view.ts";
import { truncateGraphemes } from "./terminal-text.ts";
import type { ZCodeTheme } from "./theme.ts";
import type { TurnDiffSnapshot } from "./turn-diff-store.ts";
import type { WorkspaceDiffSnapshot } from "./workspace-diff.ts";

export interface DiffBrowserSource {
  id: string;
  label: string;
  description: string;
  files: FileDiffData[];
}

function totals(files: FileDiffData[]): { additions: number; deletions: number } {
  return {
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0)
  };
}

function oneLine(value: string, maximum = 72): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return truncateGraphemes(compact, maximum);
}

export function diffBrowserSources(
  workspace: WorkspaceDiffSnapshot,
  turns: TurnDiffSnapshot[]
): DiffBrowserSource[] {
  const currentTotals = totals(workspace.files);
  return [{
    id: "current",
    label: "Current changes",
    description: workspace.error
      ? workspace.error
      : `${workspace.files.length} files · +${currentTotals.additions} -${currentTotals.deletions}${workspace.truncated ? " · truncated" : ""}`,
    files: workspace.files
  }, ...turns.slice().reverse().map((turn) => ({
    id: turn.id,
    label: `Turn ${turn.index}`,
    description: `${turn.files.length} files · +${turn.additions} -${turn.deletions}${turn.prompt ? ` · ${oneLine(turn.prompt)}` : ""}`,
    files: turn.files
  }))];
}

export function diffFileDescription(file: FileDiffData): string {
  const status = file.isBinary ? "binary"
    : file.isLargeFile ? "large"
      : file.status;
  return [status, `+${file.additions}`, `-${file.deletions}`, file.truncated ? "truncated" : undefined]
    .filter(Boolean)
    .join(" · ");
}

export class DiffDetailPage implements Component {
  constructor(
    private readonly theme: ZCodeTheme,
    private readonly file: FileDiffData,
    private readonly page: number,
    private readonly pageSize: number
  ) {}

  invalidate(): void {}

  pageCount(width: number): number {
    return Math.max(1, Math.ceil(this.allLines(width).length / this.pageSize));
  }

  render(width: number): string[] {
    const lines = this.allLines(width);
    const pages = Math.max(1, Math.ceil(lines.length / this.pageSize));
    const page = Math.max(0, Math.min(this.page, pages - 1));
    const start = page * this.pageSize;
    return [
      ...lines.slice(start, start + this.pageSize),
      truncateToWidth(this.theme.muted(`Page ${page + 1}/${pages}`), width)
    ];
  }

  private allLines(width: number): string[] {
    return new FileDiffView(this.theme, {
      toolName: "Diff",
      state: "complete",
      diffs: [this.file],
      expanded: true
    }).render(width);
  }
}
