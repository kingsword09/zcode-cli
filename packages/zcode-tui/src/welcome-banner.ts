import {
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./terminal-text.ts";
import type { ZCodeTheme } from "./theme.ts";

/** A terminal interpretation of the split, diagonal Z in the Desktop app icon. */
export const BRAND_MARK: readonly string[] = [
  "█████ ▄███",
  "    ▄██▀  ",
  "  ▄██▀    ",
  "▄███ █████"
];

export const BRAND_MARK_WIDTH = 10;
export const WIDE_BANNER_MIN_WIDTH = 48;

const maxInformationWidth = 52;
const boxTitle = "── SYSTEM INITIATED ";

export interface WelcomeBannerOptions {
  branch?: string;
  distributionVersion?: string;
  runtimeVersion: string;
  workspace: string;
}

function bannerText(value: string): string {
  return sanitizeTerminalText(value, { preserveSgr: false }).replace(/\s+/gu, " ").trim();
}

function truncateFromStart(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return "…";
  const suffix: string[] = [];
  for (const character of Array.from(value).reverse()) {
    const candidate = `${character}${suffix.join("")}`;
    if (visibleWidth(`…${candidate}`) > width) break;
    suffix.unshift(character);
  }
  return `…${suffix.join("")}`;
}

function padTerminalText(value: string, width: number): string {
  const truncated = truncateToWidth(value, Math.max(0, width), "…");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function boxRule(prefix: "┌" | "└", width: number): string {
  const content = prefix === "┌" ? boxTitle : "";
  return `${prefix}${content}${"─".repeat(Math.max(0, width - 1 - visibleWidth(content)))}`;
}

export class WelcomeBanner implements Component {
  private readonly branch?: string;
  private readonly distributionVersion?: string;
  private readonly runtimeVersion: string;
  private readonly workspace: string;

  constructor(
    private readonly theme: ZCodeTheme,
    options: WelcomeBannerOptions
  ) {
    this.branch = options.branch
      ? bannerText(options.branch)
      : undefined;
    this.distributionVersion = options.distributionVersion
      ? bannerText(options.distributionVersion)
      : undefined;
    this.runtimeVersion = bannerText(options.runtimeVersion);
    this.workspace = bannerText(options.workspace);
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    return width >= WIDE_BANNER_MIN_WIDTH
      ? this.renderWide(width)
      : this.renderCompact(width);
  }

  invalidate(): void {}

  private renderWide(width: number): string[] {
    const contentWidth = Math.max(1, width - 1);
    const gap = "   ";
    const informationWidth = Math.max(1, contentWidth - BRAND_MARK_WIDTH - gap.length);
    const panelWidth = Math.min(informationWidth, maxInformationWidth);
    const panelContentWidth = Math.max(1, panelWidth - 2);
    const primaryVersion = this.distributionVersion ?? this.runtimeVersion;
    const identity = `${this.theme.bold(this.theme.accent("ZCODE"))}  ${this.theme.muted(`v${primaryVersion}`)}`;
    const fullVersionLine = this.distributionVersion
      ? `${identity}${this.theme.muted(` · runtime v${this.runtimeVersion}`)}`
      : identity;
    const compactVersionLine = this.distributionVersion
      ? `${identity}${this.theme.muted(` · rt v${this.runtimeVersion}`)}`
      : identity;
    const versionLine = visibleWidth(fullVersionLine) <= panelContentWidth
      ? fullVersionLine
      : compactVersionLine;
    const locationLine = this.locationLine(panelContentWidth);
    const information = [
      this.theme.muted(boxRule("┌", panelWidth)),
      `${this.theme.muted("│")} ${padTerminalText(versionLine, panelContentWidth)}`,
      `${this.theme.muted("│")} ${this.theme.muted(padTerminalText(locationLine, panelContentWidth))}`,
      this.theme.muted(boxRule("└", panelWidth))
    ];

    return BRAND_MARK.map((line, index) => (
      ` ${this.theme.accent(line)}${gap}${information[index] ?? ""}`
    ));
  }

  private locationLine(width: number): string {
    if (!this.branch) return truncateFromStart(this.workspace, width);
    const separator = " · ";
    const branchWidth = Math.max(8, Math.min(
      visibleWidth(`branch ${this.branch}`),
      Math.floor(width * 0.45)
    ));
    const branch = truncateToWidth(`branch ${this.branch}`, branchWidth, "…");
    const workspaceWidth = width - visibleWidth(separator) - visibleWidth(branch);
    if (workspaceWidth < 4) return truncateToWidth(branch, width, "…");
    return `${truncateFromStart(this.workspace, workspaceWidth)}${separator}${branch}`;
  }

  private renderCompact(width: number): string[] {
    const contentWidth = Math.max(0, width - 1);
    const primaryVersion = this.distributionVersion ?? this.runtimeVersion;
    const identity = `${this.theme.bold(this.theme.accent("ZCODE"))}  ${this.theme.muted(`v${primaryVersion}`)}`;
    const location = [this.workspace, this.branch ? `branch ${this.branch}` : undefined]
      .filter((value): value is string => Boolean(value))
      .join(" · ");
    return [
      ` ${truncateToWidth(identity, contentWidth)}`,
      ` ${this.theme.muted(truncateFromStart(location, contentWidth))}`
    ];
  }
}

/** A quiet full-width rule separating startup identity from the conversation. */
export class Divider implements Component {
  constructor(
    private readonly char: string,
    private readonly style: (text: string) => string
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [""];
    const baseWidth = Math.max(0, width - 1);
    if (baseWidth < 8) {
      return [` ${this.style(this.char.repeat(baseWidth))}`];
    }
    const prefix = `${this.char.repeat(3)}◆`;
    const suffix = this.char.repeat(Math.max(0, baseWidth - visibleWidth(prefix)));
    return [` ${this.style(truncateToWidth(prefix + suffix, baseWidth))}`];
  }

  invalidate(): void {}
}
