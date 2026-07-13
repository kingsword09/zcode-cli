import {
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

export interface StatusLineField {
  text: string;
  compactText?: string;
  priority: number;
  required?: boolean;
}

interface RenderedField extends StatusLineField {
  renderedText: string;
}

export class StatusLine implements Component {
  private fields: StatusLineField[] = [];
  private separator = " · ";

  setFields(fields: StatusLineField[], separator = " · "): void {
    this.fields = fields;
    this.separator = separator;
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    const availableWidth = Math.max(0, width - 1);
    let fields = this.fields.map((field): RenderedField => ({
      ...field,
      renderedText: field.text
    }));
    if (this.width(fields) > availableWidth) {
      fields = fields.map((field) => ({
        ...field,
        renderedText: field.compactText ?? field.text
      }));
    }

    while (fields.length > 1 && this.width(fields) > availableWidth) {
      const removable = fields
        .map((field, index) => ({ field, index }))
        .filter(({ field }) => !field.required)
        .sort((left, right) => left.field.priority - right.field.priority)[0];
      if (!removable) break;
      fields.splice(removable.index, 1);
    }

    const line = fields.map((field) => field.renderedText).join(this.separator);
    return [` ${truncateToWidth(line, availableWidth, "…")}`];
  }

  invalidate(): void {}

  private width(fields: RenderedField[]): number {
    if (fields.length === 0) return 0;
    return fields.reduce((total, field) => total + visibleWidth(field.renderedText), 0)
      + visibleWidth(this.separator) * (fields.length - 1);
  }
}
