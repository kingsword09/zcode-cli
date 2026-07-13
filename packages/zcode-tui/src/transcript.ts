import {
  Container,
  Spacer,
  type Component
} from "@earendil-works/pi-tui";

export class Transcript extends Container {
  addBlock(component: Component): void {
    if (this.children.length > 0) this.addChild(new Spacer(1));
    this.addChild(component);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    return lines.length > 0 ? [...lines, ""] : lines;
  }
}
