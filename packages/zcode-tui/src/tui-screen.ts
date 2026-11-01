import {
  ProcessTerminal,
  TuiAltScreen,
  TuiMainScreen,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
  type TuiMode
} from "@earendil-works/pi-tui";
import { AltScreenSearchComponent } from "@earendil-works/pi-tui/dist/alt-screen-search.js";

import { stripCaretHighlight } from "./terminal-text.ts";

export interface TerminalInputHandlers {
  beforeInput?: (data: string) => void;
  afterInput?: () => void;
  onFocusIn?: () => void;
  onResize?: () => void;
  copySelection?: (text: string) => Promise<boolean>;
}

const terminalFocusIn = "\x1b[I";

function isMouseMultiplexer(): boolean {
  const term = process.env.TERM?.toLowerCase() ?? "";
  return process.env.TMUX !== undefined
    || process.env.ZELLIJ !== undefined
    || process.env.STY !== undefined
    || term.startsWith("tmux")
    || term.startsWith("screen");
}

function scrollbarHoverProbe(data: string): string | undefined {
  if (!isMouseMultiplexer()) return undefined;
  const match = /^\x1b\[<(\d+);(\d+);(\d+)M$/u.exec(data);
  if (!match) return undefined;
  const button = Number(match[1]);
  if ((button & 32) !== 0 || (button & 3) !== 0) return undefined;
  return `\x1b[<35;${match[2]};${match[3]}M`;
}

export class ZCodeAltScreen extends TuiAltScreen {
  private viewportInputDeferral?: (data: string) => boolean;
  private currentInput?: string;

  setViewportInputDeferral(deferral: (data: string) => boolean): void {
    this.viewportInputDeferral = deferral;
  }

  setCurrentInput(data: string | undefined): void {
    this.currentInput = data;
  }

  override showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
    // pi-tui constructs its search Input internally. Decorate only that
    // overlay, before compositing, so transcript matches and selections retain
    // their inverse styles. The caret is also drawn when the search has lost
    // keyboard focus to the editor and no longer emits a cursor marker.
    if (component instanceof AltScreenSearchComponent) {
      const render = component.render.bind(component);
      component.render = (width) => {
        const lines = render(width);
        return this.getShowHardwareCursor() ? lines : lines.map(stripCaretHighlight);
      };
    }
    return super.showOverlay(component, options);
  }

  /**
   * The terminal can lose visible rows while this process is unfocused even
   * though pi-tui's logical frame remains unchanged. Invalidate its
   * differential cache so the next frame repaints every row.
   */
  forceFullRedraw(): void {
    // Resetting also clears the layout used by mouse events in this input batch.
    process.nextTick(() => this.requestRender(true));
  }

  protected override isOverlayFocused(): boolean {
    if (super.isOverlayFocused()) return true;
    return this.viewportInputDeferral?.(this.currentInput ?? "") === true;
  }
}

/** Feed focus reports to the notifier before the TUI's own input listeners. */
export class NotifyingProcessTerminal extends ProcessTerminal {
  handlers: TerminalInputHandlers = {};

  override start(onInput: (data: string) => void, onResize: () => void): void {
    super.start((data) => {
      this.handlers.beforeInput?.(data);
      try {
        // Multiplexers use button-motion tracking and do not report passive
        // pointer movement. Probe hover immediately before a press so a
        // hidden auto scrollbar can still claim a direct drag gesture.
        const hoverProbe = scrollbarHoverProbe(data);
        if (hoverProbe) onInput(hoverProbe);
        onInput(data);
      } finally {
        this.handlers.afterInput?.();
        if (data === terminalFocusIn) this.handlers.onFocusIn?.();
      }
    }, () => {
      onResize();
      this.handlers.onResize?.();
    });
  }
}

export function createTuiScreen(mode: TuiMode): TUI {
  const terminal = new NotifyingProcessTerminal();
  if (mode !== "fullscreen") return new TuiMainScreen(terminal, true);
  return new ZCodeAltScreen(terminal, true, undefined, {
    copySelection: (text) => terminal.handlers.copySelection?.(text) ?? Promise.resolve(false),
    copyOnSelect: true,
    mouse: true,
    wheelScrollLines: 3
  });
}
