import { basename } from "node:path";

import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { requestAppServer } from "../../../src/app-server-client.ts";
import { pluginProtocolMethods, pluginWorkspace } from "../../../src/plugin-protocol.ts";
import { isRecord, type ListPluginReferences } from "./types.ts";

const pluginIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const pluginReferenceValuePattern = /^\[@[A-Za-z0-9][A-Za-z0-9._-]*\]\(plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*\)$/u;

export interface PluginReferenceEntry {
  description: string;
  marketplace: string;
  name: string;
  pluginId: string;
}

export class PluginReferenceCatalog {
  private cached?: PluginReferenceEntry[];
  private inFlight?: Promise<PluginReferenceEntry[]>;

  constructor(private readonly listPluginReferences?: ListPluginReferences) {}

  async list(): Promise<PluginReferenceEntry[]> {
    if (!this.listPluginReferences) return [];
    if (this.cached) return this.cached;
    if (this.inFlight) return await this.inFlight;

    const request = Promise.resolve()
      .then(() => this.listPluginReferences!())
      .then((result) => {
        const plugins = normalizePluginReferenceEntries(result);
        this.cached = plugins;
        return plugins;
      })
      .catch(() => []);
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function capabilityLabel(count: number, singular: string): string | undefined {
  return count > 0 ? `${count} ${singular}${count === 1 ? "" : "s"}` : undefined;
}

export function normalizePluginReferenceEntries(result: unknown): PluginReferenceEntry[] {
  if (!isRecord(result) || !Array.isArray(result.plugins)) return [];
  const plugins: PluginReferenceEntry[] = [];
  const seen = new Set<string>();

  for (const candidate of result.plugins) {
    if (!isRecord(candidate) || candidate.enabled !== true) continue;
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const marketplace = typeof candidate.marketplace === "string" ? candidate.marketplace : "";
    const pluginId = typeof candidate.pluginId === "string" ? candidate.pluginId : "";
    if (
      !pluginIdentifierPattern.test(name)
      || !pluginIdentifierPattern.test(marketplace)
      || pluginId !== `${name}@${marketplace}`
      || seen.has(pluginId)
      || stringArray(candidate.conflictingPluginIds).length > 0
    ) {
      continue;
    }

    const skills = stringArray(candidate.skillQualifiedNames).length;
    const mcpServers = stringArray(candidate.mcpServerNames).length;
    const subagents = stringArray(candidate.subagentNames).length;
    if (skills + mcpServers + subagents === 0) continue;
    const capabilities = [
      capabilityLabel(skills, "skill"),
      capabilityLabel(mcpServers, "MCP server"),
      capabilityLabel(subagents, "subagent")
    ].filter((value): value is string => Boolean(value));

    seen.add(pluginId);
    plugins.push({
      description: `Plugin | ${marketplace} | ${capabilities.join(", ")}`,
      marketplace,
      name,
      pluginId
    });
  }

  return plugins.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

export function pluginReferenceMarkdown(plugin: PluginReferenceEntry): string {
  return `[@${plugin.name}](plugin://${plugin.pluginId})`;
}

export function isPluginReferenceValue(value: string): boolean {
  return pluginReferenceValuePattern.test(value);
}

export function pluginReferenceSuggestions(
  plugins: PluginReferenceEntry[],
  query: string,
  limit: number
): AutocompleteItem[] {
  const normalizedQuery = query.toLowerCase();
  return plugins
    .filter((plugin) => (
      normalizedQuery.length === 0
      || plugin.name.toLowerCase().includes(normalizedQuery)
      || plugin.pluginId.toLowerCase().includes(normalizedQuery)
    ))
    .sort((left, right) => {
      const leftStarts = left.name.toLowerCase().startsWith(normalizedQuery);
      const rightStarts = right.name.toLowerCase().startsWith(normalizedQuery);
      return leftStarts === rightStarts ? left.pluginId.localeCompare(right.pluginId) : leftStarts ? -1 : 1;
    })
    .slice(0, limit)
    .map((plugin) => ({
      value: pluginReferenceMarkdown(plugin),
      label: `@${plugin.name}`,
      description: plugin.description
    }));
}

export function createRuntimePluginReferenceLister(
  workspaceDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): ListPluginReferences | undefined {
  const runtimeEntry = argv[1];
  const directRuntime = runtimeEntry && basename(runtimeEntry) === "zcode.cjs"
    ? { args: [runtimeEntry, "app-server"], command: process.execPath }
    : undefined;
  const launcherExecutable = env.ZCODE_APP_CLI_EXECUTABLE?.trim();
  const launcherEntry = env.ZCODE_APP_CLI_ENTRY?.trim();
  const transport = directRuntime ?? (
    launcherExecutable && launcherEntry
      ? { args: [launcherEntry, "app-server"], command: launcherExecutable }
      : undefined
  );
  if (!transport) return undefined;

  return async () => await requestAppServer({
    method: pluginProtocolMethods.referenceCatalog,
    params: { workspace: pluginWorkspace(workspaceDirectory) },
    transport: {
      ...transport,
      cwd: workspaceDirectory,
      env
    }
  });
}
