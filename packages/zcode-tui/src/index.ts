import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

import { readConfiguredModelAccess } from "../../../src/model-access.ts";
import {
  readStartupUpdate,
  refreshUpdateCache,
  type StartupUpdateCheck
} from "../../../src/update-check.ts";

import {
  Container,
  Editor,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
  type Component,
  type SlashCommand
} from "@earendil-works/pi-tui";

import {
  attachmentSummary,
  clipboardImageAttachment,
  promptInput,
  type PromptImageAttachment
} from "./attachments.ts";
import { AttachmentBar } from "./attachment-bar.ts";
import { AssistantStream } from "./assistant-stream.ts";
import { choose, promptText, type ChoiceItem } from "./choice-dialog.ts";
import {
  colorSchemeFromRgb,
  initialColorScheme,
  themePreference,
  type ZCodeThemePreference
} from "./color-scheme.ts";
import {
  historyText,
  modelLabel,
  normalizeEvent,
  responseText,
  restoredMessages,
  type RestoredMessage,
  type RestoredPart,
  type StreamEvent
} from "./events.ts";
import { buildExitSummary } from "./exit-summary.ts";
import { FooterBar } from "./footer-bar.ts";
import { ContextDetailView, StatusDetailView } from "./context-status-view.ts";
import {
  DiffDetailPage,
  diffBrowserSources,
  diffFileDescription,
  type DiffBrowserSource
} from "./diff-browser.ts";
import { FileDiffView, fileDiffsForTool } from "./file-diff-view.ts";
import {
  formatTokens,
  goalStatusLabel,
  goalStatusText,
  normalizeGoal,
  type GoalState
} from "./goal-status.ts";
import {
  answeredQuestionInput,
  defaultPermissionChoices,
  isAskUserQuestionTool,
  isExitPlanModeTool,
  parseUserQuestions,
  planText,
  type UserQuestion
} from "./interactions.ts";
import { PermissionPreview } from "./permission-view.ts";
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
  notificationDeliveryLabel,
  notificationSettings,
  readNotificationSettings,
  readStoredNotificationSettings,
  TurnNotifier,
  writeNotificationSettings,
  type NotificationCondition,
  type NotificationMethod,
  type NotificationSettings,
  type TurnNotificationKind
} from "./notifications.ts";
import {
  effortPicker,
  isEffortPickerRequest,
  isModelPickerRequest,
  modelPicker,
  type PickerSpec
} from "./selectors.ts";
import { RichMarkdown } from "./rich-markdown.ts";
import {
  fileRewindPreview,
  rewindCommand,
  rewindTargetLabel,
  rewindTargets,
  type FileRewindPreview,
  type RewindScope,
  type RewindTarget
} from "./rewind.ts";
import { isVisibleProtocolPart, ProtocolPartView } from "./protocol-part-view.ts";
import { InputQueue, type QueuedSubmission } from "./input-queue.ts";
import { QueuedInputView } from "./queued-input-view.ts";
import { RuntimeActivityView } from "./runtime-activity-view.ts";
import {
  runtimePollInterval,
  runtimePollStateChanged,
  type RuntimePollState
} from "./runtime-poll.ts";
import {
  parseSelectionCommand,
  protectSubmission,
  redactSecrets,
  selectionSubmission,
  type ProtectedSubmission,
  type SelectionCommand
} from "./selection-command.ts";
import {
  isActiveBackgroundJob,
  normalizeRuntimeProjection,
  normalizeTodoGroups,
  normalizeTodos,
  type RuntimeBackgroundJob,
  type RuntimeProjectionSnapshot,
  type RuntimeTodo,
  type RuntimeTodoGroup
} from "./runtime-projection.ts";
import {
  contextRemainingPercent,
  mergeMetrics,
  projectionMetrics,
  sessionIdFromUsage,
  usageMetrics,
  type SessionMetrics
} from "./session-status.ts";
import {
  appliesToSetting,
  nextMode,
  nextPickerCommand,
  normalizedMode,
  settingTargetForCommand,
  type Mode,
  type SettingTarget
} from "./shortcuts.ts";
import { createTheme, type ZCodeTheme } from "./theme.ts";
import { StatusLine, type StatusLineField } from "./status-line.ts";
import { SystemEventView, type SystemEventData } from "./system-event-view.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import { ThinkingView } from "./thinking-view.ts";
import { ToolGroupView } from "./tool-group-view.ts";
import { ToolTreeView } from "./tool-tree-view.ts";
import { TurnDiffStore } from "./turn-diff-store.ts";
import {
  isGroupedInformationTool,
  type ToolProgressData
} from "./tool-renderers.ts";
import { ToolExecutionView, toolSucceeded } from "./tool-view.ts";
import { Transcript } from "./transcript.ts";
import {
  TURN_TIMER_FRAME_DURATION_MS,
  turnStatusText,
  turnTimerAnimationEnabled
} from "./turn-status.ts";
import { asString, isRecord, type PromptCallOptions, type TuiOptions } from "./types.ts";
import { UpdateAvailableView, updateCommand } from "./update-available-view.ts";
import { Divider, WelcomeBanner } from "./welcome-banner.ts";
import { WorkspaceAutocompleteProvider } from "./workspace-autocomplete.ts";
import { readWorkspaceDiff } from "./workspace-diff.ts";

interface ToolViewState {
  id: string;
  blockId: string;
  name: string;
  view: ToolExecutionView;
  tree: ToolTreeView;
  group?: ToolGroupView;
  parentToolCallId?: string;
  nested: boolean;
  messageId?: string;
  partId?: string;
  input?: unknown;
  inputText: string;
  state: string;
  result?: unknown;
  error?: unknown;
  progress?: ToolProgressData;
}

const toolLifecycleEventKinds = new Set([
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
  "tool_call",
  "scheduled",
  "started",
  "progress",
  "result",
  "error",
  "closed"
]);

const terminalThemeQueryTimeoutMs = 100;
const exitUsageQueryTimeoutMs = 250;

function modelRetryProgress(event: StreamEvent, phase: "scheduled" | "started"): string {
  const retryNumber = phase === "started"
    ? Math.max(1, (event.attempt ?? 2) - 1)
    : Math.max(1, (event.nextAttempt ?? ((event.attempt ?? 1) + 1)) - 1);
  const maxRetries = event.maxRetries
    ?? (event.maxAttempts !== undefined ? Math.max(1, event.maxAttempts - 1) : undefined);
  return `${retryNumber}${maxRetries !== undefined ? `/${maxRetries}` : ""}`;
}

const doubleEscapeTimeoutMs = 800;
const streamRenderIntervalMs = 100;
const customProviderHelpCommand = "__zcode_custom_provider_help__";
const rewindEscapeHint = "Esc again to rewind conversation";

interface SendInputDisposition {
  accepted: boolean;
  pendingInputId?: string;
  reason?: string;
}

export function shouldUseNoBrowserForLogin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (env.SSH_CONNECTION?.trim() || env.SSH_TTY?.trim()) return true;
  if (platform !== "linux") return false;
  return !env.DISPLAY?.trim() && !env.WAYLAND_DISPLAY?.trim();
}

export function shouldSuspendForLoginCommand(command: string): boolean {
  return command === "/login zai-coding-plan";
}

export function suspendedZaiLoginCommand(
  env: NodeJS.ProcessEnv = process.env,
  runtimeExecutable = process.execPath,
  runtimeEntry = process.argv[1]
): { args: string[]; program: string } {
  const executable = env.ZCODE_APP_CLI_EXECUTABLE?.trim();
  const launcher = env.ZCODE_APP_CLI_ENTRY?.trim();
  if (executable && launcher) {
    return { args: [launcher, "login", "--oauth"], program: executable };
  }
  if (!runtimeEntry) throw new Error("Unable to locate the ZCode runtime entry point.");
  return { args: [runtimeEntry, "login"], program: runtimeExecutable };
}

export function loginFailureDiagnostic(stdout: string, stderr: string): string | undefined {
  const lines = (stderr || stdout).trim().split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^(?:error:|failed\b|invalid\b|unknown\b)/iu.test(line))
    ?? lines.at(-1);
}

function restoredToolState(status: string): string {
  switch (status.toLowerCase()) {
    case "pending": return "queued";
    case "running": return "running";
    case "completed": return "complete";
    case "success": return "complete";
    case "error": return "failed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "rejected": return "rejected";
    case "interrupted": return "interrupted";
    default: return "interrupted";
  }
}

class ZCodeTui {
  private readonly animateTurnTimer: boolean;
  private readonly colorsEnabled: boolean;
  private readonly distributionVersion?: string;
  private readonly themePreference: ZCodeThemePreference;
  private readonly theme: ZCodeTheme;
  private readonly ui: TUI;
  private readonly transcript: Transcript;
  private readonly choiceHost = new Container();
  private readonly runtimeActivity: RuntimeActivityView;
  private readonly status: StatusLine;
  private readonly turnStatus: FooterBar;
  private readonly queuedInputView: QueuedInputView;
  private readonly attachmentBar: AttachmentBar;
  private readonly editor: Editor;
  private readonly assistantStream: AssistantStream;
  private readonly notifications: TurnNotifier;
  private readonly done: Promise<void>;
  private resolveDone!: () => void;
  private stopped = false;
  private activeSubmissions = 0;
  private queuedSelectionCommand?: QueuedSubmission;
  private readonly inputQueue: InputQueue;
  private turnAbortController?: AbortController;
  private currentThinking?: ThinkingView;
  private currentThinkingPartId?: string;
  private readonly thinkingParts = new Map<string, ThinkingView>();
  private readonly protocolPartViews = new Map<string, ProtocolPartView>();
  private readonly protocolPartKinds = new Map<string, RestoredPart["type"]>();
  private readonly protocolPartMessages = new Map<string, string>();
  private readonly protocolPartTools = new Map<string, string>();
  private readonly toolViews = new Map<string, ToolViewState>();
  private readonly pendingToolParents = new Map<string, string>();
  private readonly pendingToolProgress = new Map<string, ToolProgressData>();
  private readonly turnDiffs = new TurnDiffStore();
  private currentToolGroup?: ToolGroupView;
  private currentToolGroupBlockId?: string;
  private currentToolGroupMessageId?: string;
  private pendingAttachments: PromptImageAttachment[] = [];
  private mode: Mode;
  private model: string;
  private thoughtLevel?: string;
  private modelOptions: unknown[];
  private effortOptions: unknown[];
  private lastAssistantText = "";
  private turnAssistantText = "";
  private unsubscribeWorkflow?: () => void;
  private workflowPanel?: Record<string, unknown>;
  private workflowView?: Markdown;
  private workflowRefreshInFlight = false;
  private choiceDepth = 0;
  private settingSwitchInFlight = false;
  private rewindEscapePending = false;
  private rewindEscapeTimer?: ReturnType<typeof setTimeout>;
  private rewindFlowActive = false;
  private activity?: string;
  private turnStartedAt?: number;
  private turnElapsedMilliseconds = 0;
  private turnTimingVisible = false;
  private turnTimer?: ReturnType<typeof setInterval>;
  private streamRenderTimer?: ReturnType<typeof setTimeout>;
  private pendingTurnNotification?: TurnNotificationKind;
  private pendingTurnNotificationDetail = "";
  private goal?: GoalState;
  private goalRefreshInFlight = false;
  private goalRefreshPending = false;
  private sessionId?: string;
  private sessionMetrics: SessionMetrics = {};
  private usageRefreshInFlight = false;
  private usageRefreshPending = false;
  private runtimeProjection?: RuntimeProjectionSnapshot;
  private todos: RuntimeTodo[] = [];
  private todoGroups: RuntimeTodoGroup[] = [];
  private runtimeRefreshInFlight = false;
  private runtimeRefreshPending = false;
  private runtimeRefreshTimer?: ReturnType<typeof setTimeout>;
  private runtimePollTimer?: ReturnType<typeof setTimeout>;
  private updateCheckAbortController?: AbortController;
  private loginRequired: boolean;
  private readonly loginWarning = new Text("", 1, 0);
  private readonly loginHelp = new Text("", 1, 0);

  constructor(private readonly options: TuiOptions) {
    this.animateTurnTimer = turnTimerAnimationEnabled();
    this.colorsEnabled = !options.noColor && !process.env.NO_COLOR;
    this.themePreference = themePreference(options.theme);
    this.distributionVersion = sanitizeTerminalText(
      process.env.ZCODE_APP_CLI_VERSION?.trim() ?? "",
      { preserveSgr: false }
    ) || undefined;
    this.theme = createTheme(this.colorsEnabled, initialColorScheme(this.themePreference));
    this.transcript = new Transcript(this.theme.searchMatch);
    this.mode = normalizedMode(options.initialMode);
    this.model = modelLabel(options.initialModel);
    this.thoughtLevel = options.initialThoughtLevel;
    this.modelOptions = [...(options.modelOptions ?? [])];
    this.effortOptions = [...(options.effortOptions ?? [])];
    this.loginRequired = options.loginRequired === true;
    this.ui = new TUI(new ProcessTerminal(), true);
    this.notifications = new TurnNotifier({
      writeTerminal: (data) => this.ui.terminal.write(data)
    });
    this.status = new StatusLine();
    this.turnStatus = new FooterBar();
    this.queuedInputView = new QueuedInputView(this.theme);
    this.inputQueue = new InputQueue({
      onStateChanged: (state) => {
        this.queuedInputView.setState(state);
        this.ui.requestRender();
      },
      onSteerCommitted: (entries) => {
        this.completeThinking();
        this.assistantStream.breakSegment();
        for (const { messageId, displayInput } of entries) {
          this.addUserMessage(displayInput, 0, messageId);
        }
      },
      onSteerDiscarded: (count, reason) => {
        const detail = reason ? ` (${reason.replaceAll("_", " ")})` : "";
        this.addNotice(
          `${count === 1 ? "Steer was" : `${count} steers were`} not consumed${detail}; queued for the next turn.`,
          "warning"
        );
      }
    });
    this.attachmentBar = new AttachmentBar(this.theme, {
      onExit: () => this.leaveAttachmentSelection(),
      onRemove: (index) => this.removePendingAttachment(index),
      onRender: () => this.ui.requestRender()
    });
    this.runtimeActivity = new RuntimeActivityView(this.theme);
    this.editor = new Editor(this.ui, this.theme.editor, { paddingX: 1, autocompleteMaxVisible: 7 });
    this.assistantStream = new AssistantStream(
      this.theme,
      (component, blockOptions) => this.transcript.addBlock(component, blockOptions)
    );
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("ZCode TUI requires an interactive terminal.");
    }
    let notificationConfigError: string | undefined;
    try {
      this.notifications.setSettings(await readNotificationSettings());
    } catch (error) {
      notificationConfigError = error instanceof Error ? error.message : String(error);
    }
    const updateCheck = this.distributionVersion
      ? await readStartupUpdate({ currentVersion: this.distributionVersion }).catch(() => undefined)
      : undefined;
    this.ui.start();
    await this.resolveTerminalColorScheme();
    this.buildLayout();
    if (notificationConfigError) {
      this.addNotice(`Unable to load notification settings: ${notificationConfigError}`, "warning");
    }
    await this.restoreInitialTranscript();
    if (updateCheck?.availableVersion && this.distributionVersion) {
      this.addUpdateAvailable(this.distributionVersion, updateCheck.availableVersion);
    }
    this.bindInput();
    this.notifications.start();
    this.ui.setFocus(this.editor);
    this.updateMetadata();
    this.updateTurnStatus();
    this.ui.requestRender(true);
    this.startUpdateRefresh(updateCheck);
    if (!this.loginRequired) void this.refreshGoal();
    if (!this.loginRequired) void this.refreshSessionUsage();
    this.scheduleRuntimePoll(0);
    void this.loadHistory();
    if (this.options.subscribeWorkflowEvents) {
      this.unsubscribeWorkflow = this.options.subscribeWorkflowEvents((event) => {
        this.debugEvent("workflow", event);
        void this.refreshWorkflowFromEvent();
      }) ?? undefined;
    }
    await this.done;
  }

  private async resolveTerminalColorScheme(): Promise<void> {
    if (!this.colorsEnabled || this.themePreference !== "auto") return;
    try {
      const [background, reportedScheme] = await Promise.all([
        this.ui.queryTerminalBackgroundColor({ timeoutMs: terminalThemeQueryTimeoutMs }),
        this.ui.queryTerminalColorScheme({ timeoutMs: terminalThemeQueryTimeoutMs })
      ]);
      const colorScheme = background ? colorSchemeFromRgb(background) : reportedScheme;
      if (colorScheme) this.theme.setColorScheme(colorScheme);
    } catch {
      // Terminal color probing is optional; COLORFGBG or the dark fallback remains active.
    }
  }

  private buildLayout(): void {
    const workspace = this.options.workspaceDirectory ?? process.cwd();
    const runtimeVersion = sanitizeTerminalText(this.options.version ?? "unknown", { preserveSgr: false });
    this.ui.addChild(new WelcomeBanner(this.theme, {
      branch: this.options.workspaceGitBranch,
      distributionVersion: this.distributionVersion,
      runtimeVersion,
      workspace
    }));
    this.ui.addChild(new Divider("─", this.theme.muted));
    this.ui.addChild(this.loginWarning);
    this.ui.addChild(this.loginHelp);
    this.updateLoginWarning();
    this.ui.addChild(new Spacer(1));
    this.ui.addChild(this.transcript);
    this.ui.addChild(this.runtimeActivity);
    this.ui.addChild(this.choiceHost);
    this.ui.addChild(this.turnStatus);
    this.ui.addChild(this.queuedInputView);
    this.ui.addChild(this.attachmentBar);
    this.ui.addChild(this.editor);
    this.ui.addChild(this.status);

    const commands = this.autocompleteCommands();
    this.editor.setAutocompleteProvider(
      new WorkspaceAutocompleteProvider(
        commands,
        this.options.workspaceDirectory ?? process.cwd(),
        this.options.listWorkspacePathSuggestions
      )
    );
    this.editor.onSubmit = (text) => void this.submit(text);
  }

  private updateLoginWarning(): void {
    this.loginWarning.setText(
      this.loginRequired ? this.theme.warning("Model access is not configured.") : ""
    );
    this.loginHelp.setText(
      this.loginRequired
        ? this.theme.warning("Run /login, or configure a custom provider in ~/.zcode/cli/config.json.")
        : ""
    );
  }

  private setLoginRequired(required: boolean): void {
    const changed = this.loginRequired !== required;
    this.loginRequired = required;
    this.updateLoginWarning();
    if (changed && !required) {
      void this.refreshGoal();
      void this.refreshSessionUsage();
    }
  }

  private async runSuspendedLogin(displayInput: string, overrideCommand?: string): Promise<void> {
    this.transcript.clearSearch();
    this.transcript.clearCursor();
    this.addUserMessage(displayInput);
    this.beginTurn(displayInput);
    this.activeSubmissions += 1;
    this.updateActivity("signing in…");
    this.notifications.stop();
    this.ui.stop();

    let code = 1;
    let failure: string | undefined;
    let childStdout = "";
    let childStderr = "";
    try {
      let program: string;
      let args: string[];
      if (overrideCommand) {
        program = process.platform === "win32"
          ? process.env.ComSpec ?? "cmd.exe"
          : process.env.SHELL ?? "/bin/sh";
        args = process.platform === "win32"
          ? ["/d", "/s", "/c", overrideCommand]
          : ["-lc", overrideCommand];
      } else {
        const command = suspendedZaiLoginCommand();
        program = command.program;
        args = command.args;
        if (shouldUseNoBrowserForLogin()) args.push("--no-browser");
      }
      code = await new Promise<number>((resolve, reject) => {
        const child = spawn(program, args, {
          cwd: process.cwd(),
          env: process.env,
          stdio: overrideCommand ? "inherit" : ["inherit", "pipe", "pipe"]
        });
        if (!overrideCommand) {
          child.stdout?.on("data", (data: Buffer | string) => {
            const text = String(data);
            childStdout = `${childStdout}${text}`.slice(-16_384);
            process.stdout.write(text);
          });
          child.stderr?.on("data", (data: Buffer | string) => {
            const text = String(data);
            childStderr = `${childStderr}${text}`.slice(-16_384);
            process.stderr.write(text);
          });
        }
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
          resolve(exitCode ?? (signal ? 128 : 1));
        });
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.ui.start();
      this.notifications.start();
      this.ui.setFocus(this.editor);
      this.ui.requestRender(true);
    }

    const access = code === 0 ? await readConfiguredModelAccess() : null;
    if (access) {
      this.model = access.model;
      this.setLoginRequired(false);
      this.addNotice(`Model access configured via ${access.configPath}.`, "muted");
    } else if (failure) {
      this.addNotice(`Login command failed: ${failure}`, "error");
    } else if (code !== 0) {
      const diagnostic = loginFailureDiagnostic(childStdout, childStderr);
      this.addNotice(
        diagnostic
          ? `Login failed: ${diagnostic.replace(/^Error:\s*/u, "")}`
          : `Login command exited with status ${code}.`,
        "error"
      );
    } else {
      this.addNotice("Login command finished, but no configured model access was found.", "warning");
    }
    this.activeSubmissions = Math.max(0, this.activeSubmissions - 1);
    this.finishTurn(code === 0 && access ? "completed" : "failed");
    this.updateMetadata();
    this.ui.requestRender(true);
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
      { name: "attachments", description: "Manage or clear pending attachments", argumentHint: "[clear]" },
      { name: "activity", description: "Inspect every active tool and open task" },
      { name: "tasks", description: "Inspect or stop background tasks", argumentHint: "[stop <task-id>]" },
      { name: "diff", description: "Browse current and per-turn file changes" },
      { name: "context", description: "Inspect context usage and prompt composition" },
      { name: "status", description: "Inspect detailed runtime and session status" },
      { name: "config", description: "Configure ZCode TUI settings" },
      { name: "settings", description: "Configure ZCode TUI settings" },
      { name: "search", description: "Search the retained transcript", argumentHint: "<text>|next|prev|clear" },
      { name: "transcript", description: "Navigate and expand individual transcript blocks", argumentHint: "next|prev|latest|close" },
      { name: "exit", description: "Exit ZCode" }
    ]) {
      if (!commands.some((item) => item.name === command.name)) commands.push(command);
    }
    return commands;
  }

  private bindInput(): void {
    this.ui.addInputListener((data) => {
      if (this.notifications.handleInput(data)) return { consume: true };
      if (this.attachmentBar.isActive()) return undefined;
      if (this.choiceDepth > 0) return undefined;
      if (this.rewindFlowActive) return { consume: true };
      if (!matchesKey(data, "escape")) this.clearRewindEscape();
      if (matchesKey(data, "up") && this.canEnterAttachmentSelection()) {
        this.enterAttachmentSelection();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+o")) {
        this.prepareTranscriptViewport();
        if (this.transcript.toggleFocusedExpanded() === undefined) this.transcript.toggleExpanded();
        this.updateMetadata();
        this.ui.requestRender(true);
        return { consume: true };
      }
      if (!this.editor.getText() && this.transcript.searchStatus() && (data === "n" || data === "N")) {
        this.prepareTranscriptViewport();
        this.transcript.nextSearchMatch(data === "n" ? 1 : -1);
        this.updateMetadata();
        this.ui.requestRender(true);
        return { consume: true };
      }
      if (!this.editor.getText()
        && this.inputQueue.hasFollowUps()
        && (matchesKey(data, "alt+up") || matchesKey(data, "shift+left"))) {
        this.editLatestQueuedFollowUp();
        return { consume: true };
      }
      if (!this.editor.getText() && matchesKey(data, "shift+left")) {
        this.addNotice(
          this.inputQueue.hasPendingSteers()
            ? "A steer waiting in the runtime cannot be edited. Use Tab before Enter to keep input editable."
            : "No editable next-turn input is queued. During an active turn, press Tab instead of Enter to queue a draft.",
          "muted"
        );
        return { consume: true };
      }
      if (!this.editor.getText() && matchesKey(data, "alt+up")) {
        this.prepareTranscriptViewport();
        this.transcript.moveCursor(-1);
        this.updateMetadata();
        this.ui.requestRender(true);
        return { consume: true };
      }
      if (!this.editor.getText() && matchesKey(data, "alt+down")) {
        this.prepareTranscriptViewport();
        this.transcript.moveCursor(1);
        this.updateMetadata();
        this.ui.requestRender(true);
        return { consume: true };
      }
      if (!this.editor.getText() && (this.transcript.searchStatus() || this.transcript.cursorStatus())
        && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) {
        this.prepareTranscriptViewport();
        this.transcript.movePage(matchesKey(data, "pageUp") ? -1 : 1, this.ui.terminal.columns);
        this.ui.requestRender(true);
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+f")) {
        this.editor.setText("/search ");
        return { consume: true };
      }
      if (matchesKey(data, "shift+tab")) {
        void this.switchMode();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+n")) {
        void this.switchModel();
        return { consume: true };
      }
      if (matchesKey(data, "tab")
        && this.turnAbortController
        && Boolean(this.editor.getText().trim())
        && !this.editor.isShowingAutocomplete()) {
        this.queueCurrentEditorInput();
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
      if (matchesKey(data, "escape")) {
        if (this.turnAbortController) {
          this.clearRewindEscape();
          this.turnAbortController.abort();
          this.updateActivity("cancelling…");
          return { consume: true };
        }
        if (this.transcript.searchStatus() || this.transcript.cursorStatus()) {
          this.clearRewindEscape();
          this.transcript.clearSearch();
          this.transcript.clearCursor();
          this.updateMetadata();
          this.ui.requestRender(true);
          return { consume: true };
        }
        if (!this.editor.getText() && this.activeSubmissions === 0) {
          this.handleRewindEscape();
          return { consume: true };
        }
      }
      return undefined;
    });
  }

  private async submit(rawInput: string, queuedSubmission?: QueuedSubmission): Promise<void> {
    const input = (queuedSubmission?.input ?? rawInput).trim();
    if (!input || this.stopped) return;
    const submission = queuedSubmission ?? protectSubmission(input);
    if (submission.recordHistory) this.editor.addToHistory(input);

    if (input === "/exit" || input === "/quit") {
      this.stop();
      return;
    }
    if (input === "/clear") {
      this.clearTranscriptProjection();
      this.workflowView = undefined;
      this.ui.requestRender(true);
      return;
    }
    if (input === "/search" || input.startsWith("/search ")) {
      this.handleTranscriptSearch(input.slice("/search".length).trim());
      return;
    }
    if (input === "/transcript" || input.startsWith("/transcript ")) {
      this.handleTranscriptNavigation(input.slice("/transcript".length).trim());
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
      if (this.pendingAttachments.length === 0) {
        this.addNotice("No pending attachments.", "muted");
      } else {
        this.enterAttachmentSelection();
      }
      return;
    }
    if (input === "/attachments clear") {
      this.clearPendingAttachments(true);
      return;
    }
    if (input === "/activity") {
      await this.showActivityDetails();
      return;
    }
    if (input === "/tasks" || input === "/tasks list") {
      await this.showBackgroundTasks();
      return;
    }
    if (input.startsWith("/tasks stop ")) {
      await this.stopBackgroundTask(input.slice("/tasks stop ".length).trim());
      return;
    }
    if (input === "/diff") {
      await this.showDiffBrowser();
      return;
    }
    if (input.startsWith("/") && this.activeSubmissions > 0) {
      this.addNotice("Wait for the active turn or press Ctrl+C before running a slash command.", "warning");
      return;
    }
    if (input === "/context") {
      await this.showContextDetails();
      return;
    }
    if (input === "/status") {
      await this.showStatusDetails();
      return;
    }
    if (input === "/config" || input === "/settings") {
      await this.showConfiguration();
      return;
    }
    if (isMcpPickerRequest(input) && await this.showMcpPicker()) {
      return;
    }
    if (isModelPickerRequest(input) && await this.showCommandPicker(
      "Select model",
      `Current model: ${this.model}.`,
      modelPicker(this.modelOptions, this.model),
      "model"
    )) {
      return;
    }
    if (isEffortPickerRequest(input) && await this.showCommandPicker(
      "Select reasoning effort",
      `Current reasoning effort: ${this.thoughtLevel ?? "default"}.`,
      effortPicker(this.effortOptions, this.thoughtLevel),
      "effort"
    )) {
      return;
    }

    const loginOverride = input === "/login" ? process.env.ZCODE_TUI_LOGIN_CMD?.trim() : undefined;
    if (loginOverride) {
      await this.runSuspendedLogin(submission.displayInput, loginOverride);
      return;
    }
    if (queuedSubmission?.externalLogin || shouldSuspendForLoginCommand(input)) {
      await this.runSuspendedLogin(submission.displayInput);
      return;
    }

    this.transcript.clearSearch();
    this.transcript.clearCursor();

    const steering = this.activeSubmissions > 0;
    const attachments = !steering && !input.startsWith("/") ? [...this.pendingAttachments] : [];
    if (steering && !this.options.sendInput) {
      this.inputQueue.queueFollowUp({ ...submission, recordHistory: false });
      return;
    }
    if (attachments.length > 0) this.clearPendingAttachments(false);

    const abortController = new AbortController();
    const inputId = `input_${crypto.randomUUID()}`;
    const callOptions: PromptCallOptions = {
      abortSignal: abortController.signal,
      delivery: steering ? "steer_active_turn" : "start_turn",
      inputId,
      queryId: `query_${crypto.randomUUID()}`,
      onEvent: (event) => this.onEvent(event),
      requestPermission: (request, context) => this.requestPermission(request, context)
    };
    const pendingSteer = steering
      ? this.inputQueue.trackSteer(submission, inputId)
      : undefined;
    if (!steering) this.addUserMessage(submission.displayInput, attachments.length);
    if (submission.pending) {
      this.addNotice([
        submission.pending.primary,
        submission.pending.secondary,
        submission.pending.help
      ].filter(Boolean).join("\n"), "muted");
    }
    if (!steering) this.beginTurn(submission.displayInput);

    if (!steering) this.turnAbortController = abortController;
    this.activeSubmissions += 1;
    if (!steering || submission.status) this.updateActivity(submission.status ?? "working…");
    const notificationEligible = !steering && !input.startsWith("/");
    if (notificationEligible) this.pendingTurnNotification = "completed";

    let accepted = false;
    let unfinishedToolState = "interrupted";
    let nextCommand: QueuedSubmission | undefined;
    try {
      if (input.startsWith("/") || !this.options.sendInput) {
        const result = await this.options.submitPrompt(
          input.startsWith("/") ? input : promptInput(input, attachments),
          callOptions
        );
        await this.handleResult(result, true, settingTargetForCommand(input));
        accepted = true;
      } else {
        const outcome = await this.options.sendInput(promptInput(input, attachments), callOptions);
        const disposition = await this.handleSendOutcome(outcome);
        if (pendingSteer && disposition.pendingInputId) {
          this.inputQueue.associateSteer(pendingSteer.inputId, disposition.pendingInputId);
        }
        accepted = disposition.accepted;
        if (!accepted && steering) {
          const retained = this.inputQueue.removeSteer(pendingSteer?.inputId);
          if (retained) this.inputQueue.queueFollowUp({ ...retained.submission, recordHistory: false });
          const reason = disposition.reason ? ` (${disposition.reason.replaceAll("_", " ")})` : "";
          this.addNotice(`Steer was not accepted${reason}; queued for the next turn.`, "warning");
        } else if (!accepted) {
          this.inputQueue.autoSend = false;
          this.addNotice(
            `Input rejected: ${disposition.reason?.replaceAll("_", " ") ?? "unknown reason"}.`,
            "warning"
          );
        }
      }
      if (!accepted && notificationEligible) this.pendingTurnNotification = undefined;
    } catch (error) {
      if (abortController.signal.aborted) {
        unfinishedToolState = "cancelled";
        if (!steering) this.inputQueue.autoSend = false;
        if (notificationEligible) this.pendingTurnNotification = undefined;
        this.addNotice(submission.cancelStatus ?? "Turn cancelled.", "muted");
      } else {
        unfinishedToolState = "failed";
        if (!steering) this.inputQueue.autoSend = false;
        const message = error instanceof Error ? error.message : String(error);
        const detail = redactSecrets(message, submission.secrets);
        let steerRecoveryDetail: string | undefined;
        if (steering) {
          const retained = this.inputQueue.findSteer(pendingSteer?.inputId);
          if (retained?.pendingInputId) {
            steerRecoveryDetail = "Steer remains queued for the active turn.";
          } else if (retained) {
            const removed = this.inputQueue.removeSteer(pendingSteer?.inputId);
            if (removed) this.inputQueue.queueFollowUp({ ...removed.submission, recordHistory: false });
            steerRecoveryDetail = "Steer retained for the next turn.";
          } else {
            steerRecoveryDetail = "Steer state was already resolved by the runtime.";
          }
        }
        if (notificationEligible) {
          this.pendingTurnNotification = "failed";
          this.pendingTurnNotificationDetail = detail;
        }
        this.addNotice(
          steering ? `${detail}\n${steerRecoveryDetail}` : detail,
          steering ? "warning" : "error"
        );
      }
    } finally {
      this.activeSubmissions = Math.max(0, this.activeSubmissions - 1);
      if (this.turnAbortController === abortController) this.turnAbortController = undefined;
      if (this.activeSubmissions === 0) {
        nextCommand = this.queuedSelectionCommand;
        this.queuedSelectionCommand = undefined;
        if (!nextCommand && this.inputQueue.autoSend) {
          nextCommand = this.inputQueue.takeNextFollowUp();
          if (nextCommand) {
            this.pendingTurnNotification = undefined;
            this.pendingTurnNotificationDetail = "";
          }
        }
        this.finishTurn(unfinishedToolState);
      }
      void this.refreshGoal();
      void this.refreshSessionUsage();
    }
    if (nextCommand) await this.submit(nextCommand.input, nextCommand);
  }

  private async handleSendOutcome(outcome: unknown): Promise<SendInputDisposition> {
    if (!isRecord(outcome)) return { accepted: true };
    const kind = asString(outcome.kind);
    if (kind === "started_turn") {
      await this.handleResult(outcome.result);
      return { accepted: true };
    }
    if (kind === "queued") {
      return {
        accepted: true,
        pendingInputId: asString(outcome.pendingInputId) ?? asString(outcome.pendingInputID)
      };
    } else if (kind === "rejected") {
      return {
        accepted: false,
        reason: asString(outcome.reason) ?? "unknown reason"
      };
    }
    return { accepted: true };
  }

  private async handleResult(
    result: unknown,
    renderResponse = true,
    settingTarget?: SettingTarget
  ): Promise<void> {
    if (!isRecord(result)) return;
    if (result.resetSessionProjection === true) {
      this.clearTranscriptProjection();
      this.workflowView = undefined;
      this.sessionId = undefined;
      this.sessionMetrics = {};
      this.restoreTranscript(restoredMessages(result.restoredMessages));
    }

    const response = responseText(result);
    if (renderResponse && response) {
      this.completeThinking();
      this.recordAssistantText(this.assistantStream.reconcile(response));
    }
    if (appliesToSetting(settingTarget, "mode") && typeof result.mode === "string") {
      this.mode = normalizedMode(result.mode, this.mode);
    }
    if (appliesToSetting(settingTarget, "model") && result.model !== undefined) {
      this.model = modelLabel(result.model);
    }
    if (typeof result.loginRequired === "boolean") {
      this.setLoginRequired(result.loginRequired);
      if (!result.loginRequired
        && result.model === undefined
        && appliesToSetting(settingTarget, "model")) {
        const access = await readConfiguredModelAccess();
        if (access) this.model = access.model;
      }
    }
    if (appliesToSetting(settingTarget, "effort") && typeof result.thoughtLevel === "string") {
      this.thoughtLevel = result.thoughtLevel;
    }
    if (Array.isArray(result.modelOptions)) this.modelOptions = [...result.modelOptions];
    if (Array.isArray(result.effortOptions)) this.effortOptions = [...result.effortOptions];
    this.sessionMetrics = mergeMetrics(this.sessionMetrics, projectionMetrics(result.projection));
    if (Array.isArray(result.todos)) this.todos = normalizeTodos(result.todos);
    if (Array.isArray(result.todoGroups)) this.todoGroups = normalizeTodoGroups(result);
    this.applyRuntimeProjection(normalizeRuntimeProjection(result));
    this.updateMetadata();
    this.ui.requestRender();

    if (isRecord(result.workflowPanel)) await this.showWorkflowPanel(result.workflowPanel);
    if (isRecord(result.selection)) await this.showSelection(result.selection);
  }

  private onEvent(value: unknown): void {
    this.debugEvent("session", value);
    const event = normalizeEvent(value);
    if (!event) return;
    this.scheduleRuntimeRefresh();
    if (this.inputQueue.handleLifecycleEvent(event)) {
      this.requestStreamRender();
      return;
    }
    if (this.handleSubagentLifecycle(event)) {
      this.requestStreamRender();
      return;
    }
    if (this.handleProtocolPartEvent(event)) {
      this.requestStreamRender();
      return;
    }
    if (event.kind && toolLifecycleEventKinds.has(event.kind)) {
      this.completeThinking();
      this.assistantStream.breakSegment();
    }
    if (event.kind === "text_start") {
      this.currentToolGroup = undefined;
      this.completeThinking();
      this.assistantStream.breakSegment();
    } else if (event.kind === "text_delta" && event.delta) {
      this.currentToolGroup = undefined;
      this.completeThinking();
      this.recordAssistantText(this.assistantStream.append(event.delta, event.partId, event.messageId));
    } else if (event.kind === "text_end") {
      this.assistantStream.breakSegment();
    } else if (event.kind === "reasoning_start") {
      this.currentToolGroup = undefined;
      this.assistantStream.breakSegment();
      this.updateActivity("thinking…", false);
    } else if (event.kind === "reasoning_delta") {
      this.currentToolGroup = undefined;
      this.assistantStream.breakSegment();
      this.updateActivity("thinking…", false);
      if (event.delta && (this.currentThinking || event.delta.trim())) {
        this.appendThinking(event.delta, event.partId, event.messageId);
      }
    } else if (event.kind === "reasoning_end") {
      this.completeThinking(event.partId);
    } else if (event.kind === "tool_input_start") {
      const tool = this.ensureToolView(event.toolCallId, event.toolName, event.partId, event.messageId);
      this.updateToolView(tool, "preparing");
      this.updateActivity(`preparing ${tool.name}…`, false);
    } else if (event.kind === "tool_input_delta" && event.delta) {
      const tool = this.ensureToolView(event.toolCallId, event.toolName, event.partId, event.messageId);
      tool.inputText += event.delta;
      this.updateToolView(tool, "preparing");
    } else if (event.kind === "tool_input_end") {
      const tool = this.ensureToolView(event.toolCallId, event.toolName, event.partId, event.messageId);
      this.updateToolView(tool, "prepared");
    } else if (event.kind === "tool_call" || event.kind === "scheduled" || event.kind === "started") {
      const tool = this.ensureToolView(event.toolCallId, event.toolName, event.partId, event.messageId);
      if (event.input !== undefined) tool.input = event.input;
      this.updateToolView(tool, event.kind === "scheduled" ? "queued" : "running", undefined, undefined, event.progress);
      this.updateActivity(`running ${tool.name}…`, false);
    } else if (event.kind === "progress") {
      const tool = this.ensureToolView(event.toolCallId, event.toolName, event.partId, event.messageId);
      this.updateToolView(tool, "running", event.result, undefined, event.progress);
    } else if (event.kind === "result") {
      const tool = this.ensureToolView(event.toolCallId, event.toolName, event.partId, event.messageId);
      this.updateToolView(tool, toolSucceeded(event.result) ? "complete" : "failed", event.result, undefined, event.progress);
    } else if (event.kind === "error" && (event.toolCallId || event.toolName)) {
      const tool = this.ensureToolView(event.toolCallId, event.toolName, event.partId, event.messageId);
      this.updateToolView(tool, "failed", event.result, event.error, event.progress);
    } else if (event.kind === "closed" && (event.toolCallId || event.toolName)) {
      const tool = this.ensureToolView(event.toolCallId, event.toolName, event.partId, event.messageId);
      if (!tool.view.isTerminal()) this.updateToolView(tool, "complete", event.result, event.error, event.progress);
    } else if (event.kind === "error") {
      this.addSystemEvent({
        tone: "error",
        title: "Model stream failed",
        detail: event.error instanceof Error ? event.error.message : asString(event.error) ?? event.message
      });
    } else if (event.type === "model_request_started") {
      this.updateActivity(
        event.attempt !== undefined && event.attempt > 1
          ? `retrying model request · ${modelRetryProgress(event, "started")}…`
          : "waiting for model…",
        false
      );
    } else if (event.type === "turn.failed") {
      this.finalizeUnresolvedTools("failed", event.message ?? "Turn failed.");
      this.addSystemEvent({ tone: "error", title: "Turn failed", detail: event.message });
    } else if (event.type === "model_retry_scheduled" || event.type === "streamRecovery.updated") {
      const retry = modelRetryProgress(event, "scheduled");
      const delay = event.delayMs !== undefined ? `in ${Math.ceil(event.delayMs / 1_000)}s` : undefined;
      this.updateActivity(
        ["retrying model request", retry, delay].filter(Boolean).join(" · ") + "…",
        false
      );
      this.addSystemEvent({
        tone: "warning",
        title: event.type === "streamRecovery.updated" ? "Recovering model stream" : "Retrying model request",
        summary: [retry, delay].filter(Boolean).join(" · "),
        detail: event.message
      });
    } else if (event.type === "model_request_failed") {
      this.updateActivity(
        event.retryable === true ? "model request failed · waiting to retry…" : "model request failed…",
        false
      );
      if (event.retryable !== true) {
        this.addSystemEvent({ tone: "error", title: "Model request failed", detail: event.message });
      }
    } else if (event.type === "model_stream_stalled") {
      this.updateActivity("model stream stalled · waiting to retry…", false);
      const idle = event.idleMs !== undefined ? `idle ${Math.ceil(event.idleMs / 1_000)}s` : undefined;
      this.addSystemEvent({
        tone: "warning",
        title: "Model stream stalled",
        summary: idle,
        detail: event.message
      });
    } else if (event.type === "model_request_completed") {
      this.updateActivity("processing model response…", false);
    } else if (event.type === "compact_boundary" || event.type === "session_compacted") {
      this.addSystemEvent({
        tone: "muted",
        title: "Conversation compacted",
        summary: "Earlier context remains in transcript history"
      });
    } else if (event.type === "rewind.triggered") {
      this.addSystemEvent({ tone: "muted", title: "Conversation rewound", detail: event.message });
    }
    this.requestStreamRender();
  }

  private handleProtocolPartEvent(event: StreamEvent): boolean {
    if ((event.type === "part.started" || event.type === "part.upserted") && event.part) {
      this.upsertProtocolPart(event.part);
      return true;
    }
    if (event.type === "part.delta" && event.partId && event.delta !== undefined) {
      this.applyProtocolPartDelta(event.partId, event.field, event.delta, event.messageId);
      return true;
    }
    if (event.type === "part.removed" && event.partId) {
      this.removeProtocolPart(event.partId);
      return true;
    }
    if (event.type === "message.removed" && event.messageId) {
      this.removeProtocolMessage(event.messageId);
      return true;
    }
    return false;
  }

  private upsertProtocolPart(part: RestoredPart): void {
    if (part.partId) {
      this.protocolPartKinds.set(part.partId, part.type);
      if (part.messageId) this.protocolPartMessages.set(part.partId, part.messageId);
    }

    if (part.type === "text") {
      if (part.partId) {
        this.recordAssistantText(this.assistantStream.upsert(part.text, part.partId, part.messageId));
      } else if (part.text) {
        this.addAssistantMessage(part.text);
      }
      return;
    }

    if (part.type === "thought") {
      if (!part.partId) return;
      let view = this.thinkingParts.get(part.partId);
      if (!view) {
        view = new ThinkingView(this.theme);
        this.thinkingParts.set(part.partId, view);
        this.transcript.addBlock(view, {
          id: part.partId,
          kind: "thinking",
          messageId: part.messageId
        });
      }
      view.setText(part.text);
      this.currentThinking = view;
      this.currentThinkingPartId = part.partId;
      this.currentToolGroup = undefined;
      return;
    }

    if (part.type === "tool") {
      const toolId = part.toolCallId ?? part.partId;
      if (!toolId) return;
      const tool = this.ensureToolView(toolId, part.toolName, part.partId, part.messageId);
      if (part.input !== undefined) tool.input = part.input;
      const result = part.resultDisplay !== undefined
        ? { output: part.output, display: part.resultDisplay }
        : part.output;
      this.updateToolView(tool, restoredToolState(part.status), result, part.error, {
        parentToolCallId: part.parentToolCallId,
        childToolCallId: part.childToolCallId,
        agentId: part.agentId,
        agentType: part.agentType,
        childSessionId: part.childSessionId
      });
      if (part.partId) this.protocolPartTools.set(part.partId, tool.id);
      return;
    }

    if (!part.partId || !isVisibleProtocolPart(part)) return;
    const existing = this.protocolPartViews.get(part.partId);
    if (existing) {
      existing.update(part);
      if (part.messageId) this.transcript.associateBlockWithMessage(part.partId, part.messageId);
    } else {
      const view = new ProtocolPartView(this.theme, part);
      this.protocolPartViews.set(part.partId, view);
      this.transcript.addBlock(view, {
        id: part.partId,
        kind: part.type,
        messageId: part.messageId
      });
    }
    this.currentToolGroup = undefined;
  }

  private applyProtocolPartDelta(
    partId: string,
    field: StreamEvent["field"],
    delta: string,
    messageId?: string
  ): void {
    const kind = this.protocolPartKinds.get(partId);
    if (messageId) this.protocolPartMessages.set(partId, messageId);
    if (field === "text" || (!field && kind === "text")) {
      this.recordAssistantText(this.assistantStream.append(delta, partId, messageId));
      return;
    }
    if (field === "reasoning" || (!field && kind === "thought")) {
      this.appendThinking(delta, partId, messageId);
      return;
    }
    if (field !== "input" && field !== "output") return;
    const toolId = this.protocolPartTools.get(partId);
    const tool = toolId ? this.toolViews.get(toolId) : undefined;
    if (!tool) return;
    if (field === "input") {
      tool.inputText += delta;
      this.updateToolView(tool, tool.state === "queued" ? "queued" : "preparing");
    } else {
      tool.result = `${typeof tool.result === "string" ? tool.result : ""}${delta}`;
      this.updateToolView(tool, "running", tool.result);
    }
  }

  private removeProtocolPart(partId: string): void {
    this.assistantStream.removePart(partId);
    const thinking = this.thinkingParts.get(partId);
    if (thinking) {
      this.thinkingParts.delete(partId);
      if (this.currentThinking === thinking) {
        this.currentThinking = undefined;
        this.currentThinkingPartId = undefined;
      }
    }
    this.protocolPartViews.delete(partId);

    const toolId = this.protocolPartTools.get(partId);
    const tool = toolId ? this.toolViews.get(toolId) : undefined;
    if (tool) {
      this.promoteToolChildren(tool);
      this.detachToolFromLocation(tool);
      this.toolViews.delete(tool.id);
      this.pendingToolParents.delete(tool.id);
      for (const [childId, parentId] of [...this.pendingToolParents]) {
        if (parentId === tool.id) this.pendingToolParents.delete(childId);
      }
    } else {
      this.transcript.removeBlock(partId);
    }

    this.protocolPartKinds.delete(partId);
    this.protocolPartMessages.delete(partId);
    this.protocolPartTools.delete(partId);
  }

  private removeProtocolMessage(messageId: string): void {
    const partIds = Array.from(this.protocolPartMessages.entries())
      .filter(([, candidate]) => candidate === messageId)
      .map(([partId]) => partId);
    for (const partId of partIds) this.removeProtocolPart(partId);
    this.transcript.removeMessage(messageId);
  }

  private beginTurn(prompt?: string): void {
    this.completeThinking();
    this.assistantStream.beginTurn();
    this.turnAssistantText = "";
    this.inputQueue.resetAutoSend();
    this.pendingTurnNotification = undefined;
    this.pendingTurnNotificationDetail = "";
    this.currentToolGroup = undefined;
    this.turnDiffs.beginTurn(prompt);
    this.turnStartedAt = Date.now();
    this.turnElapsedMilliseconds = 0;
    this.turnTimingVisible = true;
    if (this.turnTimer) clearInterval(this.turnTimer);
    this.turnTimer = setInterval(
      () => this.updateTurnStatus(this.streamRenderTimer === undefined),
      TURN_TIMER_FRAME_DURATION_MS
    );
    this.turnTimer.unref?.();
    this.rescheduleRuntimePoll();
    this.updateTurnStatus();
  }

  private clearTranscriptProjection(): void {
    this.transcript.clear();
    this.assistantStream.clear();
    this.currentThinking = undefined;
    this.currentThinkingPartId = undefined;
    this.thinkingParts.clear();
    this.protocolPartViews.clear();
    this.protocolPartKinds.clear();
    this.protocolPartMessages.clear();
    this.protocolPartTools.clear();
    this.toolViews.clear();
    this.pendingToolParents.clear();
    this.pendingToolProgress.clear();
    this.turnDiffs.clear();
    this.currentToolGroup = undefined;
    this.currentToolGroupBlockId = undefined;
    this.currentToolGroupMessageId = undefined;
  }

  private appendThinking(delta: string, partId?: string, messageId?: string): void {
    if (partId) {
      let view = this.thinkingParts.get(partId);
      if (!view) {
        view = new ThinkingView(this.theme);
        this.thinkingParts.set(partId, view);
        this.protocolPartKinds.set(partId, "thought");
        if (messageId) this.protocolPartMessages.set(partId, messageId);
        this.transcript.addBlock(view, { id: partId, kind: "thinking", messageId });
      }
      this.currentThinking = view;
      this.currentThinkingPartId = partId;
    } else if (!this.currentThinking || this.currentThinkingPartId) {
      this.currentThinking = new ThinkingView(this.theme);
      this.currentThinkingPartId = undefined;
      this.transcript.addBlock(this.currentThinking, { kind: "thinking", messageId });
    }
    this.currentThinking.append(delta);
  }

  private completeThinking(partId?: string): void {
    const thinking = partId ? this.thinkingParts.get(partId) : this.currentThinking;
    if (!thinking) return;
    thinking.complete();
    if (this.currentThinking === thinking) {
      this.currentThinking = undefined;
      this.currentThinkingPartId = undefined;
    }
  }

  private addUserMessage(text: string, attachmentCount = 0, messageId?: string): void {
    const safeText = sanitizeTerminalText(text, { preserveSgr: false });
    const suffix = attachmentCount > 0 ? `  [${attachmentCount} image${attachmentCount === 1 ? "" : "s"}]` : "";
    this.currentToolGroup = undefined;
    this.transcript.addBlock(
      new Text(`${this.theme.accent("›")} ${safeText}${this.theme.muted(suffix)}`, 1, 0),
      { kind: "user", messageId, searchText: safeText }
    );
    this.ui.requestRender();
  }

  private addAssistantMessage(text: string, partId?: string, messageId?: string): void {
    this.currentToolGroup = undefined;
    this.transcript.addBlock(new RichMarkdown(text, 1, this.theme), {
      id: partId,
      kind: "assistant",
      messageId
    });
    this.recordAssistantText(text);
    this.ui.requestRender();
  }

  private recordAssistantText(text: string): void {
    this.lastAssistantText = text;
    if (this.turnStartedAt !== undefined) this.turnAssistantText = text;
  }

  private addNotice(
    text: string,
    style: "warning" | "error" | "muted",
    partId?: string,
    messageId?: string
  ): void {
    const safeText = sanitizeTerminalText(text, { preserveSgr: false });
    this.currentToolGroup = undefined;
    this.transcript.addBlock(new Text(this.theme[style](safeText), 1, 0), {
      id: partId,
      kind: "notice",
      messageId,
      searchText: safeText
    });
    this.ui.requestRender();
  }

  private addSystemEvent(event: SystemEventData): void {
    this.currentToolGroup = undefined;
    this.transcript.addBlock(new SystemEventView(this.theme, event), { kind: "system-event" });
    this.ui.requestRender();
  }

  private addUpdateAvailable(currentVersion: string, latestVersion: string): void {
    this.currentToolGroup = undefined;
    this.transcript.addBlock(new UpdateAvailableView(this.theme, currentVersion, latestVersion), {
      kind: "update",
      searchText: `Update available: ${currentVersion} -> ${latestVersion}\n${updateCommand}`
    });
    this.ui.requestRender();
  }

  private startUpdateRefresh(updateCheck: StartupUpdateCheck | undefined): void {
    if (!updateCheck?.refreshRequired || !this.distributionVersion) return;
    const controller = new AbortController();
    this.updateCheckAbortController = controller;
    void refreshUpdateCache({
      cachePath: updateCheck.cachePath,
      currentVersion: this.distributionVersion,
      signal: controller.signal
    }).catch(() => {
      // Update discovery is optional and must never interrupt the TUI.
    }).finally(() => {
      if (this.updateCheckAbortController === controller) this.updateCheckAbortController = undefined;
    });
  }

  private ensureToolView(
    toolCallId?: string,
    toolName?: string,
    partId?: string,
    messageId?: string
  ): ToolViewState {
    const anonymous = !toolCallId
      ? Array.from(this.toolViews.values()).findLast((tool) => tool.name === (toolName ?? "tool") && !tool.view.isTerminal())
      : undefined;
    if (anonymous) {
      if (partId) {
        anonymous.partId = partId;
        this.protocolPartTools.set(partId, anonymous.id);
        this.protocolPartKinds.set(partId, "tool");
        if (messageId) this.protocolPartMessages.set(partId, messageId);
      }
      if (messageId) {
        anonymous.messageId = messageId;
        this.transcript.associateBlockWithMessage(anonymous.blockId, messageId);
      }
      return anonymous;
    }
    const id = toolCallId ?? partId ?? `${toolName ?? "tool"}-${this.toolViews.size}`;
    const existing = this.toolViews.get(id);
    if (existing) {
      if (toolName) existing.name = toolName;
      if (partId) {
        existing.partId = partId;
        this.protocolPartTools.set(partId, existing.id);
        this.protocolPartKinds.set(partId, "tool");
      }
      if (messageId) {
        existing.messageId = messageId;
        this.transcript.associateBlockWithMessage(existing.blockId, messageId);
      }
      this.attachPendingToolRelationships(existing);
      return existing;
    }
    const view = new ToolExecutionView(this.theme, {
      name: toolName ?? "tool",
      state: "preparing"
    });
    const tree = new ToolTreeView(this.theme, view);
    let blockId: string;
    let group: ToolGroupView | undefined;
    if (isGroupedInformationTool(toolName ?? "tool")) {
      if (!this.currentToolGroup || (messageId && this.currentToolGroupMessageId !== messageId)) {
        this.currentToolGroup = new ToolGroupView(this.theme);
        this.currentToolGroupMessageId = messageId;
        this.currentToolGroupBlockId = this.transcript.addBlock(this.currentToolGroup, {
          kind: "tool-group",
          messageId
        });
      }
      group = this.currentToolGroup;
      blockId = this.currentToolGroupBlockId!;
      group.addTool(view);
    } else {
      this.currentToolGroup = undefined;
      this.currentToolGroupBlockId = undefined;
      this.currentToolGroupMessageId = undefined;
      blockId = this.transcript.addBlock(tree, {
        id: partId ?? id,
        kind: "tool",
        messageId
      });
    }
    const tool: ToolViewState = {
      id,
      blockId,
      name: toolName ?? "tool",
      view,
      tree,
      group,
      nested: false,
      messageId,
      partId,
      inputText: "",
      state: "preparing"
    };
    this.toolViews.set(id, tool);
    if (partId) {
      this.protocolPartTools.set(partId, id);
      this.protocolPartKinds.set(partId, "tool");
      if (messageId) this.protocolPartMessages.set(partId, messageId);
    }
    this.attachPendingToolRelationships(tool);
    const pendingProgress = this.pendingToolProgress.get(tool.id);
    if (pendingProgress) {
      this.pendingToolProgress.delete(tool.id);
      this.updateToolView(tool, tool.state, undefined, undefined, pendingProgress);
    }
    return tool;
  }

  private updateToolView(
    tool: ToolViewState,
    state: string,
    result?: unknown,
    error?: unknown,
    progress?: ToolProgressData
  ): void {
    tool.state = state;
    if (result !== undefined) tool.result = result;
    if (error !== undefined) tool.error = error;
    if (progress) tool.progress = { ...tool.progress, ...progress };
    if (progress?.parentToolCallId) this.setToolParent(tool, progress.parentToolCallId);
    if (progress?.childToolCallId) {
      const child = this.toolViews.get(progress.childToolCallId);
      if (child) this.setToolParent(child, tool.id);
      else this.pendingToolParents.set(progress.childToolCallId, tool.id);
    }
    tool.view.update({
      name: tool.name,
      state,
      input: tool.input,
      inputText: tool.inputText,
      result: tool.result,
      error: tool.error,
      progress: tool.progress
    });
    if (["complete", "completed", "success"].includes(state.toLowerCase()) && toolSucceeded(tool.result)) {
      this.turnDiffs.upsertTool(tool.id, fileDiffsForTool(tool.name, tool.input, tool.result, state));
    }
  }

  private attachPendingToolRelationships(tool: ToolViewState): void {
    const parentId = this.pendingToolParents.get(tool.id) ?? tool.parentToolCallId;
    if (parentId) this.setToolParent(tool, parentId);
    for (const [childId, candidateParentId] of [...this.pendingToolParents]) {
      if (candidateParentId !== tool.id) continue;
      const child = this.toolViews.get(childId);
      if (child) this.setToolParent(child, tool.id);
    }
  }

  private handleSubagentLifecycle(event: StreamEvent): boolean {
    if (event.type !== "subagent_spawned" && event.type !== "subagent_stopped") return false;
    const parentId = event.progress?.parentToolCallId;
    if (!parentId) return true;
    const progress = event.progress ?? {};
    const parent = this.toolViews.get(parentId);
    if (!parent) {
      this.pendingToolProgress.set(parentId, { ...this.pendingToolProgress.get(parentId), ...progress });
      return true;
    }
    this.updateToolView(parent, parent.state, undefined, undefined, progress);
    return true;
  }

  private setToolParent(tool: ToolViewState, parentToolCallId: string): void {
    if (!parentToolCallId || parentToolCallId === tool.id) return;
    const parent = this.toolViews.get(parentToolCallId);
    if (!parent) {
      this.pendingToolParents.set(tool.id, parentToolCallId);
      return;
    }
    if (this.toolRelationshipWouldCycle(tool.id, parent)) {
      this.pendingToolParents.delete(tool.id);
      return;
    }
    if (tool.nested && tool.parentToolCallId === parent.id
      && parent.tree.getChildren().includes(tool.tree)) {
      this.pendingToolParents.delete(tool.id);
      return;
    }

    this.detachToolFromLocation(tool);
    parent.tree.addChild(tool.tree);
    tool.parentToolCallId = parent.id;
    tool.nested = true;
    tool.group = undefined;
    this.pendingToolParents.delete(tool.id);
  }

  private toolRelationshipWouldCycle(childId: string, parent: ToolViewState): boolean {
    let current: ToolViewState | undefined = parent;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.id === childId) return true;
      visited.add(current.id);
      current = current.parentToolCallId ? this.toolViews.get(current.parentToolCallId) : undefined;
    }
    return false;
  }

  private detachToolFromLocation(tool: ToolViewState): void {
    if (tool.nested && tool.parentToolCallId) {
      this.toolViews.get(tool.parentToolCallId)?.tree.removeChild(tool.tree);
      tool.nested = false;
      tool.parentToolCallId = undefined;
      return;
    }
    if (tool.group) {
      tool.group.removeTool(tool.view);
      if (tool.group.size === 0) {
        this.transcript.removeBlock(tool.blockId);
        if (this.currentToolGroup === tool.group) this.currentToolGroup = undefined;
      }
      tool.group = undefined;
      return;
    }
    this.transcript.removeBlock(tool.blockId);
  }

  private attachToolAtRoot(tool: ToolViewState): void {
    tool.parentToolCallId = undefined;
    tool.nested = false;
    tool.group = undefined;
    tool.blockId = this.transcript.addBlock(tool.tree, {
      id: tool.partId ?? tool.id,
      kind: "tool",
      messageId: tool.messageId
    });
  }

  private promoteToolChildren(tool: ToolViewState): void {
    for (const childTree of [...tool.tree.getChildren()]) {
      const child = Array.from(this.toolViews.values()).find((candidate) => candidate.tree === childTree);
      if (!child) continue;
      tool.tree.removeChild(childTree);
      child.parentToolCallId = undefined;
      child.nested = false;
      this.attachToolAtRoot(child);
    }
  }

  private finalizeUnresolvedTools(state: string, error?: unknown): void {
    for (const tool of this.toolViews.values()) {
      if (!tool.view.isTerminal()) this.updateToolView(tool, state, undefined, error);
    }
  }

  private handleTranscriptSearch(argument: string): void {
    this.prepareTranscriptViewport();
    const normalized = argument.toLowerCase();
    let status;
    if (normalized === "clear" || normalized === "close") {
      this.transcript.clearSearch();
    } else if (normalized === "next") {
      status = this.transcript.nextSearchMatch(1);
    } else if (normalized === "prev" || normalized === "previous") {
      status = this.transcript.nextSearchMatch(-1);
    } else if (argument) {
      status = this.transcript.searchFor(argument);
    } else {
      this.addNotice("Usage: /search <text>|next|prev|clear", "muted");
      return;
    }
    this.updateMetadata();
    this.ui.requestRender(true);
    if (status?.total === 0) this.updateActivity(`no matches for ${JSON.stringify(status.query)}`);
    else this.updateActivity(undefined);
  }

  private handleTranscriptNavigation(argument: string): void {
    this.prepareTranscriptViewport();
    const command = argument.toLowerCase();
    if (!command || command === "latest") this.transcript.selectLatest();
    else if (command === "next") this.transcript.moveCursor(1);
    else if (command === "prev" || command === "previous") this.transcript.moveCursor(-1);
    else if (command === "close" || command === "clear") this.transcript.clearCursor();
    else {
      this.addNotice("Usage: /transcript next|prev|latest|close", "muted");
      return;
    }
    this.updateMetadata();
    this.ui.requestRender(true);
  }

  private prepareTranscriptViewport(): void {
    this.transcript.setNavigationViewportRows(Math.max(4, this.ui.terminal.rows - 10));
  }

  private restoreTranscript(messages: RestoredMessage[]): void {
    for (const message of messages) {
      this.currentToolGroup = undefined;
      this.currentToolGroupBlockId = undefined;
      this.currentToolGroupMessageId = undefined;
      this.assistantStream.breakSegment();
      if (message.role === "user") {
        const text = message.parts.map((part) => part.type === "text" || part.type === "file" ? part.text : "")
          .filter(Boolean)
          .join("\n");
        if (text) this.addUserMessage(text, 0, message.messageId);
        continue;
      }
      for (const part of message.parts) this.restorePart(part, message.role, message.messageId);
    }
    this.currentToolGroup = undefined;
    this.currentToolGroupBlockId = undefined;
    this.currentToolGroupMessageId = undefined;
    this.assistantStream.breakSegment();
  }

  private restorePart(part: RestoredPart, role: "assistant" | "system", fallbackMessageId?: string): void {
    const messageId = part.messageId ?? fallbackMessageId;
    const identifiedPart = messageId && !part.messageId ? { ...part, messageId } as RestoredPart : part;
    if (part.type === "text") {
      if (role === "assistant") {
        if (part.partId) {
          this.upsertProtocolPart(identifiedPart);
          this.assistantStream.breakSegment();
        } else {
          this.addAssistantMessage(part.text, undefined, messageId);
        }
      } else {
        this.addNotice(part.text, "muted", part.partId, messageId);
      }
      return;
    }
    if (part.type === "thought") {
      if (part.partId) {
        this.upsertProtocolPart(identifiedPart);
        this.completeThinking(part.partId);
      } else {
        const thinking = new ThinkingView(this.theme);
        thinking.setText(part.text);
        thinking.complete();
        this.transcript.addBlock(thinking, { kind: "thinking", messageId });
      }
      return;
    }
    if (part.type === "tool") {
      this.upsertProtocolPart(identifiedPart);
      return;
    }
    if (part.partId && isVisibleProtocolPart(part)) {
      this.upsertProtocolPart(identifiedPart);
      return;
    }
    if (part.type === "step-start" || part.type === "step-finish" || part.type === "snapshot" || part.type === "patch") {
      return;
    }
    const style = part.type === "retry" ? "warning" : "muted";
    this.addNotice(part.text, style, part.partId, messageId);
  }

  private queueCurrentEditorInput(): void {
    const input = this.editor.getText().trim();
    if (!input) return;
    this.editor.setText("");
    this.inputQueue.queueFollowUp(protectSubmission(input));
  }

  private editLatestQueuedFollowUp(): void {
    const submission = this.inputQueue.editLatestFollowUp();
    if (!submission) return;
    this.editor.setText(submission.input);
    this.ui.setFocus(this.editor);
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
      this.syncAttachmentBar();
      this.addNotice(`${attachmentSummary([attachment])}.`, "muted");
    } catch (error) {
      this.addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.updateActivity(undefined);
    }
  }

  private canEnterAttachmentSelection(): boolean {
    if (this.pendingAttachments.length === 0
      || this.activeSubmissions > 0
      || this.turnAbortController
      || this.editor.isShowingAutocomplete()) return false;
    const cursor = this.editor.getCursor();
    return cursor.line === 0 && cursor.col === 0;
  }

  private enterAttachmentSelection(): boolean {
    if (this.pendingAttachments.length === 0) return false;
    if (this.activeSubmissions > 0 || this.turnAbortController) {
      this.addNotice("Wait for the active turn before managing attachments.", "warning");
      return false;
    }
    if (!this.attachmentBar.activate()) return false;
    this.ui.setFocus(this.attachmentBar);
    this.ui.requestRender();
    return true;
  }

  private leaveAttachmentSelection(): void {
    this.attachmentBar.deactivate();
    this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private removePendingAttachment(index: number): void {
    if (index < 0 || index >= this.pendingAttachments.length) return;
    this.pendingAttachments.splice(index, 1);
    this.syncAttachmentBar();
  }

  private clearPendingAttachments(notify: boolean): void {
    this.pendingAttachments = [];
    this.syncAttachmentBar();
    if (notify) this.addNotice("Pending attachments cleared.", "muted");
  }

  private syncAttachmentBar(): void {
    const wasActive = this.attachmentBar.isActive();
    this.attachmentBar.setAttachments(this.pendingAttachments);
    if (wasActive && !this.attachmentBar.isActive()) this.ui.setFocus(this.editor);
    this.ui.requestRender();
  }

  private async requestPermission(requestValue: unknown, context?: unknown): Promise<unknown> {
    const request = isRecord(requestValue) ? requestValue : {};
    const contextRecord = isRecord(context) ? context : undefined;
    const signal = contextRecord?.abortSignal instanceof AbortSignal
      ? contextRecord.abortSignal
      : this.turnAbortController?.signal;
    const toolName = asString(request.toolName) ?? "tool";
    const toolCallId = asString(request.toolCallId) ?? asString(request.toolUseId) ?? asString(request.callId);
    const tool = toolCallId
      ? this.toolViews.get(toolCallId)
      : Array.from(this.toolViews.values()).findLast((candidate) => candidate.name === toolName && !candidate.view.isTerminal());
    if (tool) this.updateToolView(tool, "waiting_permission");

    let response: unknown;
    if (isAskUserQuestionTool(toolName)) {
      response = await this.requestUserQuestions(request.input, signal);
    } else if (isExitPlanModeTool(toolName)) {
      response = await this.requestPlanApproval(request.input, signal);
    } else {
      response = await this.requestToolPermission(request, toolName, signal);
    }

    if (tool) {
      const record = isRecord(response) ? response : undefined;
      const decision = asString(record?.decision)?.toLowerCase();
      const allowed = decision === "allow" || decision === "modify";
      this.updateToolView(tool, allowed ? "running" : decision === "deny" ? "rejected" : "cancelled");
    }
    return response;
  }

  private async requestToolPermission(
    request: Record<string, unknown>,
    toolName: string,
    signal?: AbortSignal
  ): Promise<unknown> {
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
      items.push(...defaultPermissionChoices(toolName, request.input).map((choice) => ({
        value: choice.value,
        label: choice.label,
        description: choice.description,
        payload: choice.response
      })));
    }
    const selected = await this.showChoice({
      title: `Permission · ${toolName}`,
      prompt: asString(request.reason) ?? `${toolName} requests permission to continue.`,
      items,
      signal,
      content: this.permissionPreview(toolName, request.input, asString(request.riskLevel))
    });
    if (!selected) return { decision: "deny", reason: "Cancelled by user" };
    if (selected.value === "deny_feedback") {
      const reason = await this.showTextPrompt({
        title: `Deny · ${toolName}`,
        prompt: "Tell ZCode what should change before retrying.",
        signal
      });
      return { decision: "deny", reason: reason?.trim() || "Denied by user" };
    }
    return selected.payload ?? { decision: "deny", reason: "Denied by user" };
  }

  private async requestUserQuestions(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const questions = parseUserQuestions(input);
    if (questions.length === 0) {
      return { decision: "deny", reason: "AskUserQuestion did not include any valid questions" };
    }

    const answers: Record<string, string> = {};
    for (const [index, question] of questions.entries()) {
      const answer = question.multiSelect
        ? await this.requestMultipleChoice(question, index, questions.length, signal)
        : await this.requestSingleChoice(question, index, questions.length, signal);
      if (!answer) return { decision: "deny", reason: "AskUserQuestion was cancelled" };
      answers[question.question] = answer;
    }
    return {
      decision: "modify",
      modifiedInput: answeredQuestionInput(input, answers),
      reason: "Questions answered interactively"
    };
  }

  private async requestSingleChoice(
    question: UserQuestion,
    index: number,
    total: number,
    signal?: AbortSignal
  ): Promise<string | null> {
    const selected = await this.showChoice({
      title: `${question.header} · ${index + 1}/${total}`,
      prompt: question.question,
      items: [
        ...question.options.map((option) => ({
          value: option.value,
          label: option.label,
          description: option.description,
          payload: option.label,
          preview: option.preview ? new RichMarkdown(option.preview, 1, this.theme) : undefined
        })),
        { value: "__other__", label: "Other…", description: "Enter a different answer" }
      ],
      signal
    });
    if (!selected) return null;
    if (selected.value !== "__other__") return typeof selected.payload === "string" ? selected.payload : selected.label;
    const custom = await this.showTextPrompt({
      title: question.header,
      prompt: question.question,
      signal
    });
    return custom?.trim() || null;
  }

  private async requestMultipleChoice(
    question: UserQuestion,
    index: number,
    total: number,
    signal?: AbortSignal
  ): Promise<string | null> {
    const selected = new Set<string>();
    let custom: string | undefined;
    while (!signal?.aborted) {
      const choice = await this.showChoice({
        title: `${question.header} · ${index + 1}/${total}`,
        prompt: `${question.question} Toggle choices, then select Done.`,
        items: [
          ...question.options.map((option) => ({
            value: option.value,
            label: `${selected.has(option.label) ? "[x]" : "[ ]"} ${option.label}`,
            description: option.description,
            payload: option.label,
            preview: option.preview ? new RichMarkdown(option.preview, 1, this.theme) : undefined
          })),
          {
            value: "__other__",
            label: `${custom ? "[x]" : "[ ]"} Other…`,
            description: custom || "Enter another answer"
          },
          {
            value: "__done__",
            label: "Done",
            description: `${selected.size + (custom ? 1 : 0)} selected`
          }
        ],
        signal
      });
      if (!choice) return null;
      if (choice.value === "__done__") {
        const values = [...selected, ...(custom ? [custom] : [])];
        if (values.length > 0) return values.join(", ");
        continue;
      }
      if (choice.value === "__other__") {
        const value = await this.showTextPrompt({
          title: question.header,
          prompt: question.question,
          initialValue: custom,
          signal
        });
        if (value?.trim()) custom = value.trim();
        continue;
      }
      const label = typeof choice.payload === "string" ? choice.payload : choice.label.replace(/^\[[ x]\]\s*/u, "");
      if (selected.has(label)) selected.delete(label);
      else selected.add(label);
    }
    return null;
  }

  private async requestPlanApproval(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const plan = planText(input);
    const selected = await this.showChoice({
      title: "Ready to implement?",
      prompt: "Review the plan and choose how ZCode should continue.",
      items: [
        { value: "approve", label: "Approve and continue", description: "Exit plan mode and start implementation" },
        {
          value: "approve_feedback",
          label: "Continue with instructions",
          description: "Send implementation guidance, then review the updated plan"
        },
        { value: "refine", label: "Keep planning", description: "Tell ZCode what to revise" },
        { value: "deny", label: "Cancel", description: "Stay in plan mode without feedback" }
      ],
      signal,
      contentLabel: "Plan",
      help: "Up/Down choose · Ctrl+O full plan · PgUp/PgDn scroll · Enter confirm · Esc cancel",
      content: plan ? new RichMarkdown(plan, 1, this.theme) : this.permissionPreview("ExitPlanMode", input)
    });
    if (!selected || selected.value === "deny") return { decision: "deny", reason: "Plan approval cancelled" };
    if (selected.value === "approve") return { decision: "allow", reason: "Plan approved" };

    const feedback = await this.showTextPrompt({
      title: selected.value === "refine" ? "Refine plan" : "Implementation instructions",
      prompt: selected.value === "refine"
        ? "What should ZCode change in the plan?"
        : "What should ZCode keep in mind while implementing?",
      signal
    });
    if (!feedback?.trim()) return { decision: "deny", reason: "Plan approval cancelled" };
    const reason = selected.value === "refine"
      ? feedback.trim()
      : `The plan is approved with these implementation instructions: ${feedback.trim()}`;
    // ExitPlanMode only queues a follow-up model turn when this source is present.
    return {
      decision: "deny",
      reason,
      reasonSource: "plan_approval_feedback"
    };
  }

  private permissionPreview(toolName: string, input: unknown, riskLevel?: string): Component {
    return new PermissionPreview(this.theme, toolName, input, riskLevel);
  }

  private async showSelection(selection: Record<string, unknown>): Promise<void> {
    const rawItems = Array.isArray(selection.items) ? selection.items : [];
    const commands = rawItems.flatMap((item, index) => {
      const parsed = parseSelectionCommand(item, index);
      return parsed ? [parsed] : [];
    });
    if (commands.some((command) => /^\/login\s+(?:zai|bigmodel)-/u.test(command.command))) {
      commands.push({
        command: customProviderHelpCommand,
        description: "Configure any supported endpoint in config.json without signing in",
        label: "Custom provider"
      });
    }
    const items: ChoiceItem[] = commands.map((parsed) => ({
      value: parsed.command,
      label: parsed.label,
      description: parsed.description,
      payload: parsed
    }));
    while (true) {
      const selected = await this.showChoice({
        title: asString(selection.title) ?? "Choose",
        prompt: asString(selection.prompt) ?? "Select an item.",
        help: asString(selection.help),
        items,
        selectedIndex: typeof selection.selectedIndex === "number" ? selection.selectedIndex : 0
      });
      const command = selected?.payload as SelectionCommand | undefined;
      if (!command?.command) return;
      if (command.command === customProviderHelpCommand) {
        this.addNotice(
          "Custom providers do not require login. Copy config.example.json to ~/.zcode/cli/config.json, "
          + "set provider kind, baseURL, apiKey and model IDs, then run /new. "
          + "See README: Custom provider without login.",
          "muted"
        );
        return;
      }
      if (!command.input) {
        const submission = selectionSubmission(command) ?? undefined;
        this.queuedSelectionCommand = shouldSuspendForLoginCommand(command.command) && submission
          ? { ...submission, externalLogin: true }
          : submission;
        return;
      }

      while (true) {
        const value = await this.showTextPrompt({
          title: command.input.primary ?? command.label,
          prompt: command.input.secondary ?? "Enter a value.",
          help: command.input.help,
          mask: command.input.mask,
          placeholder: command.input.placeholder
        });
        if (value === null) {
          if (command.input.cancelStatus) this.addNotice(command.input.cancelStatus, "muted");
          break;
        }
        const submission = selectionSubmission(command, value);
        if (submission) {
          this.queuedSelectionCommand = submission;
          return;
        }
        this.addNotice(command.input.emptyStatus ?? "A value is required.", "warning");
      }
    }
  }

  private async showCommandPicker(
    title: string,
    prompt: string,
    picker: PickerSpec,
    settingTarget?: SettingTarget
  ): Promise<boolean> {
    if (picker.items.length === 0) return false;
    const selected = await this.showChoice({
      title,
      prompt,
      items: picker.items.map((item) => ({ ...item, payload: item.command })),
      selectedIndex: picker.selectedIndex
    });
    if (typeof selected?.payload === "string") {
      if (settingTarget) await this.applySettingCommand(selected.payload, settingTarget);
      else await this.submit(selected.payload);
    }
    return true;
  }

  private async showConfiguration(): Promise<void> {
    let stored: NotificationSettings;
    try {
      stored = await readStoredNotificationSettings();
    } catch (error) {
      this.addNotice(error instanceof Error ? error.message : String(error), "error");
      return;
    }

    const methods: Array<{ value: NotificationMethod; label: string; description: string }> = [
      { value: "auto", label: "Automatic", description: "Use a supported terminal notification protocol, otherwise BEL" },
      { value: "osc9", label: "Terminal notification", description: "Use OSC 9 when supported, otherwise BEL" },
      { value: "native", label: "Desktop notification", description: "Use an installed platform notifier, otherwise BEL" },
      { value: "bel", label: "Terminal bell", description: "Emit BEL when the turn finishes" },
      { value: "off", label: "Off", description: "Do not send turn notifications" }
    ];
    const conditions: Array<{ value: NotificationCondition; label: string; description: string }> = [
      { value: "unfocused", label: "When terminal is unfocused", description: "Notify only while you are using another window" },
      { value: "always", label: "Always", description: "Notify even while the terminal is focused" }
    ];
    let selectedSettingIndex = 0;
    let feedback = "Changes save immediately · Esc closes settings";

    while (!this.stopped) {
      const effective = this.notifications.currentSettings();
      const diagnostics = this.notifications.diagnostics();
      const backend = notificationDeliveryLabel(effective.method, diagnostics.backend);
      const methodOverride = Boolean(process.env.ZCODE_TUI_NOTIFICATION_METHOD?.trim());
      const conditionOverride = Boolean(process.env.ZCODE_TUI_NOTIFICATION_CONDITION?.trim());
      const setting = await this.showChoice({
        title: "ZCode settings",
        prompt: feedback,
        help: "Up/Down choose · Enter open · Esc close settings",
        items: [
          {
            value: "notification-method",
            label: "Notification delivery",
            description: methodOverride
              ? `Current: ${backend} · Saved: ${stored.method} (environment override)`
              : `Current: ${backend}`
          },
          {
            value: "notification-condition",
            label: "When to notify",
            description: conditionOverride
              ? `Current: ${effective.condition} · Saved: ${stored.condition} (environment override)`
              : `Current: ${stored.condition}`
          }
        ],
        selectedIndex: selectedSettingIndex
      });
      if (!setting) return;

      selectedSettingIndex = setting.value === "notification-condition" ? 1 : 0;
      let next = stored;
      let changedLabel: string;
      let overridden = false;
      if (setting.value === "notification-method") {
        const selected = await this.showChoice({
          title: "Notification delivery",
          prompt: "Select how completed and failed turns notify you.",
          help: "Up/Down choose · Enter save · Esc back",
          items: methods,
          selectedIndex: Math.max(0, methods.findIndex((item) => item.value === stored.method))
        });
        if (!selected) {
          feedback = "No changes · Esc closes settings";
          continue;
        }
        next = { ...stored, method: selected.value as NotificationMethod };
        changedLabel = `Notification delivery: ${next.method}`;
        overridden = methodOverride;
      } else {
        const selected = await this.showChoice({
          title: "When to notify",
          prompt: "Select when completed and failed turns notify you.",
          help: "Up/Down choose · Enter save · Esc back",
          items: conditions,
          selectedIndex: Math.max(0, conditions.findIndex((item) => item.value === stored.condition))
        });
        if (!selected) {
          feedback = "No changes · Esc closes settings";
          continue;
        }
        next = { ...stored, condition: selected.value as NotificationCondition };
        changedLabel = `When to notify: ${next.condition}`;
        overridden = conditionOverride;
      }

      if (next.method === stored.method && next.condition === stored.condition) {
        feedback = `${changedLabel} · unchanged`;
        continue;
      }

      try {
        await writeNotificationSettings(next);
        stored = next;
        this.notifications.setSettings(notificationSettings(process.env, {
          ui: { notifications: stored }
        }));
        feedback = overridden
          ? `${changedLabel} saved · environment override remains active`
          : `${changedLabel} saved`;
      } catch (error) {
        this.addNotice(error instanceof Error ? error.message : String(error), "error");
        feedback = "Could not save the setting · select it to retry";
      }
    }
  }

  private handleRewindEscape(): void {
    if (this.rewindEscapePending) {
      this.clearRewindEscape();
      void this.showConversationRewind();
      return;
    }

    this.rewindEscapePending = true;
    this.updateActivity(rewindEscapeHint);
    if (this.rewindEscapeTimer) clearTimeout(this.rewindEscapeTimer);
    this.rewindEscapeTimer = setTimeout(() => this.clearRewindEscape(), doubleEscapeTimeoutMs);
    this.rewindEscapeTimer.unref?.();
  }

  private clearRewindEscape(): void {
    if (this.rewindEscapeTimer) {
      clearTimeout(this.rewindEscapeTimer);
      this.rewindEscapeTimer = undefined;
    }
    if (!this.rewindEscapePending) return;
    this.rewindEscapePending = false;
    if (this.activity === rewindEscapeHint) this.updateActivity(undefined);
  }

  private async showConversationRewind(): Promise<void> {
    if (this.rewindFlowActive) return;
    if (!this.options.loadSessionTranscript) {
      this.addNotice("Conversation rewind is unavailable in this runtime.", "warning");
      return;
    }

    this.rewindFlowActive = true;
    try {
      this.updateActivity("loading rewind points…");
      const targets = rewindTargets(await this.options.loadSessionTranscript());
      this.updateActivity(undefined);
      if (targets.length === 0) {
        this.addNotice("There are no previous user inputs to rewind to.", "muted");
        return;
      }

      while (true) {
        const selected = await this.showChoice({
          title: "Rewind conversation",
          prompt: "Choose the user input to return to. It will be restored to the editor.",
          help: "Type to filter · Up/Down choose · Enter continue · Esc cancel",
          items: targets.map((target, index) => ({
            value: target.messageId,
            label: rewindTargetLabel(target.text),
            description: index === 0 ? "Latest input" : `${index + 1} inputs back`,
            payload: target,
            preview: new Text(sanitizeTerminalText(target.text, { preserveSgr: false }), 1, 0)
          }))
        });
        const target = selected?.payload as RewindTarget | undefined;
        if (!target) return;

        this.updateActivity("checking workspace checkpoints…");
        let preview: FileRewindPreview | undefined;
        let previewError: string | undefined;
        if (this.options.previewFileRewind) {
          try {
            preview = fileRewindPreview(await this.options.previewFileRewind(target.checkpointMessageIds));
          } catch (error) {
            previewError = error instanceof Error ? error.message : String(error);
          }
        }
        this.updateActivity(undefined);

        const codeAvailable = Boolean(
          this.options.applyFileRewind && preview?.canApply && preview.safeFiles.length > 0
        );
        const actions: ChoiceItem[] = [
          ...(codeAvailable ? [{
            value: "both",
            label: "Conversation and workspace",
            description: `Restore the conversation and ${preview!.safeFiles.length} checkpointed file${preview!.safeFiles.length === 1 ? "" : "s"}`
          }] : []),
          {
            value: "conversation",
            label: "Conversation only",
            description: "Keep the current workspace files"
          },
          ...(codeAvailable ? [{
            value: "workspace",
            label: "Workspace only",
            description: "Restore checkpointed files without changing the conversation"
          }] : [])
        ];
        const action = await this.showChoice({
          title: "Choose rewind scope",
          prompt: `Return to before: ${rewindTargetLabel(target.text, 72)}`,
          help: "Up/Down choose · Enter rewind · Esc back",
          content: new Text(this.rewindFilePreviewText(preview, previewError), 1, 0),
          items: actions
        });
        if (!action) continue;
        await this.applyConversationRewind(target, action.value as RewindScope);
        return;
      }
    } catch (error) {
      this.addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      this.rewindFlowActive = false;
      if (this.activity?.includes("rewind")) this.updateActivity(undefined);
    }
  }

  private rewindFilePreviewText(preview: FileRewindPreview | undefined, error?: string): string {
    if (error) return this.theme.warning(`Workspace preview unavailable: ${error}`);
    if (!this.options.previewFileRewind || !this.options.applyFileRewind) {
      return this.theme.muted("Workspace rewind is unavailable in this runtime.");
    }
    if (!preview) return this.theme.muted("No workspace checkpoint information is available.");

    const lines: string[] = [];
    if (preview.safeFiles.length > 0) {
      const safeSummary = `${preview.safeFiles.length} checkpointed file${preview.safeFiles.length === 1 ? "" : "s"}`;
      lines.push(preview.canApply
        ? this.theme.success(`${safeSummary} can be restored`)
        : this.theme.muted(`${safeSummary} found`));
      lines.push(...preview.safeFiles.slice(0, 5).map((file) => `  ${file.action ?? "restore"} ${file.path}`));
      if (preview.safeFiles.length > 5) lines.push(`  … ${preview.safeFiles.length - 5} more`);
    } else {
      lines.push(this.theme.muted("No checkpointed file changes are available for this input."));
    }
    if (preview.unsafeFiles.length > 0) {
      lines.push(this.theme.warning(
        `${preview.unsafeFiles.length} file${preview.unsafeFiles.length === 1 ? "" : "s"} cannot be restored safely`
      ));
      lines.push(...preview.unsafeFiles.slice(0, 3).map((file) => (
        `  ${file.path} · ${file.reason ?? "unsafe"}`
      )));
    }
    if (preview.ignoredFiles.length > 0) {
      lines.push(this.theme.warning(
        `${preview.ignoredFiles.length} Bash/terminal file change${preview.ignoredFiles.length === 1 ? " is" : "s are"} not checkpointed`
      ));
    }
    return lines.join("\n");
  }

  private async applyConversationRewind(target: RewindTarget, scope: RewindScope): Promise<void> {
    let workspaceApplied = false;
    this.updateActivity("rewinding…");
    try {
      if (scope === "workspace" || scope === "both") {
        if (!this.options.applyFileRewind) throw new Error("Workspace rewind is unavailable.");
        const result = await this.options.applyFileRewind(target.checkpointMessageIds);
        if (!isRecord(result) || result.applied !== true) {
          throw new Error(responseText(result) ?? "Workspace files could not be rewound safely.");
        }
        workspaceApplied = true;
      }

      if (scope === "conversation" || scope === "both") {
        const result = await this.options.submitPrompt(rewindCommand("conversation", target.messageId), {
          inputId: `input_${crypto.randomUUID()}`,
          queryId: `query_${crypto.randomUUID()}`,
          onEvent: (event) => this.onEvent(event)
        });
        await this.handleResult(result, false);
        const transcript = await this.options.loadSessionTranscript?.();
        if (rewindTargets(transcript).some((message) => message.messageId === target.messageId)) {
          throw new Error("The runtime did not apply the requested conversation rewind.");
        }
        const restored = restoredMessages(transcript);
        this.clearTranscriptProjection();
        this.lastAssistantText = "";
        this.turnAssistantText = "";
        this.restoreTranscript(restored);
        this.editor.setText(target.text);
      }

      const label = scope === "both"
        ? "Conversation and workspace rewound. The selected input was restored to the editor."
        : scope === "conversation"
          ? "Conversation rewound. The selected input was restored to the editor."
          : "Workspace files rewound. Conversation history was kept.";
      this.addNotice(label, "muted");
      await this.refreshRuntimeState();
      void this.refreshGoal();
      void this.refreshSessionUsage();
      this.updateMetadata();
      this.ui.requestRender(true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        workspaceApplied && scope === "both"
          ? `Workspace files were rewound, but conversation rewind failed: ${detail}`
          : detail,
        { cause: error }
      );
    } finally {
      this.updateActivity(undefined);
    }
  }

  private shortcutAvailable(): boolean {
    if (this.settingSwitchInFlight) return false;
    if (this.activeSubmissions === 0) return true;
    this.addNotice("Wait for the active turn or press Ctrl+C before switching settings.", "warning");
    return false;
  }

  private async switchMode(): Promise<void> {
    if (!this.shortcutAvailable()) return;
    await this.applyModeShortcut(nextMode(this.mode));
  }

  private async applyModeShortcut(requestedMode: Mode): Promise<void> {
    if (this.settingSwitchInFlight) return;
    if (!this.options.setMode) {
      this.addNotice("Mode switching is unavailable in this runtime.", "warning");
      return;
    }
    this.settingSwitchInFlight = true;
    try {
      const result = await this.options.setMode(requestedMode);
      const returnedMode = isRecord(result) ? asString(result.mode) : asString(result);
      this.mode = normalizedMode(returnedMode, requestedMode);
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
    await this.applySettingCommand(command, "model");
  }

  private async switchEffort(): Promise<void> {
    if (!this.shortcutAvailable()) return;
    const command = nextPickerCommand(effortPicker(this.effortOptions, this.thoughtLevel), this.thoughtLevel);
    if (!command) {
      this.addNotice("No alternate reasoning effort is available.", "muted");
      return;
    }
    await this.applySettingCommand(command, "effort");
  }

  private async applySettingCommand(command: string, target: SettingTarget): Promise<void> {
    if (this.settingSwitchInFlight) return;
    this.settingSwitchInFlight = true;
    try {
      const result = await this.options.submitPrompt(command, {
        inputId: `input_${crypto.randomUUID()}`,
        queryId: `query_${crypto.randomUUID()}`
      });
      await this.handleResult(result, false, target);
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
    const text = sanitizeTerminalText(formatWorkflowPanel(value), { preserveSgr: false });
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

  private async showDiffBrowser(): Promise<void> {
    if (this.activeSubmissions > 0) {
      this.addNotice("Wait for the active turn or press Ctrl+C before opening diff.", "warning");
      return;
    }
    const workspaceDirectory = this.options.workspaceDirectory ?? process.cwd();
    const workspace = await readWorkspaceDiff(workspaceDirectory);
    const sources = diffBrowserSources(workspace, this.turnDiffs.snapshots());

    while (true) {
      const sourceChoice = await this.showChoice({
        title: "Diff",
        prompt: "Select current workspace changes or a completed turn.",
        items: sources.map((source) => ({
          value: source.id,
          label: source.label,
          description: source.description,
          payload: source
        }))
      });
      if (!sourceChoice) return;
      const source = sourceChoice.payload as DiffBrowserSource | undefined;
      if (!source) return;
      if (source.files.length === 0) {
        this.addNotice(source.id === "current" ? "Working tree is clean." : "No file changes in this turn.", "muted");
        continue;
      }

      let selectedFileIndex = 0;
      while (true) {
        const fileChoice = await this.showChoice({
          title: `Diff · ${source.label}`,
          prompt: source.description,
          selectedIndex: selectedFileIndex,
          items: source.files.map((file, index) => ({
            value: String(index),
            label: file.filePath,
            description: diffFileDescription(file),
            payload: index,
            preview: new FileDiffView(this.theme, {
              toolName: "Diff",
              state: "complete",
              diffs: [file]
            })
          }))
        });
        if (!fileChoice || typeof fileChoice.payload !== "number") break;
        selectedFileIndex = fileChoice.payload;

        let page = 0;
        while (true) {
          const file = source.files[selectedFileIndex];
          if (!file) break;
          const pageSize = Math.max(4, this.ui.terminal.rows - 18);
          const content = new DiffDetailPage(this.theme, file, page, pageSize);
          const pages = content.pageCount(Math.max(1, this.ui.terminal.columns));
          page = Math.min(page, pages - 1);
          const action = await this.showChoice({
            title: `Diff · ${file.filePath}`,
            prompt: diffFileDescription(file),
            content,
            items: [
              ...(page > 0 ? [{ value: "page-prev", label: "Previous page" }] : []),
              ...(page + 1 < pages ? [{ value: "page-next", label: "Next page" }] : []),
              ...(selectedFileIndex > 0 ? [{ value: "file-prev", label: "Previous file" }] : []),
              ...(selectedFileIndex + 1 < source.files.length ? [{ value: "file-next", label: "Next file" }] : []),
              { value: "back", label: "Back to files" },
              { value: "close", label: "Close diff" }
            ]
          });
          if (!action || action.value === "back") break;
          if (action.value === "close") return;
          if (action.value === "page-prev") page = Math.max(0, page - 1);
          if (action.value === "page-next") page = Math.min(pages - 1, page + 1);
          if (action.value === "file-prev") {
            selectedFileIndex = Math.max(0, selectedFileIndex - 1);
            page = 0;
          }
          if (action.value === "file-next") {
            selectedFileIndex = Math.min(source.files.length - 1, selectedFileIndex + 1);
            page = 0;
          }
        }
      }
    }
  }

  private async showContextDetails(): Promise<void> {
    await Promise.all([this.refreshRuntimeState(), this.refreshSessionUsage()]);
    await this.showChoice({
      title: "Context",
      prompt: "Current runtime context usage and source composition.",
      content: new ContextDetailView(this.theme, this.runtimeProjection?.contextUsage),
      items: [{ value: "close", label: "Close" }]
    });
  }

  private async showStatusDetails(): Promise<void> {
    await Promise.all([this.refreshRuntimeState(), this.refreshSessionUsage(), this.refreshGoal()]);
    const mcpSummary = await this.readMcpSummary();
    await this.showChoice({
      title: "Status",
      prompt: "Detailed session information. The compact statusline remains intentionally minimal.",
      content: new StatusDetailView(this.theme, {
        cliVersion: this.distributionVersion,
        version: this.options.version,
        model: this.model,
        mode: this.mode,
        effort: this.thoughtLevel,
        workspace: this.options.workspaceDirectory ?? process.cwd(),
        branch: this.options.workspaceGitBranch,
        locale: this.options.locale,
        developerMode: this.options.developerMode,
        projection: this.runtimeProjection,
        metrics: this.sessionMetrics,
        goal: this.goal,
        openTodos: this.todos.filter((todo) => todo.status !== "completed").length,
        mcpSummary
      }),
      items: [{ value: "close", label: "Close" }]
    });
  }

  private async readMcpSummary(): Promise<string | undefined> {
    if (!this.options.listMcpServers) return undefined;
    try {
      const value = await this.options.listMcpServers();
      if (!isRecord(value)) return undefined;
      const counts = new Map<string, number>();
      for (const server of Object.values(value)) {
        const status = isRecord(server) ? asString(server.status) ?? "unknown" : "unknown";
        counts.set(status, (counts.get(status) ?? 0) + 1);
      }
      return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(" · ") || "none configured";
    } catch {
      return "unavailable";
    }
  }

  private async showBackgroundTasks(): Promise<void> {
    await this.refreshRuntimeState();
    const jobs = [...(this.runtimeProjection?.backgroundJobs ?? [])]
      .sort((left, right) => Number(isActiveBackgroundJob(right)) - Number(isActiveBackgroundJob(left))
        || (right.startedAt ?? 0) - (left.startedAt ?? 0));
    if (jobs.length === 0) {
      this.addNotice("No background tasks.", "muted");
      return;
    }
    const selected = await this.showChoice({
      title: "Background tasks",
      prompt: "Select a task to inspect or stop.",
      items: jobs.map((job) => ({
        value: job.taskId,
        label: job.description ?? job.command ?? job.toolName ?? job.taskId,
        description: [job.status, job.taskId, job.pid ? `pid ${job.pid}` : undefined].filter(Boolean).join(" · "),
        payload: job
      }))
    });
    if (!selected || !isRecord(selected.payload)) return;
    const job = jobs.find((candidate) => candidate.taskId === selected.value);
    if (!job) return;

    const canStop = isActiveBackgroundJob(job) && job.cancellable !== false && Boolean(this.options.cancelBackgroundTask);
    const action = await this.showChoice({
      title: `Background task · ${job.taskId}`,
      prompt: job.blocked ? job.blockedReason ?? "This task is blocked." : `Status: ${job.status}.`,
      content: new Text(this.backgroundTaskDetail(job), 1, 0),
      items: [
        ...(canStop ? [{ value: "stop", label: "Stop task", description: "Request cancellation" }] : []),
        { value: "close", label: "Close", description: "Return to the prompt" }
      ]
    });
    if (action?.value === "stop") await this.stopBackgroundTask(job.taskId);
  }

  private async showActivityDetails(): Promise<void> {
    await this.refreshRuntimeState();
    const state = {
      projection: this.runtimeProjection,
      todos: this.todos,
      todoGroups: this.todoGroups
    };
    const detail = new RuntimeActivityView(this.theme, true);
    detail.update(state);
    if (detail.render(Math.max(1, this.ui.terminal.columns)).length <= 1) {
      this.addNotice("No active tools or open tasks.", "muted");
      return;
    }
    await this.showChoice({
      title: "Current activity",
      prompt: "Review active tools, background work and open tasks.",
      contentLabel: "Activity",
      content: detail,
      items: [{ value: "close", label: "Close" }]
    });
  }

  private backgroundTaskDetail(job: RuntimeBackgroundJob): string {
    const safe = (value: string | undefined): string | undefined => value
      ? sanitizeTerminalText(value, { preserveSgr: false })
      : undefined;
    const stderr = safe(job.stderrTail);
    const terminalId = safe(job.terminalId);
    const outputPath = safe(job.outputPath);
    const lines = [
      safe(job.description),
      safe(job.command),
      [
        safe(job.toolName),
        job.pid ? `pid ${job.pid}` : undefined,
        terminalId ? `terminal ${terminalId}` : undefined,
        job.outputBytes !== undefined ? `${job.outputBytes.toLocaleString()} output bytes` : undefined
      ].filter(Boolean).join(" · "),
      outputPath ? `Output: ${outputPath}` : undefined,
      job.outputTruncated ? "Output is truncated" : undefined,
      safe(job.stdoutTail),
      stderr ? this.theme.error(stderr) : undefined,
      safe(job.outputTail)
    ].filter((line): line is string => Boolean(line));
    return sanitizeTerminalText(lines.join("\n"), { preserveSgr: true });
  }

  private async stopBackgroundTask(taskId: string): Promise<void> {
    if (!taskId) {
      this.addNotice("Usage: /tasks stop <task-id>", "muted");
      return;
    }
    if (!this.options.cancelBackgroundTask) {
      this.addNotice("Background task cancellation is unavailable in this runtime.", "warning");
      return;
    }
    const job = this.runtimeProjection?.backgroundJobs.find((candidate) => candidate.taskId === taskId);
    if (job && !isActiveBackgroundJob(job)) {
      this.addNotice(`Background task ${taskId} is already ${job.status}.`, "muted");
      return;
    }
    if (job?.cancellable === false) {
      this.addNotice(`Background task ${taskId} cannot be cancelled.`, "warning");
      return;
    }
    if (job && this.runtimeProjection) {
      this.runtimeProjection = {
        ...this.runtimeProjection,
        backgroundJobs: this.runtimeProjection.backgroundJobs.map((candidate) => candidate.taskId === taskId
          ? { ...candidate, cancelRequestedAt: Date.now() }
          : candidate)
      };
      this.updateRuntimeActivity();
    }
    try {
      await this.options.cancelBackgroundTask(taskId);
      await this.refreshRuntimeState();
    } catch (error) {
      this.addNotice(error instanceof Error ? error.message : String(error), "error");
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

  private async showTextPrompt(options: Parameters<typeof promptText>[3]): Promise<string | null> {
    this.choiceDepth += 1;
    try {
      return await promptText(this.ui, this.choiceHost, this.theme, options);
    } finally {
      this.choiceDepth = Math.max(0, this.choiceDepth - 1);
      this.ui.setFocus(this.editor);
      this.ui.requestRender();
    }
  }

  private async copyLastResponse(): Promise<void> {
    const text = this.transcript.selectedText() ?? this.lastAssistantText;
    if (!text) {
      this.addNotice("There is no assistant response to copy.", "muted");
      return;
    }
    if (!this.options.writeClipboardText) {
      this.addNotice("Clipboard support is unavailable in this runtime.", "warning");
      return;
    }
    try {
      await this.options.writeClipboardText(text);
      this.addNotice(this.transcript.selectedText() ? "Copied the selected transcript block." : "Copied the latest assistant response.", "muted");
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

  private async restoreInitialTranscript(): Promise<void> {
    if (!this.options.loadSessionTranscript) return;
    try {
      this.restoreTranscript(restoredMessages(await this.options.loadSessionTranscript()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.addNotice(`Unable to restore session transcript: ${message}`, "warning");
    }
  }

  private updateMetadata(): void {
    const fields: StatusLineField[] = [
      {
        text: this.theme.muted(`◈ ${this.model}`),
        compactText: this.theme.muted(`◈ ${this.model}`),
        priority: 100,
        required: true
      },
      {
        text: this.theme.muted(`◉ ${this.mode}`),
        compactText: this.theme.muted(`◉ ${this.mode}`),
        priority: 70
      }
    ];
    if (this.thoughtLevel) {
      fields.push({
        text: this.theme.muted(`⚡ ${this.thoughtLevel}`),
        compactText: this.theme.muted(`⚡ ${this.thoughtLevel}`),
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
        text: style(`ctx ${remaining}% left`),
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
    const backgroundCount = this.runtimeProjection?.backgroundJobs.filter(isActiveBackgroundJob).length ?? 0;
    if (backgroundCount > 0) {
      fields.push({
        text: this.theme.accent(`${backgroundCount} in background`),
        compactText: this.theme.accent(`bg ${backgroundCount}`),
        priority: 80
      });
    }
    const search = this.transcript.searchStatus();
    if (search) {
      fields.push({
        text: this.theme.accent(`find ${search.current}/${search.total}: ${search.query}`),
        compactText: this.theme.accent(`find ${search.current}/${search.total}`),
        priority: 95
      });
    }
    const cursor = this.transcript.cursorStatus();
    if (cursor) {
      fields.push({
        text: this.theme.accent(`message ${cursor.current}/${cursor.total} · ${cursor.kind}`),
        compactText: this.theme.accent(`msg ${cursor.current}/${cursor.total}`),
        priority: 95
      });
    }
    if (this.transcript.isExpanded()) {
      fields.push({
        text: this.theme.muted("expanded transcript"),
        compactText: this.theme.muted("expanded"),
        priority: 10
      });
    }

    this.status.setFields(fields, this.theme.muted(" ─ "));
    this.ui.requestRender();
  }

  private updateActivity(activity: string | undefined, requestRender = true): void {
    this.activity = activity ? sanitizeTerminalText(activity, { preserveSgr: false }) : undefined;
    this.updateTurnStatus(requestRender);
  }

  private updateTurnStatus(requestRender = true): void {
    if (this.turnStartedAt !== undefined) {
      this.turnElapsedMilliseconds = Math.max(0, Date.now() - this.turnStartedAt);
    }
    const showElapsed = this.turnStartedAt !== undefined || (!this.activity && this.turnTimingVisible);
    const text = turnStatusText(
      this.activity,
      this.turnElapsedMilliseconds,
      showElapsed,
      this.turnStartedAt !== undefined && this.animateTurnTimer
    ) ?? "";
    const left = text
      ? this.activity ? this.theme.accent(text) : this.theme.muted(text)
      : "";
    const goalText = goalStatusText(this.goal);
    const goalLabel = goalStatusLabel(this.goal);
    const goalStyle = this.goal?.status === "complete"
      ? this.theme.success
      : this.goal?.status === "paused" || this.goal?.status === "budget_limited"
        ? this.theme.warning
        : this.theme.accent;
    const right = goalText ? goalStyle(`[ Goal: ${goalText} ]`) : undefined;
    const compactRight = goalLabel ? goalStyle(`[ Goal: ${goalLabel} ]`) : undefined;
    this.turnStatus.setContent(left, right, compactRight);
    this.updateRuntimeActivity(false);
    if (requestRender) this.ui.requestRender();
  }

  private requestStreamRender(): void {
    if (this.stopped || this.streamRenderTimer) return;
    this.streamRenderTimer = setTimeout(() => {
      this.streamRenderTimer = undefined;
      if (!this.stopped) this.ui.requestRender();
    }, streamRenderIntervalMs);
    this.streamRenderTimer.unref?.();
  }

  private cancelStreamRender(): void {
    if (!this.streamRenderTimer) return;
    clearTimeout(this.streamRenderTimer);
    this.streamRenderTimer = undefined;
  }

  private scheduleRuntimeRefresh(delay = 80): void {
    if (!this.options.readRuntimeProjection && !this.options.readTodos) return;
    if (this.runtimeRefreshTimer) return;
    this.runtimeRefreshTimer = setTimeout(() => {
      this.runtimeRefreshTimer = undefined;
      void this.refreshRuntimeState();
    }, delay);
    this.runtimeRefreshTimer.unref?.();
  }

  private scheduleRuntimePoll(delay = runtimePollInterval(this.turnStartedAt !== undefined)): void {
    if (this.stopped || (!this.options.readRuntimeProjection && !this.options.readTodos)) return;
    if (this.runtimePollTimer) return;
    this.runtimePollTimer = setTimeout(() => {
      this.runtimePollTimer = undefined;
      void this.refreshRuntimeState().finally(() => this.scheduleRuntimePoll());
    }, delay);
    this.runtimePollTimer.unref?.();
  }

  private rescheduleRuntimePoll(): void {
    if (this.runtimePollTimer) {
      clearTimeout(this.runtimePollTimer);
      this.runtimePollTimer = undefined;
    }
    this.scheduleRuntimePoll();
  }

  private applyRuntimeProjection(projection: RuntimeProjectionSnapshot | undefined): void {
    if (!projection) return;
    this.runtimeProjection = projection;
    if (projection.sessionId) this.sessionId = projection.sessionId;
    this.sessionMetrics = mergeMetrics(this.sessionMetrics, {
      contextUsed: projection.contextUsage?.used,
      contextWindow: projection.contextUsage?.size,
      totalTokens: projection.totalTokenCount,
      turnCount: projection.turnCount
    });
    this.updateRuntimeActivity(false);
  }

  private updateRuntimeActivity(requestRender = true): void {
    this.runtimeActivity.update({
      projection: this.runtimeProjection,
      todos: this.todos,
      todoGroups: this.todoGroups
    });
    if (requestRender) this.ui.requestRender();
  }

  private async refreshRuntimeState(): Promise<void> {
    if (!this.options.readRuntimeProjection && !this.options.readTodos) return;
    if (this.runtimeRefreshInFlight) {
      this.runtimeRefreshPending = true;
      return;
    }
    this.runtimeRefreshInFlight = true;
    try {
      do {
        this.runtimeRefreshPending = false;
        const [projectionResult, todosResult] = await Promise.allSettled([
          this.options.readRuntimeProjection?.(),
          this.options.readTodos?.()
        ]);
        const next: RuntimePollState = {
          projection: this.runtimeProjection,
          todos: this.todos,
          todoGroups: this.todoGroups
        };
        if (projectionResult.status === "fulfilled" && projectionResult.value !== undefined) {
          next.projection = normalizeRuntimeProjection(projectionResult.value) ?? next.projection;
          if (isRecord(projectionResult.value) && Array.isArray(projectionResult.value.todoGroups)) {
            next.todoGroups = normalizeTodoGroups(projectionResult.value);
          }
        }
        if (todosResult.status === "fulfilled" && todosResult.value !== undefined) {
          next.todos = normalizeTodos(todosResult.value);
        }
        const current: RuntimePollState = {
          projection: this.runtimeProjection,
          todos: this.todos,
          todoGroups: this.todoGroups
        };
        if (runtimePollStateChanged(current, next)) {
          this.todos = next.todos;
          this.todoGroups = next.todoGroups;
          if (next.projection) this.applyRuntimeProjection(next.projection);
          else this.updateRuntimeActivity(false);
          this.updateMetadata();
        }
      } while (this.runtimeRefreshPending);
    } finally {
      this.runtimeRefreshInFlight = false;
    }
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
          const usage = await this.options.readSessionUsage();
          this.applySessionUsage(usage);
          this.updateMetadata();
        } catch {
          // Usage is supplementary and must not interrupt the active turn.
        }
      } while (this.usageRefreshPending);
    } finally {
      this.usageRefreshInFlight = false;
    }
  }

  private applySessionUsage(usage: unknown): void {
    const sessionId = sessionIdFromUsage(usage);
    if (sessionId) this.sessionId = sessionId;
    this.sessionMetrics = mergeMetrics(this.sessionMetrics, usageMetrics(usage));
  }

  private async refreshExitUsage(): Promise<void> {
    const readSessionUsage = this.options.readSessionUsage;
    if (!readSessionUsage) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const usage = await Promise.race([
      Promise.resolve().then(() => readSessionUsage()).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), exitUsageQueryTimeoutMs);
      })
    ]);
    if (timeout) clearTimeout(timeout);
    if (usage !== undefined) this.applySessionUsage(usage);
  }

  private finishTurn(unfinishedToolState = "interrupted"): void {
    this.cancelStreamRender();
    const notification = this.pendingTurnNotification;
    const notificationDetail = notification === "completed"
      ? this.turnAssistantText
      : this.pendingTurnNotificationDetail;
    this.pendingTurnNotification = undefined;
    this.pendingTurnNotificationDetail = "";
    this.completeThinking();
    this.assistantStream.breakSegment();
    this.finalizeUnresolvedTools(unfinishedToolState);
    this.currentToolGroup = undefined;
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
    this.scheduleRuntimeRefresh(0);
    this.rescheduleRuntimePoll();
    if (notification) void this.notifications.notify(notification, notificationDetail);
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
    this.updateCheckAbortController?.abort();
    if (this.turnTimer) clearInterval(this.turnTimer);
    this.cancelStreamRender();
    if (this.rewindEscapeTimer) clearTimeout(this.rewindEscapeTimer);
    if (this.runtimeRefreshTimer) clearTimeout(this.runtimeRefreshTimer);
    if (this.runtimePollTimer) clearTimeout(this.runtimePollTimer);
    this.unsubscribeWorkflow?.();
    const elapsedMilliseconds = this.turnStartedAt === undefined
      ? this.turnElapsedMilliseconds
      : Math.max(0, Date.now() - this.turnStartedAt);
    this.notifications.stop();
    this.ui.stop();
    void this.finishStop(elapsedMilliseconds);
  }

  private async finishStop(elapsedMilliseconds: number): Promise<void> {
    await this.refreshExitUsage();
    const summary = buildExitSummary({
      elapsedMilliseconds,
      metrics: this.sessionMetrics,
      sessionId: this.sessionId ?? this.runtimeProjection?.sessionId,
      width: this.ui.terminal.columns
    });
    const lines = [
      summary.divider && this.theme.muted(summary.divider),
      summary.tokenUsage,
      summary.resumeCommand
        ? `To continue this session, run ${this.theme.accent(summary.resumeCommand)}`
        : undefined
    ].filter((line): line is string => Boolean(line));
    if (lines.length > 0) {
      try {
        (this.options.stdout ?? process.stdout).write(`${lines.join("\n")}\n`);
      } catch {
        // Exit diagnostics must not prevent terminal cleanup.
      }
    }
    this.resolveDone();
  }
}

export async function runTui(options: TuiOptions): Promise<void> {
  await new ZCodeTui(options).run();
}
