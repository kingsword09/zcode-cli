import {
  truncateToWidth,
  type Component
} from "@earendil-works/pi-tui";

import {
  isExpandableComponent,
  isSearchableComponent
} from "./renderable.ts";

const renderWindowSize = 240;
const renderWindowStep = 60;

export interface TranscriptBlockOptions {
  id?: string;
  kind?: string;
  messageId?: string;
  searchText?: string | (() => string);
}

interface TranscriptBlock {
  id: string;
  kind: string;
  messageId?: string;
  component: Component;
  searchText?: string | (() => string);
}

export interface TranscriptSearchStatus {
  query: string;
  current: number;
  total: number;
}

export interface TranscriptCursorStatus {
  current: number;
  total: number;
  kind: string;
}

interface SearchState {
  query: string;
  matches: number[];
  cursor: number;
}

export class Transcript implements Component {
  private readonly blocks: TranscriptBlock[] = [];
  private expanded = false;
  private windowStart = 0;
  private search?: SearchState;
  private cursor?: number;
  private page = 0;
  private navigationViewportRows = 20;

  constructor(private readonly highlightMatch: (text: string) => string = (text) => text) {}

  addBlock(component: Component, options: TranscriptBlockOptions = {}): string {
    const id = options.id ?? `block_${crypto.randomUUID()}`;
    if (isExpandableComponent(component)) component.setExpanded(this.expanded);
    const existing = this.blocks.find((block) => block.id === id);
    if (existing) {
      existing.component = component;
      existing.kind = options.kind ?? existing.kind;
      existing.messageId = options.messageId ?? existing.messageId;
      existing.searchText = options.searchText ?? existing.searchText;
      this.refreshSearch();
      return id;
    }
    this.blocks.push({
      id,
      kind: options.kind ?? "content",
      messageId: options.messageId,
      component,
      searchText: options.searchText
    });
    this.advanceWindow();
    this.refreshSearch();
    return id;
  }

  removeBlock(id: string): boolean {
    const index = this.blocks.findIndex((block) => block.id === id);
    if (index < 0) return false;
    this.blocks.splice(index, 1);
    if (this.cursor !== undefined) {
      if (this.blocks.length === 0) this.cursor = undefined;
      else if (index < this.cursor) this.cursor -= 1;
      else this.cursor = Math.min(this.cursor, this.blocks.length - 1);
    }
    if (index < this.windowStart) this.windowStart = Math.max(0, this.windowStart - 1);
    this.windowStart = Math.min(this.windowStart, Math.max(0, this.blocks.length - 1));
    this.refreshSearch();
    return true;
  }

  removeMessage(messageId: string): number {
    let removed = 0;
    for (let index = this.blocks.length - 1; index >= 0; index -= 1) {
      if (this.blocks[index]?.messageId !== messageId) continue;
      this.blocks.splice(index, 1);
      removed += 1;
      if (index < this.windowStart) this.windowStart = Math.max(0, this.windowStart - 1);
    }
    if (removed > 0) {
      this.windowStart = Math.min(this.windowStart, Math.max(0, this.blocks.length - 1));
      this.refreshSearch();
    }
    return removed;
  }

  associateBlockWithMessage(id: string, messageId: string): void {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (block) block.messageId = messageId;
  }

  clear(): void {
    this.blocks.length = 0;
    this.windowStart = 0;
    this.search = undefined;
    this.cursor = undefined;
  }

  invalidate(): void {
    for (const block of this.blocks) block.component.invalidate();
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    for (const block of this.blocks) {
      if (isExpandableComponent(block.component)) block.component.setExpanded(expanded);
    }
  }

  toggleExpanded(): boolean {
    this.setExpanded(!this.expanded);
    return this.expanded;
  }

  toggleFocusedExpanded(): boolean | undefined {
    const index = this.focusedBlockIndex();
    if (index === undefined) return undefined;
    const component = this.blocks[index]?.component;
    if (!component || !isExpandableComponent(component)) return false;
    component.setExpanded(!component.isExpanded());
    this.page = 0;
    return component.isExpanded();
  }

  moveCursor(direction: 1 | -1): TranscriptCursorStatus | undefined {
    if (this.blocks.length === 0) return undefined;
    if (this.search) this.clearSearch();
    if (this.cursor === undefined) this.cursor = this.blocks.length - 1;
    else this.cursor = Math.max(0, Math.min(this.blocks.length - 1, this.cursor + direction));
    this.page = 0;
    return this.cursorStatus();
  }

  selectLatest(): TranscriptCursorStatus | undefined {
    if (this.blocks.length === 0) return undefined;
    this.clearSearch();
    this.cursor = this.blocks.length - 1;
    this.page = 0;
    return this.cursorStatus();
  }

  clearCursor(): void {
    this.cursor = undefined;
    this.page = 0;
  }

  setNavigationViewportRows(rows: number): void {
    this.navigationViewportRows = Math.max(4, Math.floor(rows));
  }

  movePage(direction: 1 | -1, width: number): { current: number; total: number } | undefined {
    const index = this.focusedBlockIndex();
    const block = index === undefined ? undefined : this.blocks[index];
    if (!block) return undefined;
    const lineCount = block.component.render(Math.max(1, width - 2)).length;
    const total = Math.max(1, Math.ceil(lineCount / this.navigationViewportRows));
    this.page = Math.max(0, Math.min(total - 1, this.page + direction));
    return { current: this.page + 1, total };
  }

  cursorStatus(): TranscriptCursorStatus | undefined {
    if (this.cursor === undefined) return undefined;
    const block = this.blocks[this.cursor];
    return block ? { current: this.cursor + 1, total: this.blocks.length, kind: block.kind } : undefined;
  }

  selectedText(): string | undefined {
    const index = this.focusedBlockIndex();
    const block = index === undefined ? undefined : this.blocks[index];
    if (!block) return undefined;
    const text = this.blockSearchText(block).trim();
    return text || undefined;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  searchFor(query: string): TranscriptSearchStatus | undefined {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) {
      this.clearSearch();
      return undefined;
    }
    const matches = this.matchingBlocks(normalized);
    this.cursor = undefined;
    this.page = 0;
    this.search = { query: query.trim(), matches, cursor: 0 };
    return this.searchStatus();
  }

  nextSearchMatch(direction: 1 | -1): TranscriptSearchStatus | undefined {
    if (!this.search || this.search.matches.length === 0) return this.searchStatus();
    const total = this.search.matches.length;
    this.search.cursor = (this.search.cursor + direction + total) % total;
    this.page = 0;
    return this.searchStatus();
  }

  clearSearch(): void {
    this.search = undefined;
    this.page = 0;
  }

  searchStatus(): TranscriptSearchStatus | undefined {
    if (!this.search) return undefined;
    return {
      query: this.search.query,
      current: this.search.matches.length > 0 ? this.search.cursor + 1 : 0,
      total: this.search.matches.length
    };
  }

  get blockCount(): number {
    return this.blocks.length;
  }

  render(width: number): string[] {
    const selection = this.visibleSelection();
    const headers = [selection.sticky, selection.header].filter((line): line is string => Boolean(line));
    if (selection.blocks.length === 0) {
      return headers.length > 0 ? [...headers.map((line) => truncateToWidth(line, width)), ""] : [];
    }

    const lines: string[] = [];
    if (headers.length > 0) lines.push(...headers.map((line) => truncateToWidth(line, width)), "");
    for (const [visibleIndex, block] of selection.blocks.entries()) {
      if (visibleIndex > 0) lines.push("");
      const absoluteIndex = selection.startIndex + visibleIndex;
      const focused = absoluteIndex === this.focusedBlockIndex();
      let rendered = block.component.render(focused ? Math.max(1, width - 2) : width);
      if (focused && (this.cursor !== undefined || this.search)) {
        const pages = Math.max(1, Math.ceil(rendered.length / this.navigationViewportRows));
        this.page = Math.min(this.page, pages - 1);
        if (pages > 1) {
          lines.push(truncateToWidth(`── Page ${this.page + 1}/${pages} · PageUp/PageDown scroll ──`, width));
        }
        const start = this.page * this.navigationViewportRows;
        rendered = rendered.slice(start, start + this.navigationViewportRows);
      }
      const decorated = focused
        ? rendered.map((line, lineIndex) => `${lineIndex === 0 ? "› " : "  "}${line}`)
        : rendered;
      lines.push(...(selection.query
        ? decorated.map((line) => highlightMatches(line, selection.query!, this.highlightMatch))
        : decorated));
    }
    return lines.length > 0 ? [...lines, ""] : lines;
  }

  private visibleSelection(): {
    blocks: TranscriptBlock[];
    startIndex: number;
    header?: string;
    sticky?: string;
    query?: string;
  } {
    if (this.search) {
      if (this.search.matches.length === 0) {
        return {
          blocks: [],
          startIndex: 0,
          header: `── No transcript matches for ${JSON.stringify(this.search.query)} · /search clear ──`
        };
      }
      const blockIndex = this.search.matches[this.search.cursor] ?? 0;
      const start = blockIndex;
      const end = blockIndex + 1;
      return {
        blocks: this.blocks.slice(start, end),
        startIndex: start,
        query: this.search.query,
        header: `── Search ${this.search.cursor + 1}/${this.search.matches.length}: ${this.search.query} · n/N next/prev · Esc close ──`
      };
    }

    if (this.cursor !== undefined) {
      const start = this.cursor;
      const end = this.cursor + 1;
      const sticky = this.stickyPrompt(start);
      return {
        blocks: this.blocks.slice(start, end),
        startIndex: start,
        sticky: sticky ? `── Prompt: ${sticky} ──` : undefined,
        header: `── Transcript ${this.cursor + 1}/${this.blocks.length} · Alt+Up/Down navigate · Ctrl+O expand · Esc close ──`
      };
    }

    const hidden = this.windowStart;
    return {
      blocks: this.blocks.slice(this.windowStart),
      startIndex: this.windowStart,
      ...(hidden > 0
        ? { header: `── ${hidden} earlier blocks remain searchable · /search <text> ──` }
        : {})
    };
  }

  private focusedBlockIndex(): number | undefined {
    if (this.search?.matches.length) return this.search.matches[this.search.cursor];
    return this.cursor;
  }

  private stickyPrompt(before: number): string | undefined {
    for (let index = before - 1; index >= 0; index -= 1) {
      const block = this.blocks[index];
      if (block?.kind !== "user") continue;
      const text = this.blockSearchText(block).replace(/\s+/gu, " ").trim();
      return text.length > 120 ? `${text.slice(0, 119)}…` : text;
    }
    return undefined;
  }

  private matchingBlocks(query: string): number[] {
    const matches: number[] = [];
    for (const [index, block] of this.blocks.entries()) {
      const text = this.blockSearchText(block).toLocaleLowerCase();
      if (text.includes(query)) matches.push(index);
    }
    return matches;
  }

  private blockSearchText(block: TranscriptBlock): string {
    if (typeof block.searchText === "function") return block.searchText();
    if (typeof block.searchText === "string") return block.searchText;
    return isSearchableComponent(block.component) ? block.component.getSearchText() : "";
  }

  private refreshSearch(): void {
    if (!this.search) return;
    const previousBlock = this.search.matches[this.search.cursor];
    this.search.matches = this.matchingBlocks(this.search.query.toLocaleLowerCase());
    const nextCursor = previousBlock === undefined ? -1 : this.search.matches.indexOf(previousBlock);
    this.search.cursor = nextCursor >= 0
      ? nextCursor
      : Math.min(this.search.cursor, Math.max(0, this.search.matches.length - 1));
  }

  private advanceWindow(): void {
    if (this.blocks.length - this.windowStart <= renderWindowSize + renderWindowStep) return;
    this.windowStart = Math.max(0, this.blocks.length - renderWindowSize);
  }
}

function highlightMatches(line: string, query: string, style: (text: string) => string): string {
  const needle = query.toLocaleLowerCase();
  if (!needle) return line;
  const lower = line.toLocaleLowerCase();
  let cursor = 0;
  let output = "";
  while (cursor < line.length) {
    const index = lower.indexOf(needle, cursor);
    if (index < 0) return output + line.slice(cursor);
    output += line.slice(cursor, index);
    output += style(line.slice(index, index + query.length));
    cursor = index + query.length;
  }
  return output;
}
