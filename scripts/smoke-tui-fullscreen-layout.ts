#!/usr/bin/env bun

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixture = join(root, "test", "fixtures", "tui-fullscreen-layout.ts");

async function runPhase(options: { copyOnSelect: boolean }): Promise<void> {
  const temporaryHome = await mkdtemp(join(tmpdir(), "zcode-tui-layout-"));
  const clipboardPath = join(temporaryHome, "clipboard.txt");
  const decoder = new TextDecoder();
  // ui.copyOnSelect defaults to enabled; seed the user config to exercise the opt-out.
  if (!options.copyOnSelect) {
    const configDirectory = join(temporaryHome, ".zcode", "cli");
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configDirectory, "config.json"),
      `${JSON.stringify({ ui: { copyOnSelect: false } })}\n`
    );
  }

  let output = "";
  const terminal = new Bun.Terminal({
    cols: 80,
    rows: 24,
    name: "xterm-256color",
    data(_terminal, data) {
      output += decoder.decode(data, { stream: true });
    }
  });

  const child = Bun.spawn([process.execPath, fixture], {
    cwd: root,
    env: {
      ...process.env,
      CI: "1",
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      TERM: "xterm-256color",
      ZCODE_TUI_MODE: "fullscreen",
      ZCODE_TUI_NOTIFICATION_METHOD: "off",
      ZCODE_TUI_TEST_CLIPBOARD_PATH: clipboardPath
    },
    terminal
  });

  function plain(value: string): string {
    return value
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1bP[^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b_p[^\x07]*\x07/g, "")
      .replace(/\r/g, "");
  }

  async function waitFor(pattern: RegExp, start = 0, timeoutMs = 8_000): Promise<void> {
    const startedAt = Date.now();
    while (!pattern.test(plain(output.slice(start))) && child.exitCode === null && Date.now() - startedAt < timeoutMs) {
      await Bun.sleep(20);
    }
    if (!pattern.test(plain(output.slice(start)))) {
      throw new Error(`Timed out waiting for ${pattern}.\n${plain(output).slice(-4_000)}`);
    }
  }

  function screenRows(): string[] {
    const rows: string[] = [];
    const writes = output.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;1H\x1b\[2K|$)/g);
    for (const match of writes) rows[Number(match[1]) - 1] = plain(match[2] ?? "").trimEnd();
    return rows;
  }

  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  let failure: unknown;
  try {
    await waitFor(/alpha\/model/i);
    const startupRows = screenRows();
    if (startupRows.some((row) => row.includes("SYSTEM INITIATED"))) {
      throw new Error(`Fullscreen header used the wide banner unexpectedly.\n${startupRows.join("\n")}`);
    }
    if (!startupRows.some((row) => /^── ◆ ZCODE/u.test(row))) {
      throw new Error(`Fullscreen header rail did not render its separator.\n${startupRows.join("\n")}`);
    }
    if (!startupRows.some((row) => /^╭─ Workspace .*─╮$/u.test(row))) {
      throw new Error(`Fullscreen welcome card did not render its frame.\n${startupRows.join("\n")}`);
    }
    if (!startupRows.some((row) => row.includes("Ask a task about this workspace"))) {
      throw new Error(`Fullscreen welcome surface was not rendered.\n${startupRows.join("\n")}`);
    }
    const copyRow = startupRows.findIndex((row) => row.includes("Ask a task about this workspace"));
    const copyColumn = startupRows[copyRow]?.indexOf("Ask") ?? -1;
    if (copyRow < 0 || copyColumn < 0) {
      throw new Error(`Could not locate fullscreen text for mouse-copy verification.\n${startupRows.join("\n")}`);
    }
    terminal.write(`\x1b[<0;${copyColumn + 1};${copyRow + 1}M`);
    terminal.write(`\x1b[<32;${copyColumn + 4};${copyRow + 1}M`);
    terminal.write(`\x1b[<0;${copyColumn + 4};${copyRow + 1}m`);
    if (options.copyOnSelect) {
      await waitFor(/Copied!/i);
      const copiedText = await Bun.file(clipboardPath).text();
      if (!copiedText.startsWith("Ask")) {
        throw new Error(`Fullscreen selection did not reach the system clipboard writer: ${JSON.stringify(copiedText)}`);
      }
    } else {
      // Copy-on-select is disabled: a drag must highlight only and leave the
      // system clipboard untouched for the user to copy manually.
      await Bun.sleep(250);
      if (/Copied!/i.test(plain(output))) {
        throw new Error("Fullscreen selection flashed a clipboard copy despite ui.copyOnSelect being false.");
      }
      if (await Bun.file(clipboardPath).exists()) {
        throw new Error(`Fullscreen selection reached the system clipboard writer: ${JSON.stringify(await Bun.file(clipboardPath).text())}`);
      }
      const manualCopyStart = output.length;
      terminal.write("/copy\r");
      await waitFor(/Copied!/i, manualCopyStart);
      const copiedText = await Bun.file(clipboardPath).text();
      if (!copiedText.startsWith("Ask")) {
        throw new Error(`Fullscreen /copy did not copy the active mouse selection: ${JSON.stringify(copiedText)}`);
      }
    }
    if (options.copyOnSelect) {
      const turnStart = output.length;
      terminal.write("long transcript\r");
      await waitFor(/transcript line 80/i, turnStart);
      const beforeRows = screenRows();
      terminal.write("\x1b[5~");
      await Bun.sleep(100);
      const rows = screenRows();
      const firstTranscript = (lines: string[]): number => {
        const line = lines.find((value) => /^ transcript line \d+$/u.test(value));
        return line ? Number(line.match(/\d+/u)?.[0] ?? 0) : 0;
      };
      const firstTranscriptRow = rows.findIndex((row) => /^ transcript line \d+$/u.test(row));
      if (firstTranscriptRow < 1 || firstTranscriptRow > 3) {
        throw new Error(`Fullscreen header consumed too much space. transcriptRow=${firstTranscriptRow}\n${rows.join("\n")}`);
      }
      if (!rows.some((row) => row.includes("◆ ZCODE"))) {
        throw new Error(`Fullscreen context rail was not rendered after the first turn.\n${rows.join("\n")}`);
      }
      if (rows.some((row) => row.includes("Ask a task about this workspace"))) {
        throw new Error(`Fullscreen welcome surface did not collapse after the first turn.\n${rows.join("\n")}`);
      }
      if (firstTranscript(rows) >= firstTranscript(beforeRows)) {
        throw new Error(`Fullscreen transcript did not scroll independently. before=${firstTranscript(beforeRows)} after=${firstTranscript(rows)}`);
      }
      const statusRow = rows.findIndex((row) => row.includes("◈ alpha/model"));
      if (statusRow < 0 || statusRow < 18) {
        throw new Error(`Fullscreen composer was not fixed near the bottom. statusRow=${statusRow}\n${rows.join("\n")}`);
      }
      const resetStart = output.length;
      terminal.write("/cls\r");
      await waitFor(/Ask a task about this workspace/i, resetStart);
      const resetRows = screenRows();
      if (!resetRows.some((row) => /^╭─ Workspace .*─╮$/u.test(row))) {
        throw new Error(`Fullscreen /cls did not restore the welcome frame.\n${resetRows.join("\n")}`);
      }
      if (!resetRows.some((row) => row.includes("Ask a task about this workspace"))) {
        throw new Error(`Fullscreen /cls did not restore the welcome content.\n${resetRows.join("\n")}`);
      }
    }
    terminal.write("\x03");
    await Bun.sleep(40);
    terminal.write("\x03");
  } catch (error) {
    failure = error;
    child.kill("SIGKILL");
  }

  const code = await child.exited;
  clearTimeout(timeout);
  if (!terminal.closed) terminal.close();
  await rm(temporaryHome, { recursive: true, force: true });
  if (failure) throw failure;
  if (code !== 0) throw new Error(`Fullscreen layout smoke exited with ${code}.`);
  console.log(options.copyOnSelect
    ? "Fullscreen fixed-composer layout smoke passed."
    : "Fullscreen copy-on-select opt-out smoke passed.");
}

await runPhase({ copyOnSelect: true });
await runPhase({ copyOnSelect: false });
