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

import {
  attachmentSummary,
  clipboardImageAttachment,
  promptInput,
  type PromptImageAttachment
} from "./attachments.ts";
import { choose, type ChoiceItem } from "./choice-dialog.ts";
import {
  historyText,
  modelLabel,
  normalizeEvent,
  responseText,
  restoredMessages
} from "./events.ts";
import { FooterBar } from "./footer-bar.ts";
import { formatTokens, goalStatusText, normalizeGoal, type GoalState } from "./goal-status.ts";
import {
  formatWorkflowPanel,
  isMcpPickerRequest,
  isTerminalWorkflowStatus,
  mcpPicker,
  workflowRunPicker,
  workflowSelectedRunId,
  workflowStatus
} from "./panels.ts";
import {
  effortPicker,
  isEffortPickerRequest,
  isModelPickerRequest,
  modelPicker,
  type PickerSpec
} from "./selectors.ts";
import { RichMarkdown } from "./rich-markdown.ts";
import {
  contextRemainingPercent,
  mergeMetrics,
  projectionMetrics,
  usageMetrics,
  type SessionMetrics
} from "./session-status.ts";
import {
  executionMode,
  nextAutonomyMode,
  nextPickerCommand,
  toggledWorkMode
} from "./shortcuts.ts";
import { createTheme, type ZCodeTheme } from "./theme.ts";
import { StatusLine, type StatusLineField } from "./status-line.ts";
import { ToolExecutionView, toolSucceeded } from "./tool-view.ts";
import { Transcript } from "./transcript.ts";
import { turnStatusText } from "./turn-status.ts";
import { asString, isRecord, type PromptCallOptions, type TuiOptions } from "./types.ts";

interface ToolViewState {
  name: string;
  view: ToolExecutionView;
  input?: unknown;
  inputText: string;
}

class ZCodeTui {
  private readonly theme: ZCodeTheme;
  private readonly ui: TUI;
  private readonly transcript = new Transcript();
  private readonly choiceHost = new Container();
  private readonly status: StatusLine;
  private readonly turnStatus: FooterBar;
  private readonly attachmentStatus: Text;
  private readonly editor: Editor;
  private readonly done: Promise<void>;
  private resolveDone!: () => void;
  private stopped = false;
  private activeSubmissions = 0;
  private turnAbortController?: AbortController;
  private currentAssistant?: RichMarkdown;
  private currentAssistantText = "";
  private readonly toolViews = new Map<string, ToolViewState>();
  private pendingAttachments: PromptImageAttachment[] = [];
  private mode: string;
  private lastExecutionMode: string;
  private model: string;
  private thoughtLevel?: string;
  private modelOptions: unknown[];
  private effortOptions: unknown[];
  private lastAssistantText = "";
  private unsubscribeWorkflow?: () => void;
  private workflowPanel?: Record<string, unknown>;
  private workflowView?: Markdown;
  private workflowRefreshInFlight = false;
  private choiceDepth = 0;
  private settingSwitchInFlight = false;
  private activity?: string;
  private turnStartedAt?: number;
  private turnElapsedMilliseconds = 0;
  private turnTimer?: ReturnType<typeof setInterval>;
  private goal?: GoalState;
  private goalRefreshInFlight = false;
  private goalRefreshPending = false;
  private sessionMetrics: SessionMetrics = {};
  private usageRefreshInFlight = false;
  private usageRefreshPending = false;

  constructor(private readonly options: TuiOptions) {
    this.theme = createTheme(!options.noColor && !process.env.NO_COLOR);
    this.mode = options.initialMode ?? "build";
    this.lastExecutionMode = executionMode(this.mode);
    this.model = modelLabel(options.initialModel);
    this.thoughtLevel = options.initialThoughtLevel;
    this.modelOptions = [...(options.modelOptions ?? [])];
    this.effortOptions = [...(options.effortOptions ?? [])];
    this.ui = new TUI(new ProcessTerminal(), true);
    this.status = new StatusLine();
    this.turnStatus = new FooterBar();
    this.attachmentStatus = new Text("", 0, 0);
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
    this.updateMetadata();
    this.updateTurnStatus();
    if (!this.options.loginRequired) void this.refreshGoal();
    if (!this.options.loginRequired) void this.refreshSessionUsage();
    void this.loadHistory();
    if (this.options.subscribeWorkflowEvents) {
      this.unsubscribeWorkflow = this.options.subscribeWorkflowEvents((event) => {
        this.debugEvent("workflow", event);
        void this.refreshWorkflowFromEvent();
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
      this.ui.addChild(new Text(this.theme.warning("Model access is not configured."), 1, 0));
      this.ui.addChild(
        new Text(
          this.theme.warning("Run /login, or configure a custom provider in ~/.zcode/cli/config.json."),
          1,
          0
        )
      );
    }
    this.ui.addChild(new Spacer(1));
    this.ui.addChild(this.transcript);
    this.ui.addChild(this.choiceHost);
    this.ui.addChild(this.status);
    this.ui.addChild(this.attachmentStatus);
    this.ui.addChild(this.editor);
    this.ui.addChild(this.turnStatus);

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
      { name: "paste-image", description: "Attach an image from the system clipboard" },
      { name: "attachments", description: "Show or clear pending attachments", argumentHint: "[clear]" },
      { name: "exit", description: "Exit ZCode" }
    ]) {
      if (!commands.some((item) => item.name === command.name)) commands.push(command);
    }
    return commands;
  }

  private bindInput(): void {
    this.ui.addInputListener((data) => {
      if (this.choiceDepth > 0) return undefined;
      if (matchesKey(data, "shift+tab")) {
        void this.switchWorkMode();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+n")) {
        void this.switchModel();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+l")) {
        void this.switchAutonomy();
        return { consume: true };
      }
      if (matchesKey(data, "tab") && !this.editor.getText()) {
        void this.switchEffort();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+v")) {
        void this.attachClipboardImage();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) {
        if (this.turnAbortController) {
          this.turnAbortController.abort();
          this.updateActivity("cancelling…");
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
        this.updateActivity("cancelling…");
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
      this.currentAssistant = undefined;
      this.currentAssistantText = "";
      this.toolViews.clear();
      this.workflowView = undefined;
      this.ui.requestRender(true);
      return;
    }
    if (input === "/copy") {
      await this.copyLastResponse();
      return;
    }
    if (input === "/paste-image") {
      await this.attachClipboardImage();
      return;
    }
    if (input === "/attachments" || input === "/attachments list") {
      this.addNotice(
        this.pendingAttachments.length > 0 ? attachmentSummary(this.pendingAttachments) : "No pending attachments.",
        "muted"
      );
      return;
    }
    if (input === "/attachments clear") {
      this.pendingAttachments = [];
      this.updateAttachmentStatus();
      this.addNotice("Pending attachments cleared.", "muted");
      return;
    }
    if (input.startsWith("/") && this.activeSubmissions > 0) {
      this.addNotice("Wait for the active turn or press Ctrl+C before running a slash command.", "warning");
      return;
    }
    if (isMcpPickerRequest(input) && await this.showMcpPicker()) {
      return;
    }
    if (isModelPickerRequest(input) && await this.showCommandPicker(
      "Select model",
      `Current model: ${this.model}.`,
      modelPicker(this.modelOptions, this.model),
      true
    )) {
      return;
    }
    if (isEffortPickerRequest(input) && await this.showCommandPicker(
      "Select reasoning effort",
      `Current reasoning effort: ${this.thoughtLevel ?? "default"}.`,
      effortPicker(this.effortOptions, this.thoughtLevel),
      true
    )) {
      return;
    }

    const steering = this.activeSubmissions > 0;
    const attachments = !steering && !input.startsWith("/") ? [...this.pendingAttachments] : [];
    this.addUserMessage(input, steering, attachments.length);
    if (!steering) this.beginTurn();

    const abortController = new AbortController();
    if (!steering) this.turnAbortController = abortController;
    this.activeSubmissions += 1;
    this.updateActivity(steering ? "steering…" : "working…");

    const callOptions: PromptCallOptions = {
      abortSignal: abortController.signal,
      inputId: `input_${crypto.randomUUID()}`,
      queryId: `query_${crypto.randomUUID()}`,
      onEvent: (event) => this.onEvent(event),
      requestPermission: (request, context) => this.requestPermission(request, context)
    };

    let accepted = false;
    try {
      if (input.startsWith("/") || !this.options.sendInput) {
        const result = await this.options.submitPrompt(
          input.startsWith("/") ? input : promptInput(input, attachments),
          callOptions
        );
        await this.handleResult(result);
        accepted = true;
      } else {
        const outcome = await this.options.sendInput(promptInput(input, attachments), callOptions);
        accepted = await this.handleSendOutcome(outcome);
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        this.addNotice("Turn cancelled.", "muted");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.addNotice(message, "error");
      }
    } finally {
      if (accepted && attachments.length > 0) {
        const sent = new Set(attachments);
        this.pendingAttachments = this.pendingAttachments.filter((attachment) => !sent.has(attachment));
        this.updateAttachmentStatus();
      }
      this.activeSubmissions = Math.max(0, this.activeSubmissions - 1);
      if (this.turnAbortController === abortController) this.turnAbortController = undefined;
      if (this.activeSubmissions === 0) {
        this.currentAssistant = undefined;
        this.finishTurn();
      }
      void this.refreshGoal();
      void this.refreshSessionUsage();
    }
  }

  private async handleSendOutcome(outcome: unknown): Promise<boolean> {
    if (!isRecord(outcome)) return true;
    const kind = asString(outcome.kind);
    if (kind === "started_turn") {
      await this.handleResult(outcome.result);
    } else if (kind === "queued") {
      this.addNotice("Input queued for the active turn.", "muted");
    } else if (kind === "rejected") {
      this.addNotice(`Input rejected: ${asString(outcome.reason) ?? "unknown reason"}.`, "warning");
      return false;
    }
    return true;
  }

  private async handleResult(result: unknown, renderResponse = true): Promise<void> {
    if (!isRecord(result)) return;
    if (result.resetSessionProjection === true) {
      this.transcript.clear();
      this.currentAssistant = undefined;
      this.currentAssistantText = "";
      this.toolViews.clear();
      this.workflowView = undefined;
      this.sessionMetrics = {};
      for (const message of restoredMessages(result.restoredMessages)) {
        if (message.role === "user") this.addUserMessage(message.text, false);
        else if (message.role === "assistant") this.addAssistantMessage(message.text);
        else this.addNotice(message.text, "muted");
      }
    }

    const response = responseText(result);
    if (renderResponse && response) {
      if (this.currentAssistant) {
        this.currentAssistantText = response;
        this.currentAssistant.setText(response);
        this.lastAssistantText = response;
      } else {
        this.addAssistantMessage(response);
      }
    }
    if (typeof result.mode === "string") {
      this.mode = result.mode;
      this.lastExecutionMode = executionMode(this.mode, this.lastExecutionMode);
    }
    if (result.model !== undefined) this.model = modelLabel(result.model);
    if (typeof result.thoughtLevel === "string") this.thoughtLevel = result.thoughtLevel;
    if (Array.isArray(result.modelOptions)) this.modelOptions = [...result.modelOptions];
    if (Array.isArray(result.effortOptions)) this.effortOptions = [...result.effortOptions];
    this.sessionMetrics = mergeMetrics(this.sessionMetrics, projectionMetrics(result.projection));
    this.updateMetadata();
    this.ui.requestRender();

    if (isRecord(result.workflowPanel)) await this.showWorkflowPanel(result.workflowPanel);
    if (isRecord(result.selection)) await this.showSelection(result.selection);
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
      this.updateActivity("thinking…");
    } else if (event.kind === "tool_input_start") {
      const tool = this.ensureToolView(event.toolCallId, event.toolName);
      this.updateToolView(tool, "preparing");
      this.updateActivity(`preparing ${tool.name}…`);
    } else if (event.kind === "tool_input_delta" && event.delta) {
      const tool = this.ensureToolView(event.toolCallId, event.toolName);
      tool.inputText += event.delta;
      this.updateToolView(tool, "preparing");
    } else if (event.kind === "tool_input_end") {
      const tool = this.ensureToolView(event.toolCallId, event.toolName);
      this.updateToolView(tool, "prepared");
    } else if (event.kind === "tool_call" || event.kind === "scheduled" || event.kind === "started") {
      const tool = this.ensureToolView(event.toolCallId, event.toolName);
      if (event.input !== undefined) tool.input = event.input;
      this.updateToolView(tool, event.kind === "scheduled" ? "scheduled" : "running");
      this.updateActivity(`running ${tool.name}…`);
    } else if (event.kind === "progress") {
      const tool = this.ensureToolView(event.toolCallId, event.toolName);
      this.updateToolView(tool, "running", event.result);
    } else if (event.kind === "result") {
      const tool = this.ensureToolView(event.toolCallId, event.toolName);
      this.updateToolView(tool, toolSucceeded(event.result) ? "complete" : "failed", event.result);
    } else if (event.kind === "error" && (event.toolCallId || event.toolName)) {
      const tool = this.ensureToolView(event.toolCallId, event.toolName);
      this.updateToolView(tool, "failed", event.result, event.error);
    } else if (event.kind === "error") {
      this.addNotice(event.error instanceof Error ? event.error.message : asString(event.error) ?? "Model stream failed.", "error");
    } else if (event.type === "turn.failed") {
      this.addNotice("Turn failed.", "error");
    }
    this.ui.requestRender();
  }

  private beginTurn(): void {
    this.currentAssistant = undefined;
    this.currentAssistantText = "";
    this.toolViews.clear();
    this.turnStartedAt = Date.now();
    this.turnElapsedMilliseconds = 0;
    if (this.turnTimer) clearInterval(this.turnTimer);
    this.turnTimer = setInterval(() => this.updateTurnStatus(), 1_000);
    this.updateTurnStatus();
  }

  private ensureAssistant(): RichMarkdown {
    if (!this.currentAssistant) {
      this.currentAssistant = new RichMarkdown("", 1, this.theme);
      this.transcript.addBlock(this.currentAssistant);
    }
    return this.currentAssistant;
  }

  private addUserMessage(text: string, steering: boolean, attachmentCount = 0): void {
    const prefix = steering ? "↪" : "›";
    const suffix = attachmentCount > 0 ? `  [${attachmentCount} image${attachmentCount === 1 ? "" : "s"}]` : "";
    this.transcript.addBlock(
      new Text(`${this.theme.accent(prefix)} ${text}${this.theme.muted(suffix)}`, 1, 0, this.theme.userBackground)
    );
    this.ui.requestRender();
  }

  private addAssistantMessage(text: string): void {
    this.transcript.addBlock(new RichMarkdown(text, 1, this.theme));
    this.lastAssistantText = text;
    this.ui.requestRender();
  }

  private addNotice(text: string, style: "warning" | "error" | "muted"): void {
    this.transcript.addBlock(new Text(this.theme[style](text), 1, 0));
    this.ui.requestRender();
  }

  private ensureToolView(toolCallId?: string, toolName?: string): ToolViewState {
    const id = toolCallId ?? `${toolName ?? "tool"}-${this.toolViews.size}`;
    const existing = this.toolViews.get(id);
    if (existing) {
      if (toolName) existing.name = toolName;
      return existing;
    }
    const tool: ToolViewState = {
      name: toolName ?? "tool",
      view: new ToolExecutionView(this.theme, {
        name: toolName ?? "tool",
        state: "preparing"
      }),
      inputText: ""
    };
    this.toolViews.set(id, tool);
    this.transcript.addBlock(tool.view);
    return tool;
  }

  private updateToolView(tool: ToolViewState, state: string, result?: unknown, error?: unknown): void {
    tool.view.update({
      name: tool.name,
      state,
      input: tool.input,
      inputText: tool.inputText,
      result,
      error
    });
  }

  private async attachClipboardImage(): Promise<void> {
    if (!this.options.readClipboardImage) {
      this.addNotice("Clipboard image support is unavailable in this runtime.", "warning");
      return;
    }
    if (this.activeSubmissions > 0) {
      this.addNotice("Wait for the active turn before attaching an image.", "warning");
      return;
    }
    this.updateActivity("reading clipboard…");
    try {
      const attachment = clipboardImageAttachment(await this.options.readClipboardImage());
      if (!attachment) {
        this.addNotice("No supported image found in the clipboard.", "warning");
        return;
      }
      this.pendingAttachments.push(attachment);
      this.updateAttachmentStatus();
      this.addNotice(`${attachmentSummary([attachment])}.`, "muted");
    } catch (error) {
      this.addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.updateActivity(undefined);
    }
  }

  private updateAttachmentStatus(): void {
    const summary = attachmentSummary(this.pendingAttachments);
    this.attachmentStatus.setText(summary ? ` ${this.theme.warning(summary)} · /attachments clear` : "");
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
    const selected = await this.showChoice({
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
    const selected = await this.showChoice({
      title: asString(selection.title) ?? "Choose",
      prompt: asString(selection.prompt) ?? "Select an item.",
      help: asString(selection.help),
      items,
      selectedIndex: typeof selection.selectedIndex === "number" ? selection.selectedIndex : 0
    });
    if (typeof selected?.payload === "string") void this.submit(selected.payload);
  }

  private async showCommandPicker(
    title: string,
    prompt: string,
    picker: PickerSpec,
    silent = false
  ): Promise<boolean> {
    if (picker.items.length === 0) return false;
    const selected = await this.showChoice({
      title,
      prompt,
      items: picker.items.map((item) => ({ ...item, payload: item.command })),
      selectedIndex: picker.selectedIndex
    });
    if (typeof selected?.payload === "string") {
      if (silent) await this.applySettingCommand(selected.payload);
      else await this.submit(selected.payload);
    }
    return true;
  }

  private shortcutAvailable(): boolean {
    if (this.settingSwitchInFlight) return false;
    if (this.activeSubmissions === 0) return true;
    this.addNotice("Wait for the active turn or press Ctrl+C before switching settings.", "warning");
    return false;
  }

  private async switchWorkMode(): Promise<void> {
    if (!this.shortcutAvailable()) return;
    await this.applyModeShortcut(toggledWorkMode(this.mode, this.lastExecutionMode));
  }

  private async switchAutonomy(): Promise<void> {
    if (!this.shortcutAvailable()) return;
    await this.applyModeShortcut(nextAutonomyMode(this.mode, this.lastExecutionMode));
  }

  private async applyModeShortcut(nextMode: string): Promise<void> {
    if (this.settingSwitchInFlight) return;
    if (!this.options.setMode) {
      this.addNotice("Mode switching is unavailable in this runtime.", "warning");
      return;
    }
    this.settingSwitchInFlight = true;
    try {
      const result = await this.options.setMode(nextMode);
      this.mode = isRecord(result) ? asString(result.mode) ?? nextMode : asString(result) ?? nextMode;
      this.lastExecutionMode = executionMode(this.mode, this.lastExecutionMode);
      this.updateMetadata();
    } catch (error) {
      this.addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.settingSwitchInFlight = false;
    }
  }

  private async switchModel(): Promise<void> {
    if (!this.shortcutAvailable()) return;
    const command = nextPickerCommand(modelPicker(this.modelOptions, this.model), this.model);
    if (!command) {
      this.addNotice("No alternate model is available.", "muted");
      return;
    }
    await this.applySettingCommand(command);
  }

  private async switchEffort(): Promise<void> {
    if (!this.shortcutAvailable()) return;
    const command = nextPickerCommand(effortPicker(this.effortOptions, this.thoughtLevel), this.thoughtLevel);
    if (!command) {
      this.addNotice("No alternate reasoning effort is available.", "muted");
      return;
    }
    await this.applySettingCommand(command);
  }

  private async applySettingCommand(command: string): Promise<void> {
    if (this.settingSwitchInFlight) return;
    this.settingSwitchInFlight = true;
    try {
      const result = await this.options.submitPrompt(command, {
        inputId: `input_${crypto.randomUUID()}`,
        queryId: `query_${crypto.randomUUID()}`
      });
      await this.handleResult(result, false);
    } catch (error) {
      this.addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.settingSwitchInFlight = false;
    }
  }

  private async showMcpPicker(): Promise<boolean> {
    if (!this.options.listMcpServers) return false;
    try {
      const picker = mcpPicker(await this.options.listMcpServers());
      if (picker.items.length === 0) {
        this.addNotice("No MCP servers configured.", "muted");
        return true;
      }
      return await this.showCommandPicker(
        "MCP servers",
        "Enter connects a disconnected server or disconnects a connected server.",
        picker
      );
    } catch (error) {
      this.addNotice(error instanceof Error ? error.message : String(error), "error");
      return true;
    }
  }

  private renderWorkflowPanel(value: Record<string, unknown>): void {
    this.workflowPanel = value;
    const text = formatWorkflowPanel(value);
    if (this.workflowView) this.workflowView.setText(text);
    else {
      this.workflowView = new Markdown(text, 1, 0, this.theme.markdown);
      this.transcript.addBlock(this.workflowView);
    }
    this.ui.requestRender();
  }

  private async showWorkflowPanel(value: Record<string, unknown>): Promise<void> {
    this.renderWorkflowPanel(value);
    const picker = workflowRunPicker(value);
    if (picker.items.length === 0) return;
    const selected = await this.showChoice({
      title: "Workflow runs",
      prompt: "Select a run to inspect or manage.",
      items: picker.items.map((item) => ({ ...item, payload: item.command })),
      selectedIndex: picker.selectedIndex
    });
    if (typeof selected?.payload !== "string") return;
    await this.manageWorkflow(selected.payload);
  }

  private async manageWorkflow(runId: string): Promise<void> {
    let panel = this.workflowPanel;
    if (this.options.refreshWorkflowPanel) {
      const refreshed = await this.options.refreshWorkflowPanel({ runId });
      if (isRecord(refreshed)) panel = refreshed;
    }
    if (!panel) return;
    this.renderWorkflowPanel(panel);

    while (true) {
      const status = workflowStatus(panel, runId);
      const items: ChoiceItem[] = [];
      if (this.options.refreshWorkflowPanel) {
        items.push({ value: "refresh", label: "Refresh", description: "Reload workflow state" });
      }
      if (this.options.stopWorkflow && !isTerminalWorkflowStatus(status)) {
        items.push({ value: "stop", label: "Stop workflow", description: `Current status: ${status ?? "unknown"}` });
      }
      items.push({ value: "close", label: "Close", description: "Return to the prompt" });
      const action = await this.showChoice({
        title: `Workflow · ${runId}`,
        prompt: `Status: ${status ?? "unknown"}.`,
        items
      });
      if (!action || action.value === "close") return;
      try {
        const next = action.value === "stop"
          ? await this.options.stopWorkflow?.({ runId })
          : await this.options.refreshWorkflowPanel?.({ runId });
        if (isRecord(next)) {
          panel = next;
          this.renderWorkflowPanel(panel);
        }
      } catch (error) {
        this.addNotice(error instanceof Error ? error.message : String(error), "error");
        return;
      }
    }
  }

  private async refreshWorkflowFromEvent(): Promise<void> {
    if (this.workflowRefreshInFlight || !this.workflowPanel || !this.options.refreshWorkflowPanel) return;
    const runId = workflowSelectedRunId(this.workflowPanel);
    if (!runId) return;
    this.workflowRefreshInFlight = true;
    try {
      const refreshed = await this.options.refreshWorkflowPanel({ runId });
      if (isRecord(refreshed)) this.renderWorkflowPanel(refreshed);
    } catch {
      // The next workflow event can retry the projection refresh.
    } finally {
      this.workflowRefreshInFlight = false;
    }
  }

  private async showChoice(options: Parameters<typeof choose>[3]): Promise<ChoiceItem | null> {
    this.choiceDepth += 1;
    try {
      return await choose(this.ui, this.choiceHost, this.theme, options);
    } finally {
      this.choiceDepth = Math.max(0, this.choiceDepth - 1);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    }
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

  private updateMetadata(): void {
    const fields: StatusLineField[] = [
      {
        text: this.theme.muted(this.model),
        priority: 100,
        required: true
      },
      {
        text: this.theme.muted(this.mode),
        priority: 70
      }
    ];
    if (this.thoughtLevel) {
      fields.push({
        text: this.theme.muted(this.thoughtLevel),
        priority: 60
      });
    }

    const remaining = contextRemainingPercent(this.sessionMetrics);
    if (remaining !== undefined) {
      const style = remaining <= 10
        ? this.theme.error
        : remaining <= 20
          ? this.theme.warning
          : this.theme.muted;
      fields.push({
        text: style(`${remaining}% context left`),
        compactText: style(`ctx ${remaining}%`),
        priority: 90
      });
    }
    if (this.sessionMetrics.totalTokens !== undefined) {
      const tokens = formatTokens(this.sessionMetrics.totalTokens);
      fields.push({
        text: this.theme.muted(`${tokens} tokens`),
        compactText: this.theme.muted(`${tokens} tok`),
        priority: 20
      });
    }

    this.status.setFields(fields, this.theme.muted(" · "));
    this.ui.requestRender();
  }

  private updateActivity(activity: string | undefined): void {
    this.activity = activity;
    this.updateTurnStatus();
  }

  private updateTurnStatus(): void {
    if (this.turnStartedAt !== undefined) {
      this.turnElapsedMilliseconds = Math.max(0, Date.now() - this.turnStartedAt);
    }
    const text = turnStatusText(this.activity, this.turnElapsedMilliseconds);
    const left = this.activity ? this.theme.accent(text) : this.theme.muted(text);
    const goalText = goalStatusText(this.goal);
    const right = goalText && this.goal
      ? this.goal.status === "complete"
        ? this.theme.success(goalText)
        : this.goal.status === "paused" || this.goal.status === "budget_limited"
          ? this.theme.warning(goalText)
          : this.theme.accent(goalText)
      : undefined;
    this.turnStatus.setContent(left, right);
    this.ui.requestRender();
  }

  private async refreshGoal(): Promise<void> {
    if (!this.options.readGoal) return;
    if (this.goalRefreshInFlight) {
      this.goalRefreshPending = true;
      return;
    }
    this.goalRefreshInFlight = true;
    try {
      do {
        this.goalRefreshPending = false;
        try {
          this.goal = normalizeGoal(await this.options.readGoal());
          this.updateTurnStatus();
        } catch {
          // Goal status is supplementary and must not interrupt the active turn.
        }
      } while (this.goalRefreshPending);
    } finally {
      this.goalRefreshInFlight = false;
    }
  }

  private async refreshSessionUsage(): Promise<void> {
    if (!this.options.readSessionUsage) return;
    if (this.usageRefreshInFlight) {
      this.usageRefreshPending = true;
      return;
    }
    this.usageRefreshInFlight = true;
    try {
      do {
        this.usageRefreshPending = false;
        try {
          this.sessionMetrics = mergeMetrics(
            this.sessionMetrics,
            usageMetrics(await this.options.readSessionUsage())
          );
          this.updateMetadata();
        } catch {
          // Usage is supplementary and must not interrupt the active turn.
        }
      } while (this.usageRefreshPending);
    } finally {
      this.usageRefreshInFlight = false;
    }
  }

  private finishTurn(): void {
    if (this.turnStartedAt !== undefined) {
      this.turnElapsedMilliseconds = Math.max(0, Date.now() - this.turnStartedAt);
      this.turnStartedAt = undefined;
    }
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
      this.turnTimer = undefined;
    }
    this.activity = undefined;
    this.updateTurnStatus();
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
    if (this.turnTimer) clearInterval(this.turnTimer);
    this.unsubscribeWorkflow?.();
    this.ui.stop();
    this.resolveDone();
  }
}

export async function runTui(options: TuiOptions): Promise<void> {
  await new ZCodeTui(options).run();
}
