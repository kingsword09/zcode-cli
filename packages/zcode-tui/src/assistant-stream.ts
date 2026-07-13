import type { Component } from "@earendil-works/pi-tui";

import { RichMarkdown } from "./rich-markdown.ts";
import type { ZCodeTheme } from "./theme.ts";

interface AssistantBlockOptions {
  id?: string;
  messageId?: string;
  kind?: string;
}

interface AssistantSegment {
  view: RichMarkdown;
  text: string;
  messageId?: string;
}

export class AssistantStream {
  private current?: RichMarkdown;
  private currentText = "";
  private currentPartId?: string;
  private streamedText = "";
  private readonly partSegments = new Map<string, AssistantSegment>();

  constructor(
    private readonly theme: ZCodeTheme,
    private readonly addBlock: (component: Component, options?: AssistantBlockOptions) => void
  ) {}

  beginTurn(): void {
    this.current = undefined;
    this.currentText = "";
    this.currentPartId = undefined;
    this.streamedText = "";
  }

  clear(): void {
    this.beginTurn();
    this.partSegments.clear();
  }

  breakSegment(): void {
    this.current = undefined;
    this.currentText = "";
    this.currentPartId = undefined;
  }

  append(delta: string, partId?: string, messageId?: string): string {
    if (!delta) return this.streamedText;
    if (partId) {
      const segment = this.ensurePartSegment(partId, messageId);
      segment.text += delta;
      segment.view.setText(segment.text);
      this.current = segment.view;
      this.currentText = segment.text;
      this.currentPartId = partId;
    } else {
      if (!this.current || this.currentPartId) {
        this.current = new RichMarkdown("", 1, this.theme);
        this.addBlock(this.current, { kind: "assistant", messageId });
        this.currentPartId = undefined;
      }
      this.currentText += delta;
      this.current.setText(this.currentText);
    }
    this.streamedText += delta;
    return this.streamedText;
  }

  upsert(text: string, partId: string, messageId?: string): string {
    const segment = this.ensurePartSegment(partId, messageId);
    const previous = segment.text;
    segment.text = text;
    segment.view.setText(text);
    this.current = segment.view;
    this.currentText = text;
    this.currentPartId = partId;

    if (text.startsWith(previous)) {
      this.streamedText += text.slice(previous.length);
    } else if (previous && this.streamedText.endsWith(previous)) {
      this.streamedText = `${this.streamedText.slice(0, -previous.length)}${text}`;
    }
    return this.streamedText;
  }

  removePart(partId: string): void {
    const segment = this.partSegments.get(partId);
    if (!segment) return;
    this.partSegments.delete(partId);
    if (this.currentPartId === partId) this.breakSegment();
  }

  reconcile(response: string): string {
    if (!this.streamedText) {
      this.append(response);
      return response;
    }

    if (response.startsWith(this.streamedText)) {
      this.append(response.slice(this.streamedText.length));
    } else if (!this.streamedText.endsWith(response)) {
      // Some runtimes return only the final assistant message after streaming
      // commentary around tools. Keep that authoritative response at the end.
      this.breakSegment();
      this.append(response);
    }
    return response;
  }

  private ensurePartSegment(partId: string, messageId?: string): AssistantSegment {
    const existing = this.partSegments.get(partId);
    if (existing) return existing;
    const view = new RichMarkdown("", 1, this.theme);
    const segment = { view, text: "", messageId };
    this.partSegments.set(partId, segment);
    this.addBlock(view, { id: partId, kind: "assistant", messageId });
    return segment;
  }
}
