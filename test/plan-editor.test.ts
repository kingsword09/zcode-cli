import { expect, test } from "bun:test";
import { Editor, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { PlanEditor } from "../packages/zcode-tui/src/plan-editor.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

test("Plan uses the existing border without moving the editor cursor or adding rows", () => {
  const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
  const theme = createTheme(false);
  const editor = new PlanEditor(tui, theme.editor, { paddingX: 1 });
  const original = new Editor(tui, theme.editor, { paddingX: 1 });
  editor.focused = original.focused = true;
  for (const text of ["", "修改登录逻辑 👩‍💻", Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")]) {
    editor.setText(text);
    original.setText(text);
    for (const width of [4, 8, 20, 40, 80, 120]) {
      editor.planEnabled = false;
      const before = original.render(width);
      expect(editor.render(width)).toEqual(before);
      editor.planEnabled = true;
      const after = editor.render(width);
      expect(after.length).toBe(before.length);
      expect(after[0]).toContain("Plan");
      expect(after[0]?.endsWith(width >= 10 ? " Plan ──" : "Plan")).toBe(true);
      expect(visibleWidth(after[0]!)).toBe(width);
      if (text) expect(after.slice(1)).toEqual(before.slice(1));
      else {
        expect(editor.getText()).toBe("");
        expect(after[1]?.slice(0, after[1].indexOf("\x1b[7m") + 4))
          .toBe(before[1]?.slice(0, before[1].indexOf("\x1b[7m") + 4));
        expect(visibleWidth(after[1]!)).toBe(width);
      }
      if (width >= 40 && before[0]?.includes("↑")) expect(after[0]).toContain("↑");
    }
  }
});
