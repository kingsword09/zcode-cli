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

export interface TuiOptions {
  initialMode?: string;
  initialModel?: unknown;
  initialThoughtLevel?: string;
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
  loadSessionTranscript?: () => Promise<unknown>;
  listPluginReferences?: ListPluginReferences;
  listWorkspacePathSuggestions?: ListWorkspacePathSuggestions;
  listSkills?: ListSkills;
  recallPreviousInput?: (skip: number) => Promise<unknown>;
  readGoal?: () => Promise<unknown>;
  readTodos?: () => Promise<unknown>;
  readRuntimeProjection?: () => Promise<unknown>;
  readSessionUsage?: () => Promise<unknown>;
  cancelBackgroundTask?: (taskId: string) => Promise<unknown>;
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
  writeClipboardText?: (text: string) => Promise<void>;
  readClipboardImage?: (options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
  listMcpServers?: () => Promise<unknown>;
  refreshWorkflowPanel?: (options: { runId?: string }) => Promise<unknown>;
  stopWorkflow?: (options: { runId: string }) => Promise<unknown>;
  subscribeWorkflowEvents?: (listener: (event: unknown) => void) => (() => void) | void;
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
