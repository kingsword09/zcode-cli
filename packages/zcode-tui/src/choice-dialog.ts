import {
  decodeKittyPrintable,
  Editor,
  getKeybindings,
  Input,
  isKeyRelease,
  matchesKey,
  SelectList,
  truncateToWidth,
  type Component,
  type Container,
  type OverlayHandle,
  type SelectItem,
  type TUI
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";
import { isWindowedComponent } from "./renderable.ts";
import {
  sanitizeTerminalText,
  removeLastGrapheme,
  truncateTerminalText,
  wrapTerminalText
} from "./terminal-text.ts";

export interface ChoiceItem extends SelectItem {
  payload?: unknown;
  preview?: Component;
}

const fullscreenDialogContentMaxWidth = 100;
/** Leading numeric parameter of a Kitty CSI-u sequence: the base key code. */
const kittyCsiUBaseCodepointPattern = /^\x1b\[(\d+)(?=[:;u])/u;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Codepoint ranges inside the Unicode private use area that terminals reserve
 * for keys rather than glyphs:
 *
 * - Kitty's keyboard protocol encodes functional keys (F1-F35, PrintScreen,
 *   CapsLock, media keys, IME process keys, modifiers, …) in 57344-57454.
 * - macOS/AppKit reports its own function keys as 0xF700-0xF8FF (NSUpArrow­
 *   FunctionKey … NSModeSwitchFunctionKey), which some terminals pass through
 *   raw.
 *
 * Everything else in the private use area is a real glyph — Nerd Font icons
 * live just above Kitty's block (Powerline starts at 0xE0A0, Seti at 0xE5FA,
 * Font Awesome at 0xF000) — so it must stay typeable and pasteable.
 */
const functionalKeyRanges = [
  { start: 57344, end: 57454 },
  { start: 0xf700, end: 0xf8ff }
] as const;

function isFunctionalKeyCharacter(character: string): boolean {
  const codepoint = character.codePointAt(0);
  if (codepoint === undefined) return false;
  return functionalKeyRanges.some(({ start, end }) => codepoint >= start && codepoint <= end);
}

function containsFunctionalKeyCharacter(value: string): boolean {
  return [...value].some(isFunctionalKeyCharacter);
}

/**
 * True when a Kitty CSI-u sequence describes a functional key with no text
 * equivalent.
 *
 * Rather than duplicating pi-tui's functional-key mapping table (which would
 * silently drift as that table grows), this asks pi-tui to decode the *base*
 * key code on its own. Numpad keys and friends normalize to real text; anything
 * that still decodes to a reserved key codepoint has no text equivalent. Testing
 * the base code also ignores the shifted/alternate fields, which must never
 * turn a functional key into text.
 */
function isTextlessFunctionalKey(data: string): boolean {
  const match = kittyCsiUBaseCodepointPattern.exec(data);
  if (!match) return false;
  const decodedBase = decodeKittyPrintable(`\x1b[${match[1]}u`);
  return decodedBase === undefined || containsFunctionalKeyCharacter(decodedBase);
}

/**
 * Resolve the text a key press should append to the filter, or undefined when
 * the input is not text and should fall through to list navigation.
 */
function decodeFilterText(data: string): string | undefined {
  if (data.length === 0) return undefined;
  // Releases never produce text. pi-tui's central dispatch already drops them
  // for components that do not opt in, but guard here too so direct callers
  // (and any future opt-in) cannot poison the filter.
  if (isKeyRelease(data)) return undefined;
  if (isTextlessFunctionalKey(data)) return undefined;
  const printable = decodeKittyPrintable(data);
  if (printable !== undefined) {
    return containsFunctionalKeyCharacter(printable) ? undefined : printable;
  }
  // Legacy/raw input. Some terminals (notably macOS) deliver functional keys as
  // bare reserved-range characters, so screen those out as well. Ordinary
  // private-use glyphs (Nerd Font icons) fall through as text.
  if (controlCharacterPattern.test(data) || containsFunctionalKeyCharacter(data)) return undefined;
  return data;
}

class FullscreenDialogSurface implements Component {
  focused = false;

  constructor(
    private readonly dialog: Component,
    private readonly theme: ZCodeTheme
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if ("focused" in this.dialog) {
      (this.dialog as Component & { focused: boolean }).focused = this.focused;
    }
    const inset = safeWidth >= 12 ? 2 : 0;
    const contentWidth = Math.max(
      1,
      Math.min(fullscreenDialogContentMaxWidth, safeWidth - inset * 2)
    );
    const prefix = " ".repeat(inset);
    const rule = this.theme.muted("─".repeat(safeWidth));
    return [
      rule,
      ...this.dialog.render(contentWidth).map((line) => (
        truncateToWidth(`${prefix}${line}`, safeWidth, "", true)
      )),
      rule
    ];
  }

  handleInput(data: string): void {
    this.dialog.handleInput?.(data);
  }

  invalidate(): void {
    this.dialog.invalidate();
  }
}

function showFullscreenDialog(
  ui: TUI,
  theme: ZCodeTheme,
  dialog: Component
): { focus: Component; handle: OverlayHandle } | undefined {
  if (ui.mode !== "fullscreen" || typeof ui.showOverlay !== "function") return undefined;
  const surface = new FullscreenDialogSurface(dialog, theme);
  return {
    focus: surface,
    handle: ui.showOverlay(surface, {
      anchor: "bottom-left",
      maxHeight: "100%",
      width: "100%"
    })
  };
}

class ChoiceItemDetails implements Component {
  constructor(
    private readonly item: ChoiceItem,
    private readonly theme: ZCodeTheme
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const preview = this.item.preview?.render(safeWidth) ?? [];
    return [
      ...wrapTerminalText(this.theme.bold(this.item.label), safeWidth),
      ...(this.item.description
        ? wrapTerminalText(this.theme.muted(this.item.description), safeWidth)
        : []),
      ...(preview.length > 0 ? ["", ...preview] : [])
    ];
  }

  invalidate(): void {
    this.item.preview?.invalidate?.();
  }
}

class ChoiceDialog implements Component {
  private filter = "";
  private selectionPreview?: Component;
  private contentExpanded = false;
  private contentOffset = 0;
  private contentLineCount = 0;
  private contentPageSize = 1;

  constructor(
    private readonly title: string,
    private readonly prompt: string,
    private readonly help: string,
    private readonly list: SelectList,
    private readonly theme: ZCodeTheme,
    private readonly content?: Component,
    private readonly contentLabel = "Details",
    private readonly maxContentLines = 0,
    private readonly maxExpandedContentLines = 0
  ) {}

  setSelectionPreview(preview: Component | undefined): void {
    if (this.selectionPreview !== preview) this.contentOffset = 0;
    this.selectionPreview = preview;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const windowedContent = this.content && !this.selectionPreview && isWindowedComponent(this.content)
      ? this.content
      : undefined;
    const content = windowedContent ? undefined : [
      ...(this.content?.render(safeWidth) ?? []),
      ...(this.content && this.selectionPreview ? [""] : []),
      ...(this.selectionPreview?.render(safeWidth) ?? [])
    ];
    const totalContentLines = windowedContent
      ? windowedContent.renderWindow(safeWidth, 0, 0).totalLines
      : content?.length ?? 0;
    const visibleContent = this.renderContentViewport(
      totalContentLines,
      this.contentExpanded ? this.maxExpandedContentLines : this.maxContentLines,
      safeWidth,
      (start, count) => windowedContent
        ? windowedContent.renderWindow(safeWidth, start, count).lines
        : content?.slice(start, start + count) ?? []
    );
    if (this.contentExpanded && totalContentLines > 0) {
      return [
        ...wrapTerminalText(
          `${this.theme.bold(this.title)} ${this.theme.accent(`· ${this.contentLabel}`)}`,
          safeWidth
        ),
        ...wrapTerminalText(this.theme.muted(this.prompt), safeWidth),
        "",
        ...visibleContent,
        "",
        ...wrapTerminalText(
          this.theme.muted("Up/Down scroll · ←/→ or PgUp/PgDn page · Home/End jump · Ctrl+O or Esc return"),
          safeWidth
        )
      ];
    }
    return [
      ...wrapTerminalText(this.theme.bold(this.title), safeWidth),
      ...wrapTerminalText(this.theme.muted(this.prompt), safeWidth),
      ...(visibleContent.length > 0 ? ["", ...visibleContent] : []),
      truncateTerminalText(
        `${this.theme.muted("Filter:")} ${this.filter || this.theme.muted("type to search")}`,
        safeWidth
      ),
      "",
      ...this.list.render(safeWidth),
      "",
      ...wrapTerminalText(this.theme.muted(this.help), safeWidth)
    ];
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (matchesKey(data, "ctrl+o") && this.contentLineCount > 0) {
      this.contentExpanded = !this.contentExpanded;
      return;
    }
    const contentInput = (this.content as (Component & {
      handleInput?: (input: string) => boolean;
    }) | undefined)?.handleInput;
    if (contentInput?.call(this.content, data) === true) return;
    if (this.contentExpanded) {
      if (matchesKey(data, "escape")) {
        this.contentExpanded = false;
        return;
      }
      if (keybindings.matches(data, "tui.select.up")) {
        this.scrollContent(-1);
        return;
      }
      if (keybindings.matches(data, "tui.select.down")) {
        this.scrollContent(1);
        return;
      }
      if (keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, "left")) {
        this.scrollContent(-Math.max(1, this.contentPageSize - 1));
        return;
      }
      if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, "right")) {
        this.scrollContent(Math.max(1, this.contentPageSize - 1));
        return;
      }
      if (matchesKey(data, "home")) {
        this.contentOffset = 0;
        return;
      }
      if (matchesKey(data, "end")) {
        this.contentOffset = Math.max(0, this.contentLineCount - this.contentPageSize);
        return;
      }
      if (keybindings.matches(data, "tui.select.cancel")) this.list.handleInput(data);
      return;
    }
    if (keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, "left")) {
      this.scrollContent(-Math.max(1, this.contentPageSize - 1));
      return;
    }
    if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, "right")) {
      this.scrollContent(Math.max(1, this.contentPageSize - 1));
      return;
    }
    if (keybindings.matches(data, "tui.editor.deleteToLineStart")) {
      this.updateFilter("");
      return;
    }
    if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.updateFilter(removeLastGrapheme(this.filter));
      return;
    }

    const text = decodeFilterText(data);
    if (text !== undefined) {
      this.updateFilter(this.filter + text);
      return;
    }

    this.list.handleInput(data);
  }

  private updateFilter(filter: string): void {
    this.filter = filter;
    this.list.setFilter(filter);
    const selected = this.list.getSelectedItem();
    if (selected) this.list.onSelectionChange?.(selected);
    else this.setSelectionPreview(undefined);
  }

  private renderContentViewport(
    totalLines: number,
    maxLines: number,
    width: number,
    read: (start: number, count: number) => string[]
  ): string[] {
    this.contentLineCount = totalLines;
    if (totalLines === 0 || maxLines <= 0) {
      this.contentOffset = 0;
      this.contentPageSize = 1;
      return [];
    }
    if (totalLines <= maxLines) {
      this.contentOffset = 0;
      this.contentPageSize = totalLines;
      return read(0, totalLines).map((line) => truncateToWidth(line, width, ""));
    }

    const bodyLines = Math.max(1, maxLines - 1);
    this.contentPageSize = bodyLines;
    this.contentOffset = Math.max(0, Math.min(
      this.contentOffset,
      totalLines - bodyLines
    ));
    const end = Math.min(totalLines, this.contentOffset + bodyLines);
    const above = this.contentOffset;
    const below = totalLines - end;
    const position = [
      `${this.contentLabel} ${this.contentOffset + 1}–${end} of ${totalLines}`,
      above > 0 ? `↑ ${above}` : undefined,
      below > 0 ? `↓ ${below}` : undefined,
      "←/→ or PgUp/PgDn scroll"
    ].filter((value): value is string => Boolean(value)).join(" · ");
    return [
      ...read(this.contentOffset, end - this.contentOffset)
        .map((line) => truncateToWidth(line, width, "")),
      truncateToWidth(this.theme.muted(position), width, "")
    ];
  }

  private scrollContent(delta: number): void {
    const maximum = Math.max(0, this.contentLineCount - this.contentPageSize);
    this.contentOffset = Math.max(0, Math.min(maximum, this.contentOffset + delta));
  }

  invalidate(): void {
    this.list.invalidate();
    this.content?.invalidate?.();
    this.selectionPreview?.invalidate?.();
  }
}

export function choose(
  ui: TUI,
  host: Container,
  theme: ZCodeTheme,
  options: {
    title: string;
    prompt: string;
    help?: string;
    items: ChoiceItem[];
    content?: Component;
    contentLabel?: string;
    selectedIndex?: number;
    signal?: AbortSignal;
    showSelectedItemDetails?: boolean;
  }
): Promise<ChoiceItem | null> {
  if (options.items.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    const choicesByValue = new Map<string, ChoiceItem>();
    const detailsByValue = new Map<string, Component>();
    const searchableItems = options.items.map((item, index): SelectItem => {
      const safeItem: ChoiceItem = {
        ...item,
        label: sanitizeTerminalText(item.label, { preserveSgr: false }),
        description: item.description
          ? sanitizeTerminalText(item.description, { preserveSgr: false })
          : undefined
      };
      const value = `${safeItem.label}\u0000${index}`;
      choicesByValue.set(value, safeItem);
      if (options.showSelectedItemDetails) {
        detailsByValue.set(value, new ChoiceItemDetails(safeItem, theme));
      }
      return { value, label: safeItem.label, description: safeItem.description };
    });
    const hasDetails = Boolean(
      options.content
      || options.showSelectedItemDetails
      || options.items.some((item) => item.preview)
    );
    const maxVisible = Math.max(1, Math.min(
      8,
      searchableItems.length,
      Math.floor(Math.max(2, ui.terminal.rows - 8) / (hasDetails ? 2 : 1))
    ));
    const list = new SelectList(searchableItems, maxVisible, theme.select);
    list.setSelectedIndex(options.selectedIndex ?? 0);
    const maxContentLines = Math.max(0, ui.terminal.rows - maxVisible - 9);
    const maxExpandedContentLines = Math.max(2, maxContentLines, ui.terminal.rows - 8);
    const dialog = new ChoiceDialog(
      sanitizeTerminalText(options.title, { preserveSgr: false }),
      sanitizeTerminalText(options.prompt, { preserveSgr: false }),
      sanitizeTerminalText(
        options.help ?? (hasDetails
          ? "Type to filter · Up/Down choose · Ctrl+O details · ←/→ or PgUp/PgDn scroll · Enter confirm · Esc cancel"
          : "Type to filter · Up/Down choose · Enter confirm · Esc cancel · Ctrl+U clear"),
        { preserveSgr: false }
      ),
      list,
      theme,
      options.content,
      sanitizeTerminalText(options.contentLabel ?? "Details", { preserveSgr: false }),
      maxContentLines,
      maxExpandedContentLines
    );
    const previewFor = (item: SelectItem | null): Component | undefined => {
      if (!item) return undefined;
      return options.showSelectedItemDetails
        ? detailsByValue.get(item.value)
        : choicesByValue.get(item.value)?.preview;
    };
    dialog.setSelectionPreview(previewFor(list.getSelectedItem()));
    let settled = false;
    let overlayHandle: OverlayHandle | undefined;
    const finish = (item: ChoiceItem | null) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (overlayHandle) overlayHandle.hide();
      else host.removeChild(dialog);
      ui.requestRender();
      resolve(item);
    };
    const onAbort = () => finish(null);
    list.onSelect = (item) => finish(choicesByValue.get(item.value) ?? null);
    list.onSelectionChange = (item) => dialog.setSelectionPreview(previewFor(item));
    list.onCancel = () => finish(null);
    // Mount as an overlay in fullscreen mode so TuiAltScreen defers viewport
    // input (PageUp/PageDown/Home/End) to the focused dialog. In regular mode
    // keep the inline host layout to preserve the existing visual placement.
    const fullscreenDialog = showFullscreenDialog(ui, theme, dialog);
    if (fullscreenDialog) {
      overlayHandle = fullscreenDialog.handle;
    } else {
      host.addChild(dialog);
    }
    ui.setFocus(fullscreenDialog?.focus ?? dialog);
    ui.requestRender();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) finish(null);
  });
}

class TextPromptDialog implements Component {
  focused = false;

  constructor(
    private readonly title: string,
    private readonly prompt: string,
    private readonly input: Component,
    private readonly theme: ZCodeTheme,
    private readonly help: string
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if ("focused" in this.input) {
      (this.input as Component & { focused: boolean }).focused = this.focused;
    }
    return [
      ...wrapTerminalText(this.theme.bold(this.title), safeWidth),
      ...wrapTerminalText(this.theme.muted(this.prompt), safeWidth),
      "",
      ...this.input.render(safeWidth),
      "",
      ...wrapTerminalText(this.theme.muted(this.help), safeWidth)
    ];
  }

  handleInput(data: string): void {
    (this.input as Component & { handleInput?: (input: string) => void }).handleInput?.(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

class PromptInput extends Input {
  constructor(
    private readonly mask: boolean,
    private readonly placeholder: string | undefined,
    private readonly theme: ZCodeTheme
  ) {
    super();
  }

  override render(width: number): string[] {
    const value = this.getValue();
    if (this.mask && value) {
      this.setValue("*".repeat(value.length));
      try {
        return super.render(width);
      } finally {
        this.setValue(value);
      }
    }

    const lines = super.render(width);
    if (!value && this.placeholder && lines[0]) {
      const placeholder = this.theme.muted(this.placeholder);
      const line = lines[0].replace("\x1b[7m \x1b[27m", `\x1b[7m \x1b[27m${placeholder}`);
      return [truncateToWidth(line, width, "", true)];
    }
    return lines;
  }
}

class PromptEditor extends Editor {
  onEscape?: () => void;

  constructor(
    ui: TUI,
    private readonly placeholder: string | undefined,
    private readonly promptTheme: ZCodeTheme
  ) {
    super(ui, promptTheme.editor, { paddingX: 1 });
  }

  override handleInput(data: string): void {
    if (getKeybindings().matches(data, "tui.select.cancel")) {
      this.onEscape?.();
      return;
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (this.getText() || !this.placeholder) return lines;

    const cursor = "\x1b[7m \x1b[0m";
    const cursorLine = lines.findIndex((line) => line.includes(cursor));
    if (cursorLine >= 0) {
      lines[cursorLine] = truncateToWidth(
        lines[cursorLine]!.replace(cursor, `${cursor}${this.promptTheme.muted(this.placeholder)}`),
        width,
        "",
        true
      );
    }
    return lines;
  }
}

export function promptText(
  ui: TUI,
  host: Container,
  theme: ZCodeTheme,
  options: {
    title: string;
    prompt: string;
    initialValue?: string;
    help?: string;
    signal?: AbortSignal;
    mask?: boolean;
    placeholder?: string;
  }
): Promise<string | null> {
  return new Promise((resolve) => {
    const placeholder = options.placeholder
      ? sanitizeTerminalText(options.placeholder, { preserveSgr: false })
      : undefined;
    const input = options.mask === true
      ? new PromptInput(true, placeholder, theme)
      : new PromptEditor(ui, placeholder, theme);
    if (options.initialValue) {
      if (input instanceof PromptEditor) input.setText(options.initialValue);
      else input.setValue(options.initialValue);
    }
    const dialog = new TextPromptDialog(
      sanitizeTerminalText(options.title, { preserveSgr: false }),
      sanitizeTerminalText(options.prompt, { preserveSgr: false }),
      input,
      theme,
      sanitizeTerminalText(options.help ?? "Enter confirm · Esc cancel", { preserveSgr: false })
    );
    let settled = false;
    let overlayHandle: OverlayHandle | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (overlayHandle) overlayHandle.hide();
      else host.removeChild(dialog);
      ui.requestRender();
      resolve(value);
    };
    const onAbort = () => finish(null);
    input.onSubmit = (value) => finish(value);
    input.onEscape = () => finish(null);
    const fullscreenDialog = showFullscreenDialog(ui, theme, dialog);
    if (fullscreenDialog) {
      overlayHandle = fullscreenDialog.handle;
    } else {
      host.addChild(dialog);
    }
    // Keep focus on the overlay root. TuiAltScreen uses the root focus state
    // to defer viewport keys; TextPromptDialog forwards input to its child.
    ui.setFocus(fullscreenDialog?.focus ?? dialog);
    ui.requestRender();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) finish(null);
  });
}
