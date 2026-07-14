import {
  Box,
  Text
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./terminal-text.ts";
import type { ZCodeTheme } from "./theme.ts";

export const updateCommand = "npm install -g zcode-app-cli@latest";
export const releaseNotesUrl = "https://github.com/kingsword09/zcode-cli/releases/latest";

export class UpdateAvailableView extends Box {
  constructor(theme: ZCodeTheme, currentVersion: string, latestVersion: string) {
    super(1, 0, theme.toolPendingBackground);
    const current = sanitizeTerminalText(currentVersion, { preserveSgr: false });
    const latest = sanitizeTerminalText(latestVersion, { preserveSgr: false });
    this.addChild(new Text([
      `${theme.accent("✨")} ${theme.bold("Update available!")} ${theme.muted(`${current} → ${latest}`)}`,
      `${theme.muted("Run")} ${theme.accent(updateCommand)} ${theme.muted("to update.")}`,
      `${theme.muted("Release notes:")} ${theme.accent(releaseNotesUrl)}`
    ].join("\n"), 0, 0));
  }
}
