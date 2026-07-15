import {
  decodeKittyPrintable,
  getKeybindings,
  Input,
  matchesKey,
  SelectList,
  truncateToWidth,
  type Component,
  type Container,
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
          this.theme.muted("Up/Down scroll · PgUp/PgDn page · Home/End jump · Ctrl+O or Esc return"),
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
      if (keybindings.matches(data, "tui.select.pageUp")) {
        this.scrollContent(-Math.max(1, this.contentPageSize - 1));
        return;
      }
      if (keybindings.matches(data, "tui.select.pageDown")) {
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
    if (keybindings.matches(data, "tui.select.pageUp")) {
      this.scrollContent(-Math.max(1, this.contentPageSize - 1));
      return;
    }
    if (keybindings.matches(data, "tui.select.pageDown")) {
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

    const printable = decodeKittyPrintable(data)
      ?? (data.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(data) ? data : undefined);
    if (printable !== undefined) {
      this.updateFilter(this.filter + printable);
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
      "PgUp/PgDn scroll"
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
  }
): Promise<ChoiceItem | null> {
  if (options.items.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    const choicesByValue = new Map<string, ChoiceItem>();
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
      return { value, label: safeItem.label, description: safeItem.description };
    });
    const maxVisible = Math.max(1, Math.min(
      8,
      searchableItems.length,
      Math.floor(Math.max(2, ui.terminal.rows - 8) / (options.content || options.items.some((item) => item.preview) ? 2 : 1))
    ));
    const list = new SelectList(searchableItems, maxVisible, theme.select);
    list.setSelectedIndex(options.selectedIndex ?? 0);
    const maxContentLines = Math.max(0, ui.terminal.rows - maxVisible - 9);
    const maxExpandedContentLines = Math.max(2, maxContentLines, ui.terminal.rows - 8);
    const hasDetails = Boolean(options.content || options.items.some((item) => item.preview));
    const dialog = new ChoiceDialog(
      sanitizeTerminalText(options.title, { preserveSgr: false }),
      sanitizeTerminalText(options.prompt, { preserveSgr: false }),
      sanitizeTerminalText(
        options.help ?? (hasDetails
          ? "Type to filter · Up/Down choose · Ctrl+O details · PgUp/PgDn scroll · Enter confirm · Esc cancel"
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
      return item ? choicesByValue.get(item.value)?.preview : undefined;
    };
    dialog.setSelectionPreview(previewFor(list.getSelectedItem()));
    let settled = false;
    const finish = (item: ChoiceItem | null) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      host.removeChild(dialog);
      ui.requestRender();
      resolve(item);
    };
    const onAbort = () => finish(null);
    list.onSelect = (item) => finish(choicesByValue.get(item.value) ?? null);
    list.onSelectionChange = (item) => dialog.setSelectionPreview(previewFor(item));
    list.onCancel = () => finish(null);
    host.addChild(dialog);
    ui.setFocus(dialog);
    ui.requestRender();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) finish(null);
  });
}

class TextPromptDialog implements Component {
  constructor(
    private readonly title: string,
    private readonly prompt: string,
    private readonly input: Input,
    private readonly theme: ZCodeTheme,
    private readonly help: string
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    return [
      ...wrapTerminalText(this.theme.bold(this.title), safeWidth),
      ...wrapTerminalText(this.theme.muted(this.prompt), safeWidth),
      "",
      ...this.input.render(safeWidth),
      "",
      ...wrapTerminalText(this.theme.muted(this.help), safeWidth)
    ];
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
    const input = new PromptInput(
      options.mask === true,
      options.placeholder
        ? sanitizeTerminalText(options.placeholder, { preserveSgr: false })
        : undefined,
      theme
    );
    if (options.initialValue) input.setValue(options.initialValue);
    const dialog = new TextPromptDialog(
      sanitizeTerminalText(options.title, { preserveSgr: false }),
      sanitizeTerminalText(options.prompt, { preserveSgr: false }),
      input,
      theme,
      sanitizeTerminalText(options.help ?? "Enter confirm · Esc cancel", { preserveSgr: false })
    );
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      host.removeChild(dialog);
      ui.requestRender();
      resolve(value);
    };
    const onAbort = () => finish(null);
    input.onSubmit = (value) => finish(value);
    input.onEscape = () => finish(null);
    host.addChild(dialog);
    ui.setFocus(input);
    ui.requestRender();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) finish(null);
  });
}
