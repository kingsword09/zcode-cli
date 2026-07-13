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
  inputId?: string;
  queryId?: string;
  onEvent?: (event: unknown) => void | Promise<void>;
  requestPermission?: (request: unknown, context?: unknown) => Promise<unknown>;
}

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
  recallPreviousInput?: (skip: number) => Promise<unknown>;
  sendInput?: (input: unknown, options: PromptCallOptions) => Promise<unknown>;
  submitPrompt: (input: unknown, options: PromptCallOptions) => Promise<unknown>;
  setMode?: (mode: string) => Promise<unknown>;
  writeClipboardText?: (text: string) => Promise<void>;
  subscribeWorkflowEvents?: (listener: (event: unknown) => void) => (() => void) | void;
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
