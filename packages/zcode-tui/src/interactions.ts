import { asString, isRecord, type UnknownRecord } from "./types.ts";

export interface UserQuestionOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface UserQuestion {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}

export interface PermissionChoice {
  value: string;
  label: string;
  description?: string;
  response: UnknownRecord;
}

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function isAskUserQuestionTool(name: string): boolean {
  return normalizedToolName(name) === "askuserquestion";
}

export function isExitPlanModeTool(name: string): boolean {
  const normalized = normalizedToolName(name);
  return normalized === "exitplanmode" || normalized === "exitplanmodev2";
}

export function parseUserQuestions(input: unknown): UserQuestion[] {
  if (!isRecord(input) || !Array.isArray(input.questions)) return [];
  return input.questions.flatMap((value): UserQuestion[] => {
    if (!isRecord(value) || !Array.isArray(value.options)) return [];
    const question = asString(value.question)?.trim();
    if (!question) return [];
    const options = value.options.flatMap((option, index): UserQuestionOption[] => {
      if (!isRecord(option)) return [];
      const label = asString(option.label)?.trim();
      if (!label) return [];
      return [{
        value: asString(option.value)?.trim() || label || String(index),
        label,
        description: asString(option.description)?.trim() || undefined,
        preview: asString(option.preview)?.trim() || undefined
      }];
    });
    if (options.length === 0) return [];
    return [{
      question,
      header: asString(value.header)?.trim() || "Question",
      options,
      multiSelect: value.multiSelect === true
    }];
  });
}

export function answeredQuestionInput(input: unknown, answers: Record<string, string>): UnknownRecord {
  return {
    ...(isRecord(input) ? input : {}),
    answers
  };
}

function permissionRuleContent(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (!isRecord(input)) return undefined;
  for (const key of ["command", "url", "file_path", "filePath", "path", "pattern"]) {
    const value = asString(input[key])?.trim();
    if (value) return value;
  }
  return undefined;
}

export function defaultPermissionChoices(toolName: string, input: unknown): PermissionChoice[] {
  const ruleContent = permissionRuleContent(input);
  return [
    {
      value: "allow_once",
      label: "Allow once",
      description: "Approve only this request",
      response: { decision: "allow", reason: "Approved once" }
    },
    {
      value: "allow_project",
      label: "Always allow in this project",
      description: ruleContent ? `Allow matching ${toolName} requests` : `Allow ${toolName} without asking again`,
      response: {
        decision: "allow",
        permissionUpdates: [{
          behavior: "allow",
          rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }],
          type: "addRules"
        }],
        reason: "Approved for this project"
      }
    },
    {
      value: "deny_feedback",
      label: "Deny and tell ZCode why",
      description: "Return feedback so the agent can adjust",
      response: { decision: "deny" }
    },
    {
      value: "deny",
      label: "Deny",
      response: { decision: "deny", reason: "Denied" }
    }
  ];
}

export function planText(input: unknown): string | undefined {
  if (typeof input === "string") return input.trim() || undefined;
  if (!isRecord(input)) return undefined;
  for (const key of ["plan", "content", "text", "markdown"]) {
    const value = asString(input[key])?.trim();
    if (value) return value;
  }
  return undefined;
}
