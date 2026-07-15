import type { CanonicalToolName, OfficialToolName } from "./types.ts";

export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

const canonicalAliases = new Map<string, OfficialToolName>([
  ["read", "Read"],
  ["fileread", "Read"],
  ["write", "Write"],
  ["filewrite", "Write"],
  ["edit", "Edit"],
  ["fileedit", "Edit"],
  ["applypatch", "ApplyPatch"],
  ["patch", "ApplyPatch"],
  ["bash", "Bash"],
  ["shell", "Bash"],
  ["exec", "Bash"],
  ["glob", "Glob"],
  ["find", "Glob"],
  ["grep", "Grep"],
  ["searchtext", "Grep"],
  ["webfetch", "WebFetch"],
  ["fetch", "WebFetch"],
  ["websearch", "WebSearch"],
  ["todoread", "TodoRead"],
  ["todowrite", "TodoWrite"],
  ["goalread", "GoalRead"],
  ["readsessioncontext", "ReadSessionContext"],
  ["askuserquestion", "AskUserQuestion"],
  ["sendmessage", "SendMessage"],
  ["taskstop", "TaskStop"],
  ["killshell", "TaskStop"],
  ["killbash", "TaskStop"],
  ["agent", "Agent"],
  ["subagent", "Agent"],
  ["task", "Task"],
  ["skill", "Skill"],
  ["enterplanmode", "EnterPlanMode"],
  ["exitplanmode", "ExitPlanMode"],
  ["exitplanmodev2", "ExitPlanMode"]
]);

function isMcpToolName(name: string): boolean {
  return /^(?:mcp__|mcp[:./])/iu.test(name.trim());
}

export function canonicalToolName(name: string): CanonicalToolName | undefined {
  return canonicalAliases.get(normalizeToolName(name)) ?? (isMcpToolName(name) ? "MCP" : undefined);
}

export function isKnownTool(name: string): boolean {
  return canonicalToolName(name) !== undefined;
}

export function isGroupedInformationTool(name: string): boolean {
  const canonical = canonicalToolName(name);
  return canonical === "Read" || canonical === "Glob" || canonical === "Grep";
}

export function toolGroupKind(name: string): "read" | "search" | undefined {
  const canonical = canonicalToolName(name);
  if (canonical === "Read") return "read";
  if (canonical === "Glob" || canonical === "Grep") return "search";
  return undefined;
}

export function displayNameForMcp(name: string): string {
  const parts = name.trim().replace(/^mcp(?:__|[:./])/iu, "").split(/__|[:./]/u).filter(Boolean);
  return parts.length > 0 ? `MCP · ${parts.join("/")}` : "MCP";
}
