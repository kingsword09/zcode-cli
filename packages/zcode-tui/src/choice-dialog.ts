import {
  decodeKittyPrintable,
  getKeybindings,
  Input,
  SelectList,
  truncateToWidth,
  type Component,
  type Container,
  type SelectItem,
  type TUI
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

export interface ChoiceItem extends SelectItem {
  payload?: unknown;
  preview?: Component;
}

class ChoiceDialog implements Component {
  private filter = "";
  private selectionPreview?: Component;

  constructor(
    private readonly title: string,
    private readonly prompt: string,
    private readonly help: string,
    private readonly list: SelectList,
    private readonly theme: ZCodeTheme,
    private readonly content?: Component,
    private readonly maxContentLines = 0
  ) {}

  setSelectionPreview(preview: Component | undefined): void {
    this.selectionPreview = preview;
  }

  render(width: number): string[] {
    const content = [
      ...(this.content?.render(width) ?? []),
      ...(this.content && this.selectionPreview ? [""] : []),
      ...(this.selectionPreview?.render(width) ?? [])
    ];
    const hidden = Math.max(0, content.length - this.maxContentLines);
    const visibleContent = this.maxContentLines > 0 ? content.slice(0, this.maxContentLines) : [];
    if (hidden > 0 && visibleContent.length > 0) {
      visibleContent[visibleContent.length - 1] = this.theme.muted(`… ${hidden} preview lines hidden`);
    }
    return [
      this.theme.bold(this.title),
      this.theme.muted(this.prompt),
      ...(visibleContent.length > 0 ? ["", ...visibleContent] : []),
      `${this.theme.muted("Filter:")} ${this.filter || this.theme.muted("type to search")}`,
      "",
      ...this.list.render(width),
      "",
      this.theme.muted(this.help)
    ];
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.editor.deleteToLineStart")) {
      this.updateFilter("");
      return;
    }
    if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      this.updateFilter(Array.from(this.filter).slice(0, -1).join(""));
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
  }

  invalidate(): void {
    this.list.invalidate();
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
    const dialog = new ChoiceDialog(
      sanitizeTerminalText(options.title, { preserveSgr: false }),
      sanitizeTerminalText(options.prompt, { preserveSgr: false }),
      sanitizeTerminalText(
        options.help ?? "Type to filter · Up/Down choose · Enter confirm · Esc cancel · Ctrl+U clear",
        { preserveSgr: false }
      ),
      list,
      theme,
      options.content,
      maxContentLines
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
    return [
      this.theme.bold(this.title),
      this.theme.muted(this.prompt),
      "",
      ...this.input.render(width),
      "",
      this.theme.muted(this.help)
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
