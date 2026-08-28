import { homedir } from "node:os";

import {
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "./terminal-text.ts";
import type { ZCodeTheme } from "./theme.ts";

export type FullscreenHeaderPhase = "welcome" | "transition" | "rail";

export interface FullscreenHeaderOptions {
  branch?: string;
  distributionVersion?: string;
  runtimeVersion: string;
  workspace: string;
  homeDirectory?: string;
}

function clean(value: string | undefined): string | undefined {
  const text = value
    ? sanitizeTerminalText(value, { preserveSgr: false }).replace(/\s+/gu, " ").trim()
    : "";
  return text || undefined;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

export function displayWorkspacePath(workspace: string, homeDirectory = homedir()): string {
  const path = normalizePath(clean(workspace) ?? "");
  const home = normalizePath(clean(homeDirectory) ?? "").replace(/\/+$/u, "");
  if (!path || !home) return path;
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
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

function locationText(
  workspace: string,
  branch: string | undefined,
  width: number,
  homeDirectory: string
): string {
  const path = displayWorkspacePath(workspace, homeDirectory);
  if (!branch) return truncateFromStart(path, width);
  const separator = " · ";
  const branchWidth = Math.min(visibleWidth(branch), Math.max(8, Math.floor(width * 0.36)));
  const branchText = truncateToWidth(branch, branchWidth, "…");
  const pathWidth = width - visibleWidth(separator) - visibleWidth(branchText);
  if (pathWidth <= 0) return truncateToWidth(branchText, width, "…");
  return `${truncateFromStart(path, pathWidth)}${separator}${branchText}`;
}

function fit(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function horizontalRail(content: string, width: number, theme: ZCodeTheme): string {
  const safeWidth = Math.max(1, width);
  if (safeWidth < 5) return fit(content, safeWidth);
  const left = "── ";
  const contentBudget = Math.max(1, safeWidth - visibleWidth(left) - 2);
  const body = fit(content, contentBudget);
  const fill = "─".repeat(Math.max(1, safeWidth - visibleWidth(left) - visibleWidth(body) - 1));
  return fit(`${theme.muted(left)}${body}${theme.muted(` ${fill}`)}`, safeWidth);
}

function frameRule(
  edge: "top" | "bottom",
  title: string,
  width: number,
  theme: ZCodeTheme
): string {
  const [left, right] = edge === "top" ? ["╭─ ", "╮"] : ["╰─ ", "╯"];
  const fixedWidth = visibleWidth(left) + visibleWidth(right) + 2;
  if (width < fixedWidth) {
    return fit(theme.muted("─".repeat(Math.max(1, width))), width);
  }
  const titleBudget = Math.max(1, width - fixedWidth);
  const body = fit(title, titleBudget);
  const fill = "─".repeat(Math.max(
    1,
    width - visibleWidth(left) - visibleWidth(body) - visibleWidth(right) - 1
  ));
  return fit(`${theme.muted(left)}${body}${theme.muted(` ${fill}${right}`)}`, width);
}

function frameContent(content: string, width: number, theme: ZCodeTheme): string {
  if (width < 4) return fit(content, width);
  const innerWidth = width - 4;
  const body = fit(content, innerWidth);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(body)));
  return `${theme.muted("│ ")}${body}${padding}${theme.muted(" │")}`;
}

export class FullscreenHeader implements Component {
  private phase: FullscreenHeaderPhase = "welcome";
  private readonly branch?: string;
  private readonly distributionVersion?: string;
  private readonly runtimeVersion: string;
  private readonly workspace: string;
  private readonly homeDirectory: string;

  constructor(
    private readonly theme: ZCodeTheme,
    options: FullscreenHeaderOptions
  ) {
    this.branch = clean(options.branch);
    this.distributionVersion = clean(options.distributionVersion);
    this.runtimeVersion = clean(options.runtimeVersion) ?? "unknown";
    this.workspace = clean(options.workspace) ?? "";
    this.homeDirectory = options.homeDirectory ?? homedir();
  }

  setPhase(phase: FullscreenHeaderPhase): void {
    this.phase = phase;
  }

  getPhase(): FullscreenHeaderPhase {
    return this.phase;
  }

  location(width: number): string {
    return locationText(
      this.workspace,
      this.branch,
      Math.max(0, width),
      this.homeDirectory
    );
  }

  identity(width: number, includeVersion = true): string {
    const brand = this.theme.bold(this.theme.accent("◆ ZCODE"));
    if (!includeVersion) return fit(brand, Math.max(0, width));
    const version = this.distributionVersion ?? this.runtimeVersion;
    return fit(`${brand}  ${this.theme.muted(`v${version}`)}`, Math.max(0, width));
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.phase === "welcome") {
      return [horizontalRail(this.identity(safeWidth, true), safeWidth, this.theme)];
    }
    if (this.phase === "transition") {
      return [horizontalRail(this.identity(safeWidth, false), safeWidth, this.theme)];
    }

    const identity = this.identity(safeWidth, false);
    const separator = "  ";
    const location = this.location(Math.max(0, safeWidth - visibleWidth(identity) - visibleWidth(separator) - 6));
    return [horizontalRail(`${identity}${separator}${this.theme.muted(location)}`, safeWidth, this.theme)];
  }

  invalidate(): void {}
}

export interface SessionWelcomeOptions {
  loginRequired?: boolean;
  includeIdentity?: boolean;
}

/** One-time startup content that belongs to the transcript, not the chrome. */
export class SessionWelcome implements Component {
  private loginRequired: boolean;
  private includeIdentity: boolean;
  private transitioning = false;

  constructor(
    private readonly theme: ZCodeTheme,
    private readonly location: (width: number) => string,
    private readonly identity: (width: number) => string,
    options: SessionWelcomeOptions = {}
  ) {
    this.loginRequired = options.loginRequired === true;
    this.includeIdentity = options.includeIdentity !== false;
  }

  setLoginRequired(required: boolean): void {
    this.loginRequired = required;
  }

  setIncludeIdentity(include: boolean): void {
    this.includeIdentity = include;
  }

  setTransitioning(transitioning: boolean): void {
    this.transitioning = transitioning;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const frameWidth = Math.max(1, Math.min(safeWidth, 76));
    const innerWidth = Math.max(1, frameWidth - 4);
    const title = this.includeIdentity
      ? this.identity(Math.max(1, frameWidth - 8))
      : this.theme.bold("Workspace");
    const content = [
      frameRule("top", title, frameWidth, this.theme),
      frameContent(this.theme.muted(this.location(innerWidth)), frameWidth, this.theme)
    ];
    if (this.loginRequired) {
      content.push(frameContent(
        this.theme.warning("Model access is not configured · Run /login."),
        frameWidth,
        this.theme
      ));
    }
    content.push(
      frameContent(this.theme.bold("Ask a task about this workspace"), frameWidth, this.theme),
      frameRule(
        "bottom",
        this.theme.muted("/help commands · /status details"),
        frameWidth,
        this.theme
      )
    );
    const lines = content.map((line) => truncateToWidth(line, safeWidth, "…"));
    return this.transitioning
      ? lines.map((line) => this.theme.muted(sanitizeTerminalText(line, { preserveSgr: false })))
      : lines;
  }

  invalidate(): void {}
}
