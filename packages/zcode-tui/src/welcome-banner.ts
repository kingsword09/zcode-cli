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
    const primaryVersion = this.distributionVersion ?? this.runtimeVersion;
    const information = [
      `${this.theme.accent(this.theme.bold("ZCODE"))}  ${this.theme.muted(`v${primaryVersion}`)}`,
      this.distributionVersion ? this.theme.muted(`runtime v${this.runtimeVersion}`) : "",
      this.theme.muted(truncateFromStart(this.workspace, informationWidth)),
      this.branch ? this.theme.muted(`branch ${this.branch}`) : ""
    ];
    return BRAND_MARK.map((line, index) => (
      ` ${this.theme.accent(line)}${gap}${truncateToWidth(information[index] ?? "", informationWidth)}`
    ));
  }

  private renderCompact(width: number): string[] {
    const contentWidth = Math.max(0, width - 1);
    const primaryVersion = this.distributionVersion ?? this.runtimeVersion;
    const identity = `${this.theme.accent(this.theme.bold("ZCODE"))}  ${this.theme.muted(`v${primaryVersion}`)}`;
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
    return [` ${this.style(this.char.repeat(Math.max(0, width - 1)))}`];
  }

  invalidate(): void {}
}
