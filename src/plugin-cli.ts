import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";

import { pluginProtocolMethods, pluginWorkspace } from "./plugin-protocol.ts";

const coordinateSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const managedActions = new Set([
  "configure",
  "describe",
  "discover",
  "help",
  "install",
  "marketplace",
  "overview",
  "restore",
  "update",
  "validate"
]);

const pluginUsage = `Usage:
  zcode plugins discover [--json]
  zcode plugins overview [--json]
  zcode plugins marketplace list
  zcode plugins marketplace add <source> [--dry-run] [--yes]
  zcode plugins marketplace remove <marketplace> [--yes]
  zcode plugins marketplace update [marketplace]
  zcode plugins install <name>@<marketplace> [--scope user|workspace] [--dry-run] [--yes]
  zcode plugins update [plugin-id] [--marketplace <marketplace>]
  zcode plugins describe <name>@<marketplace>
  zcode plugins validate <name>@<marketplace>
  zcode plugins validate --source <source>
  zcode plugins configure <plugin-id> --options-file <json-file> [--dry-run]
  zcode plugins restore <plugin-id>

Existing list, enable, disable, and uninstall commands are handled by the ZCode runtime.`;

interface ParsedPluginCommand {
  action: string;
  baseDirectory: string;
  dryRun: boolean;
  help: boolean;
  json: boolean;
  marketplace?: string;
  optionsFile?: string;
  positionals: string[];
  scope?: "user" | "workspace";
  source?: string;
  yes: boolean;
}

export interface PluginRequestInput {
  method: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  workingDirectory: string;
}

export interface RunPluginCommandOptions {
  confirm?: (question: string) => Promise<boolean>;
  cwd?: string;
  request: (input: PluginRequestInput) => Promise<unknown>;
  signal?: AbortSignal;
  stderr?: Writable & { isTTY?: boolean };
  stdin?: Readable & { isTTY?: boolean };
  stdout?: Writable & { isTTY?: boolean };
}

interface PluginCoordinate {
  marketplace: string;
  pluginName: string;
}

type PluginSpecificOption = "dryRun" | "marketplace" | "optionsFile" | "scope" | "source" | "yes";

const leadingBooleanOptions = new Set(["--json", "--no-color", "--verbose"]);
const leadingValueOptions = new Set(["--cwd", "--locale"]);

function managedAction(args: string[]): string | undefined {
  let index = 0;
  while (index < args.length) {
    const argument = args[index]!;
    if (leadingBooleanOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (leadingValueOptions.has(argument)) {
      index += 2;
      continue;
    }
    if (["--cwd=", "--locale="].some((prefix) => argument.startsWith(prefix))) {
      index += 1;
      continue;
    }
    break;
  }
  if (args[index] !== "plugins") return undefined;
  const action = args[index + 1];
  if ((!action || action.startsWith("-")) && args.includes("--help")) return "help";
  return action && managedActions.has(action) ? action : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function printable(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  return Array.from(raw, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : character;
  }).join("");
}

function printableError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw.split(/\r\n?|\n/u).map((line) => printable(line)).join("\n");
}

function parseCoordinate(value: string): PluginCoordinate {
  const separator = value.indexOf("@");
  const pluginName = separator < 0 ? value : value.slice(0, separator);
  const marketplace = separator < 0 ? undefined : value.slice(separator + 1);
  if (
    !marketplace
    || separator !== value.lastIndexOf("@")
    || !coordinateSegmentPattern.test(pluginName)
    || !coordinateSegmentPattern.test(marketplace)
  ) {
    throw new Error(`Invalid plugin coordinate: ${value}. Expected <name>@<marketplace>.`);
  }
  return { marketplace, pluginName };
}

function parsePluginCommand(args: string[], cwd: string): ParsedPluginCommand | undefined {
  const expectedAction = managedAction(args);
  if (!expectedAction) return undefined;
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      cwd: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { short: "h", type: "boolean" },
      json: { type: "boolean" },
      locale: { type: "string" },
      marketplace: { type: "string" },
      "no-color": { type: "boolean" },
      "options-file": { type: "string" },
      scope: { type: "string" },
      source: { type: "string" },
      verbose: { type: "boolean" },
      yes: { short: "y", type: "boolean" }
    },
    strict: true
  });

  if (parsed.positionals[0] !== "plugins") return undefined;
  const action = parsed.positionals[1] ?? expectedAction;

  const scope = parsed.values.scope;
  if (scope !== undefined && scope !== "user" && scope !== "workspace") {
    throw new Error(`Unsupported plugin scope: ${scope}. Expected user or workspace.`);
  }
  return {
    action,
    baseDirectory: resolve(cwd, text(parsed.values.cwd) ?? "."),
    dryRun: parsed.values["dry-run"] === true,
    help: parsed.values.help === true,
    json: parsed.values.json === true,
    marketplace: text(parsed.values.marketplace),
    optionsFile: text(parsed.values["options-file"]),
    positionals: parsed.positionals.slice(2),
    scope,
    source: text(parsed.values.source),
    yes: parsed.values.yes === true
  };
}

function assertSupportedOptions(
  command: ParsedPluginCommand,
  supported: PluginSpecificOption[],
  usage: string
): void {
  const allowed = new Set(supported);
  const used: Array<[PluginSpecificOption, boolean]> = [
    ["dryRun", command.dryRun],
    ["marketplace", command.marketplace !== undefined],
    ["optionsFile", command.optionsFile !== undefined],
    ["scope", command.scope !== undefined],
    ["source", command.source !== undefined],
    ["yes", command.yes]
  ];
  const unsupported = used.filter(([name, present]) => present && !allowed.has(name));
  if (unsupported.length === 0) return;

  const displayNames: Record<PluginSpecificOption, string> = {
    dryRun: "--dry-run",
    marketplace: "--marketplace",
    optionsFile: "--options-file",
    scope: "--scope",
    source: "--source",
    yes: "--yes"
  };
  const options = unsupported.map(([name]) => displayNames[name]).join(", ");
  throw new Error(`${options} ${unsupported.length === 1 ? "is" : "are"} not supported.\n${usage}`);
}

function writeJson(output: Writable, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function diagnostics(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.diagnostics)) return [];
  return value.diagnostics.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const message = text(entry.message);
    return message ? [`${printable(text(entry.severity) ?? "warning")}: ${printable(message)}`] : [];
  });
}

function hasErrorDiagnostics(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.diagnostics)
    && value.diagnostics.some((entry) => isRecord(entry) && entry.severity === "error");
}

function resultFailed(value: unknown): boolean {
  return hasErrorDiagnostics(value) || (isRecord(value) && value.ok === false);
}

function listSection(
  output: Writable,
  title: string,
  values: unknown,
  format: (item: Record<string, unknown>) => string
): void {
  output.write(`${title}:\n`);
  const items = Array.isArray(values) ? values.filter(isRecord) : [];
  if (items.length === 0) {
    output.write("  (none)\n");
    return;
  }
  for (const item of items) output.write(`  - ${format(item)}\n`);
}

function renderOverview(output: Writable, result: unknown, marketplacesOnly = false): void {
  const overview = isRecord(result) ? result : {};
  listSection(output, "Marketplaces", overview.marketplaces, (item) => {
    const count = typeof item.pluginCount === "number" ? ` (${item.pluginCount} plugins)` : "";
    return `${printable(item.id)}${count}${item.isOfficial === true ? " [official]" : ""}`;
  });
  if (marketplacesOnly) return;
  listSection(output, "Available plugins", overview.availablePlugins, (item) => {
    const version = text(item.version) ? ` v${printable(item.version)}` : "";
    return `${printable(item.name)}@${printable(item.marketplace)}${version}`;
  });
  listSection(output, "Installed marketplace plugins", overview.installedPlugins, (item) => (
    `${printable(item.id)}${item.enabled === false ? " [disabled]" : " [enabled]"}`
  ));
  listSection(output, "Restorable built-ins", overview.restorableBuiltins, (item) => printable(item.id));
  for (const diagnostic of diagnostics(overview)) output.write(`Diagnostic: ${diagnostic}\n`);
}

function componentSummary(result: unknown): string[] {
  if (!isRecord(result) || !Array.isArray(result.components)) return [];
  return result.components.flatMap((component) => {
    if (!isRecord(component) || !text(component.kind) || !Array.isArray(component.items)) return [];
    const names = component.items.flatMap((item) => isRecord(item) && text(item.name) ? [printable(item.name)] : []);
    return names.length > 0 ? [`${printable(component.kind)}: ${names.join(", ")}`] : [];
  });
}

function renderInstallPreview(
  output: Writable,
  coordinate: PluginCoordinate,
  description: unknown,
  plan?: unknown
): void {
  output.write(`Plugin: ${coordinate.pluginName}@${coordinate.marketplace}\n`);
  if (isRecord(description) && isRecord(description.metadata)) {
    const metadata = description.metadata;
    const details = [
      text(metadata.version) && `v${printable(metadata.version)}`,
      text(metadata.author) && printable(metadata.author)
    ].filter(Boolean);
    if (details.length > 0) output.write(`Metadata: ${details.join(" | ")}\n`);
  }
  const components = componentSummary(description);
  output.write(`Components: ${components.length > 0 ? components.join("; ") : "none declared"}\n`);
  if (isRecord(plan) && Array.isArray(plan.dependencyClosure)) {
    const closure = plan.dependencyClosure.map(printable);
    output.write(`Dependencies: ${closure.length > 0 ? closure.join(", ") : "none"}\n`);
  }
  for (const diagnostic of [...diagnostics(description), ...diagnostics(plan)]) {
    output.write(`Diagnostic: ${diagnostic}\n`);
  }
}

function renderMutation(
  output: Writable,
  result: unknown,
  labels: { failure: string; success: string },
  changesApply = true
): void {
  const failed = resultFailed(result);
  output.write(`${failed ? labels.failure : labels.success}\n`);
  if (isRecord(result)) {
    const installed = Array.isArray(result.installedPlugins) ? result.installedPlugins.filter(isRecord) : [];
    for (const plugin of installed) output.write(`  - ${printable(plugin.id)}\n`);
    if (isRecord(result.marketplace)) output.write(`  - ${printable(result.marketplace.id)}\n`);
    if (text(result.pluginId)) output.write(`  - ${printable(result.pluginId)}\n`);
  }
  for (const diagnostic of diagnostics(result)) output.write(`Diagnostic: ${diagnostic}\n`);
  if (changesApply && !failed) output.write("Plugin capability changes apply to new sessions.\n");
}

async function defaultConfirm(
  question: string,
  input: Readable & { isTTY?: boolean },
  output: Writable & { isTTY?: boolean },
  signal?: AbortSignal
): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) return false;
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(`${question} [y/N] `, { signal });
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

async function readOptionsFile(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Plugin options file must contain a JSON object.");
  return parsed;
}

export async function runPluginCommand(
  args: string[],
  options: RunPluginCommandOptions
): Promise<number | undefined> {
  let command: ParsedPluginCommand | undefined;
  try {
    command = parsePluginCommand(args, options.cwd ?? process.cwd());
  } catch (error) {
    (options.stderr ?? process.stderr).write(`Error: ${printableError(error)}\n`);
    return 1;
  }
  if (!command) return undefined;

  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const stdin = options.stdin ?? process.stdin;
  const confirm = options.confirm ?? (
    (question: string) => defaultConfirm(question, stdin, stderr, options.signal)
  );
  const workspace = pluginWorkspace(command.baseDirectory);
  const call = async (method: string, params: Record<string, unknown>) => await options.request({
    method,
    params: { workspace, ...params },
    signal: options.signal,
    workingDirectory: command!.baseDirectory
  });
  const ensureCatalog = async () => {
    const result = await call(pluginProtocolMethods.overview, {});
    if (hasErrorDiagnostics(result)) {
      throw new Error(`Plugin catalog is unavailable: ${diagnostics(result).join("; ")}`);
    }
  };
  const print = (value: unknown, human: () => void) => command!.json ? writeJson(stdout, value) : human();

  if (command.help || command.action === "help") {
    stdout.write(`${pluginUsage}\n`);
    return 0;
  }

  try {
    if (command.action === "discover" || command.action === "overview") {
      const usage = `Usage: zcode plugins ${command.action}`;
      assertSupportedOptions(command, [], usage);
      if (command.positionals.length > 0) throw new Error(usage);
      const result = await call(pluginProtocolMethods.overview, {});
      print(result, () => renderOverview(stdout, result));
      return hasErrorDiagnostics(result) ? 1 : 0;
    }

    if (command.action === "marketplace") {
      const [operation, value, ...extra] = command.positionals;
      if (!operation || extra.length > 0) throw new Error(pluginUsage);
      if (operation === "list") {
        const usage = "Usage: zcode plugins marketplace list";
        assertSupportedOptions(command, [], usage);
        if (value) throw new Error(usage);
        const result = await call(pluginProtocolMethods.overview, {});
        print(result, () => renderOverview(stdout, result, true));
        return hasErrorDiagnostics(result) ? 1 : 0;
      }
      if (operation === "add") {
        const usage = "Usage: zcode plugins marketplace add <source> [--dry-run] [--yes]";
        assertSupportedOptions(command, ["dryRun", "yes"], usage);
        if (!value) throw new Error(usage);
        const preview = await call(pluginProtocolMethods.marketplaceAdd, { source: value, dryRun: true });
        if (command.dryRun) {
          print(preview, () => renderMutation(stdout, preview, {
            failure: "Marketplace validation failed.",
            success: "Marketplace validation succeeded."
          }, false));
          return resultFailed(preview) ? 1 : 0;
        }
        if (resultFailed(preview)) {
          print(preview, () => renderMutation(stdout, preview, {
            failure: "Marketplace validation failed.",
            success: "Marketplace validation succeeded."
          }, false));
          return 1;
        }
        if (!command.json) {
          renderMutation(stdout, preview, {
            failure: "Marketplace validation failed.",
            success: "Marketplace validation succeeded."
          }, false);
        }
        if (!command.yes && !await confirm(`Add marketplace from ${printable(value)}?`)) {
          throw new Error("Marketplace addition cancelled. Use --yes for non-interactive use.");
        }
        const result = await call(pluginProtocolMethods.marketplaceAdd, { source: value });
        print(result, () => renderMutation(stdout, result, {
          failure: "Marketplace addition failed.",
          success: "Marketplace added."
        }, false));
        return resultFailed(result) ? 1 : 0;
      }
      if (operation === "remove") {
        const usage = "Usage: zcode plugins marketplace remove <marketplace> [--yes]";
        assertSupportedOptions(command, ["yes"], usage);
        if (!value) throw new Error(usage);
        if (!command.yes && !await confirm(`Remove marketplace ${printable(value)}?`)) {
          throw new Error("Marketplace removal cancelled. Use --yes for non-interactive use.");
        }
        const result = await call(pluginProtocolMethods.marketplaceRemove, { marketplace: value });
        print(result, () => renderMutation(stdout, result, {
          failure: "Marketplace removal failed.",
          success: "Marketplace removed."
        }, false));
        return resultFailed(result) ? 1 : 0;
      }
      if (operation === "update") {
        assertSupportedOptions(command, [], "Usage: zcode plugins marketplace update [marketplace]");
        const result = await call(pluginProtocolMethods.marketplaceUpdate, value ? { marketplace: value } : {});
        print(result, () => renderMutation(stdout, result, {
          failure: "Marketplace index update failed.",
          success: "Marketplace index updated."
        }, false));
        return resultFailed(result) ? 1 : 0;
      }
      throw new Error(`Unknown marketplace command: ${operation}\n${pluginUsage}`);
    }

    if (command.action === "install") {
      const [target, ...extra] = command.positionals;
      const usage = "Usage: zcode plugins install <name>@<marketplace> [--scope user|workspace] [--dry-run] [--yes]";
      assertSupportedOptions(command, ["dryRun", "scope", "yes"], usage);
      if (!target || extra.length > 0) throw new Error(usage);
      const coordinate = parseCoordinate(target);
      await ensureCatalog();
      const baseParams = {
        marketplace: coordinate.marketplace,
        pluginName: coordinate.pluginName,
        ...(command.scope ? { scope: command.scope } : {})
      };
      const description = await call(pluginProtocolMethods.describe, { ...coordinate });
      const plan = await call(pluginProtocolMethods.install, { ...baseParams, dryRun: true });
      if (command.dryRun) {
        const preview = { description, plan };
        print(preview, () => renderInstallPreview(stdout, coordinate, description, plan));
        return resultFailed(description) || resultFailed(plan) ? 1 : 0;
      }
      if (resultFailed(description) || resultFailed(plan)) {
        const preview = { description, plan };
        print(preview, () => renderInstallPreview(stdout, coordinate, description, plan));
        return 1;
      }
      if (!command.json) renderInstallPreview(stdout, coordinate, description, plan);
      if (!command.yes && !await confirm(`Install ${coordinate.pluginName}@${coordinate.marketplace}?`)) {
        throw new Error("Plugin installation cancelled. Use --yes for non-interactive use.");
      }
      const result = await call(pluginProtocolMethods.install, baseParams);
      print(result, () => renderMutation(stdout, result, {
        failure: "Plugin installation failed.",
        success: "Plugin installed."
      }));
      return resultFailed(result) ? 1 : 0;
    }

    if (command.action === "describe") {
      const [target, ...extra] = command.positionals;
      const usage = "Usage: zcode plugins describe <name>@<marketplace>";
      assertSupportedOptions(command, [], usage);
      if (!target || extra.length > 0) throw new Error(usage);
      const coordinate = parseCoordinate(target);
      await ensureCatalog();
      const result = await call(pluginProtocolMethods.describe, { ...coordinate });
      print(result, () => renderInstallPreview(stdout, coordinate, result));
      return resultFailed(result) ? 1 : 0;
    }

    if (command.action === "validate") {
      const [target, ...extra] = command.positionals;
      const usage = "Usage: zcode plugins validate <name>@<marketplace> | --source <source>";
      assertSupportedOptions(command, ["source"], usage);
      if (extra.length > 0 || (!target && !command.source) || (target && command.source)) {
        throw new Error(usage);
      }
      const params = target ? { ...parseCoordinate(target) } : { source: command.source! };
      if (target) await ensureCatalog();
      const result = await call(pluginProtocolMethods.validate, params);
      print(result, () => renderMutation(stdout, result, {
        failure: "Plugin validation failed.",
        success: "Plugin validation completed."
      }, false));
      return resultFailed(result) ? 1 : 0;
    }

    if (command.action === "update") {
      const [pluginId, ...extra] = command.positionals;
      const usage = "Usage: zcode plugins update [plugin-id] [--marketplace <marketplace>]";
      assertSupportedOptions(command, ["marketplace"], usage);
      if (extra.length > 0 || (pluginId && command.marketplace)) {
        throw new Error(usage);
      }
      const result = await call(pluginProtocolMethods.update, {
        ...(pluginId ? { pluginId } : {}),
        ...(command.marketplace ? { marketplace: command.marketplace } : {})
      });
      print(result, () => renderMutation(stdout, result, {
        failure: "Plugin update failed.",
        success: "Plugin update completed."
      }));
      return resultFailed(result) ? 1 : 0;
    }

    if (command.action === "configure") {
      const [pluginId, ...extra] = command.positionals;
      const usage = "Usage: zcode plugins configure <plugin-id> --options-file <json-file> [--dry-run]";
      assertSupportedOptions(command, ["dryRun", "optionsFile"], usage);
      if (!pluginId || extra.length > 0 || !command.optionsFile) {
        throw new Error(usage);
      }
      const configuredOptions = await readOptionsFile(resolve(command.baseDirectory, command.optionsFile));
      const result = await call(pluginProtocolMethods.configure, {
        pluginId,
        options: configuredOptions,
        ...(command.dryRun ? { dryRun: true } : {})
      });
      print(result, () => renderMutation(stdout, result, {
        failure: "Plugin configuration failed.",
        success: command.dryRun ? "Plugin configuration is valid." : "Plugin configured."
      }, !command.dryRun));
      return resultFailed(result) ? 1 : 0;
    }

    if (command.action === "restore") {
      const [pluginId, ...extra] = command.positionals;
      const usage = "Usage: zcode plugins restore <plugin-id>";
      assertSupportedOptions(command, [], usage);
      if (!pluginId || extra.length > 0) throw new Error(usage);
      const result = await call(pluginProtocolMethods.restoreBuiltin, { pluginId });
      print(result, () => renderMutation(stdout, result, {
        failure: "Built-in plugin restore failed.",
        success: "Built-in plugin restored."
      }));
      return resultFailed(result) ? 1 : 0;
    }

    throw new Error(pluginUsage);
  } catch (error) {
    stderr.write(`Error: ${printableError(error)}\n`);
    return error instanceof Error && error.name === "AbortError" ? 130 : 1;
  }
}
