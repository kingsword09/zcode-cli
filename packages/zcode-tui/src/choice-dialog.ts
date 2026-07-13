import {
  SelectList,
  type Component,
  type SelectItem,
  type TUI
} from "@earendil-works/pi-tui";

import type { ZCodeTheme } from "./theme.ts";

export interface ChoiceItem extends SelectItem {
  payload?: unknown;
}

class ChoiceDialog implements Component {
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
      "",
      ...this.list.render(width),
      "",
      this.theme.muted(this.help)
    ];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

export function choose(
  ui: TUI,
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
    const list = new SelectList(options.items, Math.min(8, options.items.length), theme.select);
    list.setSelectedIndex(options.selectedIndex ?? 0);
    const dialog = new ChoiceDialog(
      options.title,
      options.prompt,
      options.help ?? "Up/Down choose · Enter confirm · Esc cancel",
      list,
      theme
    );
    const handle = ui.showOverlay(dialog, {
      width: "80%",
      minWidth: 36,
      maxHeight: "70%",
      anchor: "center",
      margin: 1
    });
    let settled = false;
    const finish = (item: ChoiceItem | null) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      handle.hide();
      resolve(item);
    };
    const onAbort = () => finish(null);
    list.onSelect = (item) => finish(options.items.find((choice) => choice.value === item.value) ?? null);
    list.onCancel = () => finish(null);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) finish(null);
  });
}
