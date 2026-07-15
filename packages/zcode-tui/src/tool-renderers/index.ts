import type {
  OfficialToolName,
  SpecializedToolRenderOptions,
  SpecializedToolRenderResult,
  ToolRenderer
} from "./types.ts";
import { canonicalToolName } from "./registry.ts";
import { toolSummary } from "./helpers.ts";
import { mutationRender, readRender, searchRender } from "./filesystem.ts";
import { agentRender, bashRender, taskStopRender } from "./execution.ts";
import { goalReadRender, planModeRender, sessionContextRender, todoReadRender } from "./workflow.ts";
import { questionRender, sendMessageRender, skillRender } from "./interaction.ts";
import { mcpRender, webFetchRender, webSearchRender } from "./web.ts";

// Re-export public types and helpers so existing imports keep working.
export type {
  ToolProgressData,
  SpecializedToolRenderOptions,
  SpecializedToolRenderResult,
  OfficialToolName,
  CanonicalToolName
} from "./types.ts";
export { officialToolNames } from "./types.ts";
export {
  normalizeToolName,
  canonicalToolName,
  isKnownTool,
  isGroupedInformationTool,
  toolGroupKind
} from "./registry.ts";
export { recordString, oneLine, toolSummary } from "./helpers.ts";

const rendererRegistry: Record<OfficialToolName, ToolRenderer> = {
  Read: readRender,
  Write: mutationRender,
  Edit: mutationRender,
  ApplyPatch: mutationRender,
  Bash: bashRender,
  Glob: searchRender,
  Grep: searchRender,
  WebFetch: webFetchRender,
  WebSearch: webSearchRender,
  TodoRead: todoReadRender,
  TodoWrite: (options) => ({ displayName: "Plan", summary: toolSummary(options.name, options.input) }),
  GoalRead: goalReadRender,
  ReadSessionContext: sessionContextRender,
  AskUserQuestion: questionRender,
  SendMessage: sendMessageRender,
  TaskStop: taskStopRender,
  Agent: agentRender,
  Task: agentRender,
  Skill: skillRender,
  EnterPlanMode: planModeRender,
  ExitPlanMode: planModeRender
};

export function specializedToolRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult | undefined {
  const canonical = canonicalToolName(options.name);
  if (!canonical) return undefined;
  return canonical === "MCP" ? mcpRender(options) : rendererRegistry[canonical](options);
}
