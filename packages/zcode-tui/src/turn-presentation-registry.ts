import type { RestoredPart } from "./events.ts";
import type { ProtocolPartView } from "./protocol-part-view.ts";
import type { ThinkingView } from "./thinking-view.ts";
import type { ToolProgressData } from "./tool-renderers.ts";

export interface TurnPresentationRegistrySizes {
  pendingToolParents: number;
  pendingToolProgress: number;
  protocolPartKinds: number;
  protocolPartMessages: number;
  protocolPartTools: number;
  protocolPartViews: number;
  thinkingParts: number;
  toolViews: number;
  total: number;
}

/**
 * Mutable indexes used only to reconcile presentation events for one turn.
 * Transcript components own settled history; starting another turn releases
 * these duplicate lookup roots without mutating the visible component tree.
 */
export class TurnPresentationRegistry<ToolState> {
  readonly thinkingParts = new Map<string, ThinkingView>();
  readonly protocolPartViews = new Map<string, ProtocolPartView>();
  readonly protocolPartKinds = new Map<string, RestoredPart["type"]>();
  readonly protocolPartMessages = new Map<string, string>();
  readonly protocolPartTools = new Map<string, string>();
  readonly toolViews = new Map<string, ToolState>();
  readonly pendingToolParents = new Map<string, string>();
  readonly pendingToolProgress = new Map<string, ToolProgressData>();

  beginTurn(): void {
    this.clear();
  }

  clear(): void {
    this.thinkingParts.clear();
    this.protocolPartViews.clear();
    this.protocolPartKinds.clear();
    this.protocolPartMessages.clear();
    this.protocolPartTools.clear();
    this.toolViews.clear();
    this.pendingToolParents.clear();
    this.pendingToolProgress.clear();
  }

  sizes(): TurnPresentationRegistrySizes {
    const sizes = {
      thinkingParts: this.thinkingParts.size,
      protocolPartViews: this.protocolPartViews.size,
      protocolPartKinds: this.protocolPartKinds.size,
      protocolPartMessages: this.protocolPartMessages.size,
      protocolPartTools: this.protocolPartTools.size,
      toolViews: this.toolViews.size,
      pendingToolParents: this.pendingToolParents.size,
      pendingToolProgress: this.pendingToolProgress.size
    };
    return {
      ...sizes,
      total: Object.values(sizes).reduce((sum, value) => sum + value, 0)
    };
  }
}
