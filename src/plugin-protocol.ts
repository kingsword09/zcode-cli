import { resolve } from "node:path";

export const pluginProtocolMethods = {
  configure: "plugins/configure",
  describe: "plugins/describe",
  install: "plugins/install",
  marketplaceAdd: "plugins/marketplace/add",
  marketplaceRemove: "plugins/marketplace/remove",
  marketplaceUpdate: "plugins/marketplace/update",
  overview: "plugins/overview",
  referenceCatalog: "plugins/referenceCatalog",
  restoreBuiltin: "plugins/restoreBuiltin",
  update: "plugins/update",
  validate: "plugins/validate"
} as const;

export interface PluginWorkspace {
  workspaceKey: string;
  workspacePath: string;
}

export function pluginWorkspace(path: string): PluginWorkspace {
  const workspacePath = resolve(path);
  return { workspaceKey: workspacePath, workspacePath };
}

export interface PluginReferenceSummary {
  conflictingPluginIds: string[];
  enabled: boolean;
  icon?: string;
  marketplace: string;
  mcpServerNames: string[];
  name: string;
  pluginId: string;
  skillQualifiedNames: string[];
  subagentNames: string[];
}

export interface PluginReferenceCatalogResult {
  authority: "session" | "workspace";
  plugins: PluginReferenceSummary[];
}
