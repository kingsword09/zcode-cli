import {
  decodeKittyPrintable,
  getKeybindings,
  SelectList,
  type Component,
  type Container,
  type SelectItem,
  type TUI
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";

export interface ChoiceItem extends SelectItem {
  payload?: unknown;
}

class ChoiceDialog implements Component {
  private filter = "";

  constructor(
    private readonly title: string,
    private readonly prompt: string,
    private readonly help: string,
    private readonly list: SelectList,
    private readonly theme: ZCodeTheme
  ) {}

  render(width: number): string[] {
    return [
      this.theme.bold(this.title),
      this.theme.muted(this.prompt),
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
    selectedIndex?: number;
    signal?: AbortSignal;
  }
): Promise<ChoiceItem | null> {
  if (options.items.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    const choicesByValue = new Map<string, ChoiceItem>();
    const searchableItems = options.items.map((item, index): SelectItem => {
      const value = `${item.label}\u0000${index}`;
      choicesByValue.set(value, item);
      return { value, label: item.label, description: item.description };
    });
    const maxVisible = Math.max(1, Math.min(8, searchableItems.length, ui.terminal.rows - 11));
    const list = new SelectList(searchableItems, maxVisible, theme.select);
    list.setSelectedIndex(options.selectedIndex ?? 0);
    const dialog = new ChoiceDialog(
      options.title,
      options.prompt,
      options.help ?? "Type to filter · Up/Down choose · Enter confirm · Esc cancel · Ctrl+U clear",
      list,
      theme
    );
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
    list.onCancel = () => finish(null);
    host.addChild(dialog);
    ui.setFocus(dialog);
    ui.requestRender();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) finish(null);
  });
}
