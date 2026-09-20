interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string; [key: string]: unknown };
}

interface Registry {
  validateSelection(selection: ModelSelection): { ok: boolean; code?: string };
  getModel(providerId: string, modelId: string): {
    config: { optionSpecs: { reasoningLevel: { values: readonly string[] } } };
  } | undefined;
}

export interface SessionModelState {
  model: string;
  selection?: ModelSelection;
  thoughtLevel?: string;
  effortOptions: readonly string[];
  issue?: { code: string; message: string };
}

/** sessionEntries already unwraps the stored modelSelection; legacy sibling fields are not authoritative. */
function inspectSelection(registry: Registry, value: unknown): SessionModelState {
  const selection = value && typeof value === "object" && !Array.isArray(value)
    && "providerId" in value && typeof value.providerId === "string" && value.providerId.trim()
    && "modelId" in value && typeof value.modelId === "string" && value.modelId.trim()
    ? value as ModelSelection : undefined;
  const model = selection ? `${selection.providerId}/${selection.modelId}` : "(not selected)";
  const validation = selection ? registry.validateSelection(selection) : { ok: false, code: "selection-missing" };
  const state: SessionModelState = {
    model, selection, thoughtLevel: selection?.options?.reasoningLevel,
    effortOptions: selection ? registry.getModel(selection.providerId, selection.modelId)?.config.optionSpecs.reasoningLevel.values ?? [] : []
  };
  if (validation.ok) return state;
  const code = validation.code ?? "selection-invalid";
  const reason = {
    "provider-not-found": "the provider is unavailable",
    "model-not-found": "the model is not in the current provider catalog",
    "reasoning-level-missing": "the reasoning level is missing",
    "reasoning-level-not-supported": "the saved reasoning level is no longer supported",
    "selection-missing": "no model selection was saved"
  }[code] ?? "the saved selection is invalid";
  return { ...state, issue: { code, message: `Saved model ${JSON.stringify(model)} cannot be used: ${reason}.` } };
}

/** Inspect without changing the session, its credentials, or the shared default. */
export async function readSessionModelState(options: {
  registry: Registry;
  sessionId: string;
  sessionStore: { sessionEntries(options: { sessionID: string; type: string }): Promise<Array<{ data: unknown }>> };
}): Promise<SessionModelState | undefined> {
  const entries = await options.sessionStore.sessionEntries({ sessionID: options.sessionId, type: "runtime/model_selection" });
  return entries.length ? inspectSelection(options.registry, entries.at(-1)?.data) : undefined;
}

/** Fail before model creation so headless callers retain the cause and recovery instructions. */
export function assertSessionModelReady(options: {
  registry: Registry;
  sessionId: string;
  currentSelection?: ModelSelection;
  restored?: { selection?: unknown };
}): void {
  if (!options.restored || options.currentSelection && options.registry.validateSelection(options.currentSelection).ok) return;
  const state = inspectSelection(options.registry, options.restored.selection);
  if (state.issue) throw new Error(`${state.issue.message} Resume interactively with zcode --resume ${options.sessionId} `
    + "and use /model to choose a replacement. No model request was sent.");
}
