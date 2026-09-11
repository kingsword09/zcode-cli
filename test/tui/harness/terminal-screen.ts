import { Terminal as HeadlessTerminal } from "@xterm/headless";

export interface TerminalScreenSnapshot {
  buffer: "alternate" | "normal";
  cols: number;
  cursor: {
    x: number;
    y: number;
  };
  rows: number;
  text: string;
}

function linesText(lines: string[]): string {
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

export class TerminalScreen implements Disposable {
  readonly #terminal: HeadlessTerminal;
  #pendingWrite: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number, scrollback = 2_000) {
    this.#terminal = new HeadlessTerminal({
      allowProposedApi: true,
      cols,
      rows,
      scrollback
    });
  }

  write(data: string | Uint8Array): Promise<void> {
    const owned = typeof data === "string" ? data : Uint8Array.from(data);
    this.#pendingWrite = this.#pendingWrite.then(() => new Promise<void>((resolve) => {
      this.#terminal.write(owned, resolve);
    }));
    return this.#pendingWrite;
  }

  async settled(): Promise<void> {
    await this.#pendingWrite;
  }

  screenText(): string {
    const buffer = this.#terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.#terminal.rows; row += 1) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
    }
    return linesText(lines);
  }

  bufferText(): string {
    const buffer = this.#terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    return linesText(lines);
  }

  snapshot(): TerminalScreenSnapshot {
    const buffer = this.#terminal.buffer.active;
    return {
      buffer: buffer.type,
      cols: this.#terminal.cols,
      cursor: {
        x: buffer.cursorX,
        y: buffer.cursorY
      },
      rows: this.#terminal.rows,
      text: this.screenText()
    };
  }

  resize(cols: number, rows: number): void {
    this.#terminal.resize(cols, rows);
  }

  dispose(): void {
    this.#terminal.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
