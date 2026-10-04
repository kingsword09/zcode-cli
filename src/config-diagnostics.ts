import { existsSync } from "node:fs";
import { desktopSettingsPath, legacyCliConfigPath, providerConfigPath } from "./config-paths.ts";

interface NativeDiagnostic {
  code: string;
  message: string;
  filePath?: string;
  path?: string;
  severity: string;
}

interface NativeSource {
  path?: string;
  paths?: string[];
  loaded: boolean;
  diagnostics: NativeDiagnostic[];
  mcpServerNames: string[];
}

interface NativeConfigResult {
  config: {
    features: { mcp: boolean };
    mcp: { servers: Record<string, { type: string; enabled?: boolean }> };
  };
  sources: {
    user: NativeSource;
    project: NativeSource;
    mcp: { serverSources: Record<string, string> };
  };
}

export interface ConfigurationDiagnostic {
  code: string;
  scope: "user" | "project" | "desktop";
  severity: string;
  filePath?: string;
  path?: string;
  message: string;
}

export interface ConfigurationReport {
  ok: boolean;
  user: { path?: string; status: "loaded" | "missing" | "invalid"; mcpServerNames: string[] };
  project: { paths: string[]; status: "loaded" | "missing" | "invalid"; mcpServerNames: string[] };
  provider: { path?: string };
  legacy: { path: string; exists: boolean; usage: "first-run-migration-only" };
  mcp: { enabled: boolean; servers: { name: string; type: string; enabled: boolean; source: string }[] };
  diagnostics: ConfigurationDiagnostic[];
}

const schemaDiagnosticPrefix = /^(?:<config>|modelStream|permission|storage|network|features|memory|mcp|plugins|skills|skill|command|logging|ui|toolConcurrency|modelAnomalyGuard|hooks)(?:[.:[\]]|$)/u;

function publicDiagnostic(diagnostic: NativeDiagnostic, scope: "user" | "project"): ConfigurationDiagnostic {
  // JSON.parse 的错误消息可能回显带密钥的原文片段；只保留 schema 生成的字段错误。
  const message = diagnostic.code === "config_file_invalid" && !schemaDiagnosticPrefix.test(diagnostic.message)
    ? "Unable to read or parse configuration JSON. Check the file syntax and permissions."
    : diagnostic.message;
  return {
    code: diagnostic.code, scope, severity: diagnostic.severity,
    filePath: diagnostic.filePath, path: diagnostic.path, message
  };
}

function sourceStatus(source: NativeSource): "loaded" | "missing" | "invalid" {
  if (source.diagnostics.some(diagnostic => diagnostic.code === "config_file_invalid")) return "invalid";
  return source.loaded ? "loaded" : "missing";
}

/** Inspect the runtime's resolved configuration without starting providers, plugins or MCP connections. */
export function inspectRuntimeConfiguration(
  workingDirectory: string,
  createConfig: (options: { workingDirectory: string; env: NodeJS.ProcessEnv; loggerFactory: unknown }) => NativeConfigResult,
  env: NodeJS.ProcessEnv = process.env
): ConfigurationReport {
  // doctor 展示经过筛选的诊断，不让原生 logger 另行输出原始配置错误片段。
  const logger = { child: () => logger, warn() {} };
  const result = createConfig({ workingDirectory, env, loggerFactory: { createLogger: () => logger } });
  const diagnostics = [
    ...result.sources.user.diagnostics.map(diagnostic => publicDiagnostic(diagnostic, "user")),
    ...result.sources.project.diagnostics.map(diagnostic => publicDiagnostic(diagnostic, "project"))
  ];
  let providerPath: string | undefined;
  try { providerPath = providerConfigPath(env); } catch {
    diagnostics.push({ code: "desktop_settings_invalid", scope: "desktop", severity: "error",
      filePath: desktopSettingsPath(env), message: "Desktop settings could not be read to resolve the provider configuration path." });
  }
  const legacyPath = legacyCliConfigPath(env);
  return {
    ok: !diagnostics.some(diagnostic => diagnostic.severity === "error" || diagnostic.code === "config_mcp_server_invalid"),
    user: { path: result.sources.user.path, status: sourceStatus(result.sources.user), mcpServerNames: result.sources.user.mcpServerNames },
    project: {
      paths: [...new Set([
        ...result.sources.project.paths ?? [],
        ...result.sources.project.diagnostics.flatMap(diagnostic => diagnostic.filePath ? [diagnostic.filePath] : [])
      ])],
      status: sourceStatus(result.sources.project), mcpServerNames: result.sources.project.mcpServerNames
    },
    provider: { path: providerPath },
    legacy: { path: legacyPath, exists: existsSync(legacyPath), usage: "first-run-migration-only" },
    mcp: {
      enabled: result.config.features.mcp,
      servers: Object.entries(result.config.mcp.servers).map(([name, server]) => ({
        name, type: server.type, enabled: server.enabled !== false,
        source: result.sources.mcp.serverSources[name] ?? "unknown"
      })).sort((left, right) => left.name.localeCompare(right.name))
    },
    diagnostics
  };
}

function printable(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function writeConfigurationDoctor(output: { write(text: string): unknown }, report: ConfigurationReport): number {
  const lines = [
    "", "Configuration:",
    `  user: ${report.user.path ?? "unknown"} (${report.user.status})`,
    `  project: ${report.project.paths.join(", ") || "none"} (${report.project.status})`,
    `  providers: ${report.provider.path ?? "unavailable"}`,
    `  legacy: ${report.legacy.path} (${report.legacy.exists ? "present; migration source only" : "absent"})`,
    `  MCP: ${report.mcp.enabled ? "enabled" : "disabled"}; ${report.mcp.servers.length} configured server(s)`,
    ...report.mcp.servers.map(server => `    ${JSON.stringify(server.name)}: ${server.type}, ${server.source}, ${server.enabled ? "enabled" : "disabled"}`),
    "  Plugin and built-in MCP servers are added at session startup; connections were not tested.",
    ...report.diagnostics.map(diagnostic => `  ${diagnostic.severity}: ${diagnostic.filePath ?? diagnostic.scope}${diagnostic.path ? ` [${diagnostic.path}]` : ""}: ${diagnostic.message}`)
  ];
  output.write(lines.map(printable).join("\n") + "\n");
  return report.ok ? 0 : 1;
}
