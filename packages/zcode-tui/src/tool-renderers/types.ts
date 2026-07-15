import type { ZCodeTheme } from "../theme.ts";

export interface ToolProgressData {
  elapsedMs?: number;
  durationMs?: number;
  pid?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputBytes?: number;
  stdoutTail?: string;
  stderrTail?: string;
  description?: string;
  progress?: number;
  total?: number;
  progressMessage?: string;
  parentToolCallId?: string;
  agentId?: string;
  agentType?: string;
  childSessionId?: string;
  childToolCallId?: string;
  totalToolUseCount?: number;
  totalTokens?: number;
  outputFile?: string;
  backgroundTaskId?: string;
}

export interface SpecializedToolRenderOptions {
  name: string;
  state: string;
  input: unknown;
  result: unknown;
  progress?: ToolProgressData;
  expanded: boolean;
  theme: ZCodeTheme;
}

export interface SpecializedToolRenderResult {
  displayName?: string;
  summary?: string;
  body?: string;
  consumesResult?: boolean;
  hiddenContent?: boolean;
}

export type ToolRenderer = (options: SpecializedToolRenderOptions) => SpecializedToolRenderResult;

export const officialToolNames = [
  "Read",
  "Write",
  "Edit",
  "ApplyPatch",
  "Bash",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "TodoWrite",
  "GoalRead",
  "ReadSessionContext",
  "AskUserQuestion",
  "SendMessage",
  "TaskStop",
  "Agent",
  "Task",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode"
] as const;

export type OfficialToolName = typeof officialToolNames[number];
export type CanonicalToolName = OfficialToolName | "MCP";
