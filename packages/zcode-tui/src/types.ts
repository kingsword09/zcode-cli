export type UnknownRecord = Record<string, unknown>;

export interface SlashCommandOption {
  name?: string;
  description?: string;
  summary?: string;
  inputHint?: string;
  argumentHint?: string;
  usage?: string;
}

export interface PromptCallOptions {
  abortSignal?: AbortSignal;
  delivery?: "auto" | "start_turn" | "steer_active_turn";
  /** Requested pending-input classification; steers need "guide" to be injected into the active turn. */
  queueDelivery?: "guide" | "queue";
  expectedTurnId?: string;
  inputId?: string;
  pendingInputReservationId?: string;
  pendingInputId?: string;
  queryId?: string;
  onEvent?: (event: unknown) => void | Promise<void>;
  requestPermission?: (request: unknown, context?: unknown) => Promise<unknown>;
}

export interface InterruptTurnOptions {
  pendingInputIds?: string[];
  reason?: string;
  reservationId?: string;
  waitForIdle?: boolean;
}

export interface WorkspacePathSuggestionRequest {
  token: string;
  limit?: number;
  abortSignal?: AbortSignal;
}

export interface WorkspacePathSuggestion {
  kind: "file" | "directory";
  path: string;
}

export interface WorkspacePathSuggestionResult {
  items: WorkspacePathSuggestion[];
  truncated: boolean;
}

export type ListWorkspacePathSuggestions = (
  request: WorkspacePathSuggestionRequest
) => Promise<WorkspacePathSuggestionResult>;

export interface SkillSuggestion {
  name: string;
  description?: string;
  qualifiedName?: string;
  whenToUse?: string;
  source?: string;
  scope?: string;
}

export interface SkillSuggestionResult {
  skills: SkillSuggestion[];
  diagnostics?: unknown[];
  totalDiscovered?: number;
}

export type ListSkills = () => Promise<SkillSuggestionResult>;

export type ListPluginReferences = () => Promise<unknown>;

/** Stable boundary consumed by the local TUI; upstream details stay in the bridge. */
export interface RuntimeAdapter {
  loadSessionTranscript?: () => Promise<unknown>;
  loadSessionContextMessages?: () => Promise<unknown>;
  listPluginReferences?: ListPluginReferences;
  listSkills?: ListSkills;
  listModelOptions?: () => Promise<unknown[]>;
  setTransientModel?: (modelId: string) => Promise<unknown>;
  recallPreviousInput?: (skip: number) => Promise<unknown>;
  readGoal?: () => Promise<unknown>;
  readTodos?: () => Promise<unknown>;
  readRuntimeProjection?: () => Promise<unknown>;
  readSessionUsage?: () => Promise<unknown>;
  cancelBackgroundTask?: (taskId: string) => Promise<unknown>;
  sendBackgroundTaskMessage?: (options: {
    taskId: string;
    message: string;
    summary: string;
    restart?: boolean;
  }) => Promise<unknown>;
  previewFileRewind?: (targetMessageIds: string[]) => Promise<unknown>;
  applyFileRewind?: (targetMessageIds: string[]) => Promise<unknown>;
  interruptTurn?: (options: InterruptTurnOptions) => Promise<unknown>;
  sendInput?: (input: unknown, options: PromptCallOptions) => Promise<unknown>;
  promoteQueuedInput?: (
    input: unknown,
    pendingInputIds: string[],
    options: PromptCallOptions
  ) => Promise<unknown>;
  submitPrompt: (input: unknown, options: PromptCallOptions) => Promise<unknown>;
  setMode?: (mode: string) => Promise<unknown>;
  listMcpServers?: () => Promise<unknown>;
  refreshWorkflowPanel?: (options: { runId?: string }) => Promise<unknown>;
  stopWorkflow?: (options: { runId: string }) => Promise<unknown>;
  subscribeWorkflowEvents?: (listener: (event: unknown) => void) => (() => void) | void;
  subscribeSessionEvents?: (listener: (event: unknown) => void | Promise<void>) => (() => void) | void;
}

export interface TuiOptions extends RuntimeAdapter {
  initialMode?: string;
  initialModel?: unknown;
  initialThoughtLevel?: string;
  initialTuiMode?: "regular" | "fullscreen";
  loginRequired?: boolean;
  locale?: string;
  theme?: string;
  developerMode?: boolean;
  version?: string;
  workspaceDirectory?: string;
  workspaceGitBranch?: string;
  noColor?: boolean;
  effortOptions?: unknown[];
  modelOptions?: unknown[];
  slashCommands?: SlashCommandOption[];
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  listWorkspacePathSuggestions?: ListWorkspacePathSuggestions;
  writeClipboardText?: (text: string) => Promise<void>;
  readClipboardImage?: (options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
