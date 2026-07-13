import { appendFileSync } from "node:fs";

import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  type SlashCommand
} from "@earendil-works/pi-tui";

import { choose, type ChoiceItem } from "./choice-dialog.ts";
import {
  historyText,
  modelLabel,
  normalizeEvent,
  responseText,
  restoredMessages
} from "./events.ts";
import { createTheme, type ZCodeTheme } from "./theme.ts";
import { asString, isRecord, type PromptCallOptions, type TuiOptions } from "./types.ts";

class ZCodeTui {
  private readonly theme: ZCodeTheme;
  private readonly ui: TUI;
  private readonly transcript = new Container();
  private readonly status: Text;
  private readonly editor: Editor;
  private readonly done: Promise<void>;
  private resolveDone!: () => void;
  private stopped = false;
  private activeSubmissions = 0;
  private turnAbortController?: AbortController;
  private currentAssistant?: Markdown;
  private currentAssistantText = "";
  private readonly toolIds = new Set<string>();
  private mode: string;
  private model: string;
  private thoughtLevel?: string;
  private lastAssistantText = "";
  private unsubscribeWorkflow?: () => void;

  constructor(private readonly options: TuiOptions) {
    this.theme = createTheme(!options.noColor && !process.env.NO_COLOR);
    this.mode = options.initialMode ?? "build";
    this.model = modelLabel(options.initialModel);
    this.thoughtLevel = options.initialThoughtLevel;
    this.ui = new TUI(new ProcessTerminal(), true);
    this.status = new Text("", 0, 0);
    this.editor = new Editor(this.ui, this.theme.editor, { paddingX: 1, autocompleteMaxVisible: 7 });
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.buildLayout();
    this.bindInput();
  }

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("ZCode TUI requires an interactive terminal.");
    }
    this.ui.start();
    this.ui.setFocus(this.editor);
    this.updateStatus("ready");
    void this.loadHistory();
    if (this.options.subscribeWorkflowEvents) {
      this.unsubscribeWorkflow = this.options.subscribeWorkflowEvents((event) => {
        this.debugEvent("workflow", event);
        this.updateStatus("workflow update");
      }) ?? undefined;
    }
    await this.done;
  }

  private buildLayout(): void {
    const branch = this.options.workspaceGitBranch ? ` · ${this.options.workspaceGitBranch}` : "";
    const workspace = this.options.workspaceDirectory ?? process.cwd();
    const title = `${this.theme.accent(this.theme.bold("ZCode"))} ${this.theme.muted(`v${this.options.version ?? "unknown"}`)}`;
    this.ui.addChild(new Text(title, 1, 0));
    this.ui.addChild(new Text(this.theme.muted(`${workspace}${branch}`), 1, 0));
    if (this.options.loginRequired) {
      this.ui.addChild(new Text(this.theme.warning("Login required. Run /login before sending a prompt."), 1, 0));
    }
    this.ui.addChild(new Spacer(1));
    this.ui.addChild(this.transcript);
    this.ui.addChild(this.status);
    this.ui.addChild(this.editor);
    this.ui.addChild(
      new Text(this.theme.muted("Enter send · Shift+Enter newline · Ctrl+C cancel/exit · /help commands"), 1, 0)
    );

    const commands = this.autocompleteCommands();
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(commands, this.options.workspaceDirectory ?? process.cwd(), null)
    );
    this.editor.onSubmit = (text) => void this.submit(text);
  }

  private autocompleteCommands(): SlashCommand[] {
    const commands: SlashCommand[] = [];
    for (const command of this.options.slashCommands ?? []) {
      const name = command.name?.replace(/^\//, "");
      if (!name) continue;
      commands.push({
        name,
        description: command.description ?? command.summary,
        argumentHint: command.argumentHint ?? command.inputHint ?? command.usage
      });
    }
    for (const command of [
      { name: "clear", description: "Clear the visible transcript" },
      { name: "copy", description: "Copy the latest assistant response" },
      { name: "exit", description: "Exit ZCode" }
    ]) {
      if (!commands.some((item) => item.name === command.name)) commands.push(command);
    }
    return commands;
  }

  private bindInput(): void {
    this.ui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        if (this.turnAbortController) {
          this.turnAbortController.abort();
          this.updateStatus("cancelling…");
        } else if (this.editor.getText()) {
          this.editor.setText("");
        } else {
          this.stop();
        }
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d") && !this.editor.getText() && !this.turnAbortController) {
        this.stop();
        return { consume: true };
      }
      if (matchesKey(data, "escape") && this.turnAbortController) {
        this.turnAbortController.abort();
        this.updateStatus("cancelling…");
        return { consume: true };
      }
      return undefined;
    });
  }

  private async submit(rawInput: string): Promise<void> {
    const input = rawInput.trim();
    if (!input || this.stopped) return;
    this.editor.addToHistory(input);

    if (input === "/exit" || input === "/quit") {
      this.stop();
      return;
    }
    if (input === "/clear") {
      this.transcript.clear();
      this.ui.requestRender(true);
      return;
    }
    if (input === "/copy") {
      await this.copyLastResponse();
      return;
    }
    if (input.startsWith("/") && this.activeSubmissions > 0) {
      this.addNotice("Wait for the active turn or press Ctrl+C before running a slash command.", "warning");
      return;
    }

    const steering = this.activeSubmissions > 0;
    this.addUserMessage(input, steering);
    if (!steering) this.beginTurn();

    const abortController = new AbortController();
    if (!steering) this.turnAbortController = abortController;
    this.activeSubmissions += 1;
    this.updateStatus(steering ? "steering…" : "working…");

    const callOptions: PromptCallOptions = {
      abortSignal: abortController.signal,
      inputId: `input_${crypto.randomUUID()}`,
      queryId: `query_${crypto.randomUUID()}`,
      onEvent: (event) => this.onEvent(event),
      requestPermission: (request, context) => this.requestPermission(request, context)
    };

    try {
      if (input.startsWith("/") || !this.options.sendInput) {
        const result = await this.options.submitPrompt(input, callOptions);
        await this.handleResult(result);
      } else {
        const outcome = await this.options.sendInput(input, callOptions);
        await this.handleSendOutcome(outcome);
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        this.addNotice("Turn cancelled.", "muted");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.addNotice(message, "error");
      }
    } finally {
      this.activeSubmissions = Math.max(0, this.activeSubmissions - 1);
      if (this.turnAbortController === abortController) this.turnAbortController = undefined;
      if (this.activeSubmissions === 0) {
        this.currentAssistant = undefined;
        this.updateStatus("ready");
      }
    }
  }

  private async handleSendOutcome(outcome: unknown): Promise<void> {
    if (!isRecord(outcome)) return;
    const kind = asString(outcome.kind);
    if (kind === "started_turn") {
      await this.handleResult(outcome.result);
    } else if (kind === "queued") {
      this.addNotice("Input queued for the active turn.", "muted");
    } else if (kind === "rejected") {
      this.addNotice(`Input rejected: ${asString(outcome.reason) ?? "unknown reason"}.`, "warning");
    }
  }

  private async handleResult(result: unknown): Promise<void> {
    if (!isRecord(result)) return;
    if (result.resetSessionProjection === true) {
      this.transcript.clear();
      this.currentAssistant = undefined;
      this.currentAssistantText = "";
      for (const message of restoredMessages(result.restoredMessages)) {
        if (message.role === "user") this.addUserMessage(message.text, false);
        else if (message.role === "assistant") this.addAssistantMessage(message.text);
        else this.addNotice(message.text, "muted");
      }
    }

    const response = responseText(result);
    if (response) {
      if (this.currentAssistant) {
        this.currentAssistantText = response;
        this.currentAssistant.setText(response);
        this.lastAssistantText = response;
      } else {
        this.addAssistantMessage(response);
      }
    }
    if (typeof result.mode === "string") this.mode = result.mode;
    if (result.model !== undefined) this.model = modelLabel(result.model);
    if (typeof result.thoughtLevel === "string") this.thoughtLevel = result.thoughtLevel;
    this.updateStatus("ready");
    this.ui.requestRender();

    if (isRecord(result.selection)) void this.showSelection(result.selection);
  }

  private onEvent(value: unknown): void {
    this.debugEvent("session", value);
    const event = normalizeEvent(value);
    if (!event) return;
    if (event.kind === "text_delta" && event.delta) {
      const assistant = this.ensureAssistant();
      this.currentAssistantText += event.delta;
      assistant.setText(this.currentAssistantText);
      this.lastAssistantText = this.currentAssistantText;
    } else if (event.kind === "reasoning_delta") {
      this.updateStatus("thinking…");
    } else if (event.kind === "tool_input_start" || event.kind === "tool_call") {
      const id = event.toolCallId ?? `${event.toolName ?? "tool"}-${this.toolIds.size}`;
      if (!this.toolIds.has(id)) {
        this.toolIds.add(id);
        this.transcript.addChild(
          new Text(this.theme.muted(`  ⚙ ${event.toolName ?? "tool"}`), 1, 0)
        );
      }
      this.updateStatus(`running ${event.toolName ?? "tool"}…`);
    } else if (event.kind === "result") {
      const success = event.result?.success !== false;
      this.transcript.addChild(
        new Text(success ? this.theme.success("  ✓ tool complete") : this.theme.error("  ✗ tool failed"), 1, 0)
      );
    } else if (event.type === "turn.failed") {
      this.addNotice("Turn failed.", "error");
    }
    this.ui.requestRender();
  }

  private beginTurn(): void {
    this.currentAssistant = undefined;
    this.currentAssistantText = "";
    this.toolIds.clear();
  }

  private ensureAssistant(): Markdown {
    if (!this.currentAssistant) {
      this.currentAssistant = new Markdown("", 1, 0, this.theme.markdown);
      this.transcript.addChild(this.currentAssistant);
    }
    return this.currentAssistant;
  }

  private addUserMessage(text: string, steering: boolean): void {
    const prefix = steering ? "↪" : "›";
    this.transcript.addChild(
      new Text(`${this.theme.accent(prefix)} ${text}`, 1, 0, this.theme.userBackground)
    );
    this.ui.requestRender();
  }

  private addAssistantMessage(text: string): void {
    this.transcript.addChild(new Markdown(text, 1, 0, this.theme.markdown));
    this.lastAssistantText = text;
    this.ui.requestRender();
  }

  private addNotice(text: string, style: "warning" | "error" | "muted"): void {
    this.transcript.addChild(new Text(this.theme[style](text), 1, 0));
    this.ui.requestRender();
  }

  private async requestPermission(requestValue: unknown, context?: unknown): Promise<unknown> {
    const request = isRecord(requestValue) ? requestValue : {};
    const contextRecord = isRecord(context) ? context : undefined;
    const signal = contextRecord?.abortSignal instanceof AbortSignal
      ? contextRecord.abortSignal
      : this.turnAbortController?.signal;
    const toolName = asString(request.toolName) ?? "tool";
    const rawOptions = Array.isArray(request.options) ? request.options : [];
    const items: ChoiceItem[] = rawOptions.flatMap((option, index) => {
      if (!isRecord(option)) return [];
      const response = isRecord(option.response) ? option.response : undefined;
      const value = asString(option.optionId) ?? asString(option.kind) ?? String(index);
      return [{
        value,
        label: asString(option.name) ?? asString(option.label) ?? value,
        description: asString(option.description),
        payload: response
      }];
    });
    if (items.length === 0) {
      items.push(
        { value: "allow", label: "Allow once", payload: { decision: "allow", reason: "Approved interactively" } },
        { value: "deny", label: "Deny", payload: { decision: "deny", reason: "Denied interactively" } }
      );
    }
    const selected = await choose(this.ui, this.theme, {
      title: `Permission · ${toolName}`,
      prompt: asString(request.reason) ?? `${toolName} requests permission to continue.`,
      items,
      signal
    });
    return selected?.payload ?? { decision: "deny", reason: "Cancelled by user" };
  }

  private async showSelection(selection: Record<string, unknown>): Promise<void> {
    const rawItems = Array.isArray(selection.items) ? selection.items : [];
    const items: ChoiceItem[] = rawItems.flatMap((item, index) => {
      if (!isRecord(item)) return [];
      const command = asString(item.command);
      if (!command) return [];
      return [{
        value: command,
        label: asString(item.primary) ?? asString(item.label) ?? asString(item.id) ?? String(index),
        description: [asString(item.secondary), asString(item.meta)].filter(Boolean).join(" · "),
        payload: command
      }];
    });
    const selected = await choose(this.ui, this.theme, {
      title: asString(selection.title) ?? "Choose",
      prompt: asString(selection.prompt) ?? "Select an item.",
      help: asString(selection.help),
      items,
      selectedIndex: typeof selection.selectedIndex === "number" ? selection.selectedIndex : 0
    });
    if (typeof selected?.payload === "string") void this.submit(selected.payload);
  }

  private async copyLastResponse(): Promise<void> {
    if (!this.lastAssistantText) {
      this.addNotice("There is no assistant response to copy.", "muted");
      return;
    }
    if (!this.options.writeClipboardText) {
      this.addNotice("Clipboard support is unavailable in this runtime.", "warning");
      return;
    }
    try {
      await this.options.writeClipboardText(this.lastAssistantText);
      this.addNotice("Copied the latest assistant response.", "muted");
    } catch (error) {
      this.addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private async loadHistory(): Promise<void> {
    if (!this.options.recallPreviousInput) return;
    const history: string[] = [];
    for (let skip = 0; skip < 100; skip += 1) {
      try {
        const value = await this.options.recallPreviousInput(skip);
        const text = historyText(value);
        if (!text) break;
        history.push(text);
      } catch {
        break;
      }
    }
    for (const input of history.reverse()) this.editor.addToHistory(input);
  }

  private updateStatus(activity: string): void {
    const effort = this.thoughtLevel ? ` · ${this.thoughtLevel}` : "";
    this.status.setText(
      ` ${this.theme.accent(activity)}  ${this.theme.muted(`${this.model} · ${this.mode}${effort}`)}`
    );
    this.ui.requestRender();
  }

  private debugEvent(channel: string, value: unknown): void {
    const path = process.env.ZCODE_TUI_DEBUG_EVENTS;
    if (!path) return;
    try {
      appendFileSync(path, `${JSON.stringify({ channel, value })}\n`);
    } catch {
      // Diagnostics must never break the interactive client.
    }
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.turnAbortController?.abort();
    this.unsubscribeWorkflow?.();
    this.ui.stop();
    this.resolveDone();
  }
}

export async function runTui(options: TuiOptions): Promise<void> {
  await new ZCodeTui(options).run();
}
