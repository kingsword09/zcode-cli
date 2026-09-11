import { ScenarioJournal } from "./scenario-journal.ts";
import type { ScenarioWorkspace } from "./scenario-workspace.ts";
import { TerminalScreen, type TerminalScreenSnapshot } from "./terminal-screen.ts";

const defaultWaitMilliseconds = 8_000;
const renderSettleMilliseconds = 30;

function terminalPlainText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

export interface TerminalSessionOptions {
  command: string[];
  workspace: ScenarioWorkspace;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  timeoutMilliseconds?: number;
}

export class TerminalSession implements AsyncDisposable {
  readonly journal: ScenarioJournal;
  readonly #terminal: Bun.Terminal;
  readonly #child: Bun.Subprocess;
  readonly #timeout: ReturnType<typeof setTimeout>;
  readonly #decoder = new TextDecoder();
  readonly #screen: TerminalScreen;
  #historyOutput = "";
  #screenError: unknown;
  #closed = false;

  private constructor(
    terminal: Bun.Terminal,
    child: Bun.Subprocess,
    timeout: ReturnType<typeof setTimeout>,
    journal: ScenarioJournal,
    screen: TerminalScreen
  ) {
    this.#terminal = terminal;
    this.#child = child;
    this.#timeout = timeout;
    this.journal = journal;
    this.#screen = screen;
  }

  static start(options: TerminalSessionOptions): TerminalSession {
    const cols = options.cols ?? 110;
    const rows = options.rows ?? 40;
    const pendingOutput: Uint8Array[] = [];
    let session: TerminalSession | undefined;
    const terminal = new Bun.Terminal({
      cols,
      rows,
      name: "xterm-256color",
      data(_terminal, data) {
        const owned = Uint8Array.from(data);
        if (session) session.consumeOutput(owned);
        else pendingOutput.push(owned);
      }
    });
    const child = Bun.spawn(options.command, {
      cwd: options.workspace.directory,
      env: {
        ...process.env,
        ...options.workspace.environment(),
        ...options.env,
        CI: "1",
        TERM: "xterm-256color",
        ZCODE_DISABLE_UPDATE_CHECK: "1",
        ZCODE_TUI_MODE: "regular"
      },
      terminal
    });
    const timeout = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMilliseconds ?? 20_000
    );
    session = new TerminalSession(
      terminal,
      child,
      timeout,
      options.workspace.journal,
      new TerminalScreen(cols, rows)
    );
    for (const data of pendingOutput) session.consumeOutput(data);
    session.journal.record("terminal.start", { command: options.command, pid: child.pid });
    return session;
  }

  private consumeOutput(data: Uint8Array): void {
    this.#historyOutput += this.#decoder.decode(data, { stream: true });
    void this.#screen.write(data).catch((error) => {
      this.#screenError ??= error;
    });
  }

  historyCheckpoint(): number {
    return this.#historyOutput.length;
  }

  historyText(start = 0): string {
    return terminalPlainText(this.#historyOutput.slice(start));
  }

  screenText(): string {
    this.throwScreenError();
    return this.#screen.screenText();
  }

  screenSnapshot(): TerminalScreenSnapshot {
    this.throwScreenError();
    return this.#screen.snapshot();
  }

  private throwScreenError(): void {
    if (this.#screenError) throw new Error("Headless terminal failed to parse PTY output.", { cause: this.#screenError });
  }

  send(input: string): void {
    this.journal.record("terminal.input", { input: JSON.stringify(input) });
    this.#terminal.write(input);
  }

  resize(cols: number, rows: number): void {
    this.#screen.resize(cols, rows);
    this.#terminal.resize(cols, rows);
    this.journal.record("terminal.resize", { cols, rows });
  }

  async settle(): Promise<void> {
    await Bun.sleep(renderSettleMilliseconds);
    await this.#screen.settled();
    this.throwScreenError();
  }

  async waitForScreen(
    label: string,
    pattern: RegExp,
    timeoutMilliseconds = defaultWaitMilliseconds
  ): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      await this.#screen.settled();
      this.throwScreenError();
      pattern.lastIndex = 0;
      if (pattern.test(this.screenText())) {
        this.journal.record("assert.screen.match", { label, pattern: String(pattern) });
        return;
      }
      if (this.#child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    throw this.waitError(label, pattern, "screen");
  }

  async waitForHistory(
    label: string,
    pattern: RegExp,
    start = 0,
    timeoutMilliseconds = defaultWaitMilliseconds
  ): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      pattern.lastIndex = 0;
      if (pattern.test(this.historyText(start))) {
        this.journal.record("assert.history.match", { label, pattern: String(pattern) });
        return;
      }
      if (this.#child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    throw this.waitError(label, pattern, "history");
  }

  private waitError(label: string, pattern: RegExp, target: "history" | "screen"): Error {
    return new Error([
      `Timed out waiting for ${label} in terminal ${target} (${String(pattern)}).`,
      "",
      "Current screen:",
      this.screenText(),
      "",
      "Terminal history:",
      this.historyText().slice(-6_000),
      "",
      "Scenario journal:",
      this.journal.format()
    ].join("\n"));
  }

  async sendAndWait(
    input: string,
    label: string,
    pattern: RegExp,
    timeoutMilliseconds?: number
  ): Promise<void> {
    this.send(input);
    await this.waitForScreen(label, pattern, timeoutMilliseconds);
    await this.settle();
  }

  async assertScreenExcludes(label: string, pattern: RegExp): Promise<void> {
    await this.#screen.settled();
    this.throwScreenError();
    pattern.lastIndex = 0;
    if (pattern.test(this.screenText())) {
      throw new Error(`${label} was visible before it should be.\n${this.screenText()}`);
    }
    this.journal.record("assert.screen.absent", { label, pattern: String(pattern) });
  }

  async exit(): Promise<void> {
    if (this.#child.exitCode === null) this.send("/exit\r");
    let exitCode = await Promise.race([
      this.#child.exited,
      Bun.sleep(2_000).then(() => undefined)
    ]);
    if (exitCode === undefined && this.#child.exitCode === null) {
      this.#child.kill("SIGKILL");
      exitCode = await this.#child.exited;
      this.journal.record("terminal.exit", { exitCode, timedOut: true });
      throw new Error(`TUI fixture did not exit within 2000ms (exit code ${exitCode}).`);
    }
    exitCode ??= this.#child.exitCode ?? undefined;
    this.journal.record("terminal.exit", { exitCode, timedOut: false });
    if (exitCode !== 0) throw new Error(`TUI fixture exited with code ${String(exitCode)}.`);
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timeout);
    if (this.#child.exitCode === null) {
      this.#child.kill("SIGKILL");
      await this.#child.exited;
    }
    if (!this.#terminal.closed) this.#terminal.close();
    try {
      await this.#screen.settled();
      this.#historyOutput += this.#decoder.decode();
    } finally {
      this.#screen.dispose();
    }
    this.journal.record("terminal.dispose", { exitCode: this.#child.exitCode });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}
