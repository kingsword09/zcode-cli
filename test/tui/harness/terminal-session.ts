import { ScenarioJournal } from "./scenario-journal.ts";
import type { ScenarioWorkspace } from "./scenario-workspace.ts";

const defaultWaitMilliseconds = 8_000;
const renderSettleMilliseconds = 30;

export function terminalPlainText(value: string): string {
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
  #output = "";
  #closed = false;

  private constructor(
    terminal: Bun.Terminal,
    child: Bun.Subprocess,
    timeout: ReturnType<typeof setTimeout>,
    journal: ScenarioJournal
  ) {
    this.#terminal = terminal;
    this.#child = child;
    this.#timeout = timeout;
    this.journal = journal;
  }

  static start(options: TerminalSessionOptions): TerminalSession {
    const decoder = new TextDecoder();
    let session: TerminalSession | undefined;
    const terminal = new Bun.Terminal({
      cols: options.cols ?? 110,
      rows: options.rows ?? 40,
      name: "xterm-256color",
      data(_terminal, data) {
        const decoded = decoder.decode(data, { stream: true });
        if (session) {
          session.#output += decoded;
        }
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
    session = new TerminalSession(terminal, child, timeout, options.workspace.journal);
    session.journal.record("terminal.start", { command: options.command, pid: child.pid });
    return session;
  }

  checkpoint(): number {
    return this.#output.length;
  }

  text(start = 0): string {
    return terminalPlainText(this.#output.slice(start));
  }

  send(input: string): void {
    this.journal.record("terminal.input", { input: JSON.stringify(input) });
    this.#terminal.write(input);
  }

  async settle(): Promise<void> {
    await Bun.sleep(renderSettleMilliseconds);
  }

  async waitFor(
    label: string,
    pattern: RegExp,
    start = 0,
    timeoutMilliseconds = defaultWaitMilliseconds
  ): Promise<void> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) {
      pattern.lastIndex = 0;
      if (pattern.test(this.text(start))) {
        this.journal.record("assert.match", { label, pattern: String(pattern) });
        return;
      }
      if (this.#child.exitCode !== null) break;
      await Bun.sleep(20);
    }
    throw new Error([
      `Timed out waiting for ${label} (${String(pattern)}).`,
      "",
      "Terminal output:",
      this.text().slice(-6_000),
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
  ): Promise<number> {
    const start = this.checkpoint();
    this.send(input);
    await this.waitFor(label, pattern, start, timeoutMilliseconds);
    await this.settle();
    return start;
  }

  assertNotVisible(label: string, pattern: RegExp, start = 0): void {
    pattern.lastIndex = 0;
    if (pattern.test(this.text(start))) {
      throw new Error(`${label} was visible before it should be.\n${this.text(start).slice(-4_000)}`);
    }
    this.journal.record("assert.absent", { label, pattern: String(pattern) });
  }

  async exit(): Promise<void> {
    if (this.#child.exitCode === null) this.send("/exit\r");
    const exitCode = await Promise.race([
      this.#child.exited,
      Bun.sleep(2_000).then(() => undefined)
    ]);
    if (exitCode === undefined && this.#child.exitCode === null) {
      this.#child.kill("SIGKILL");
      await this.#child.exited;
    }
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
    this.journal.record("terminal.dispose", { exitCode: this.#child.exitCode });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}
