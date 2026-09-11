// Auto permission classifier: a middle permission tier between "ask for
// everything" (build) and "bypass everything" (yolo).
//
// Inspired by Claude Code's `auto` permission mode. Classification happens in
// the TUI layer, at the seam where the runtime's permission request would
// otherwise render a dialog: allow/deny verdicts return the same response
// objects the dialog produces ({ decision, reason, permissionUpdates }), and
// unmatched requests return null so the normal human dialog runs.
//
// The classifier is fail-open toward the dialog by design: any internal
// error, missing config, or unmatched request defers to the user. It can
// never widen yolo mode (it only runs when a prompt would show) and cannot
// override runtime-side explicit deny rules (those never reach a prompt).

import { existsSync, readFileSync } from "node:fs"

import { asString, isRecord } from "./types.ts"

export interface AutoPermissionRule {
  tool: string | string[]
  commandPrefix?: string
  commandRegex?: string
  pathPrefix?: string
  pathRegex?: string
  note?: string
}

export interface AutoPermissionConfig {
  defaults: { unmatched: "ask" | "allow" | "deny" }
  allow: AutoPermissionRule[]
  softDeny: AutoPermissionRule[]
  hardDeny: AutoPermissionRule[]
}

export interface PermissionRequestShape {
  toolName: string
  input: unknown
  riskLevel?: string
}

export interface AutoPermissionVerdict {
  behavior: "allow" | "deny"
  reason: string
  matchedRule: AutoPermissionRule
}

// Paths that carry credentials. Never auto-approved; denied outright when a
// hardDeny rule targets them.
//
// Boundaries are token-aware because these regexes also run against whole
// command strings, where the credential path sits mid-token: a dotfile name
// must not be glued to a preceding name character (`my.env` is a different
// file, `cat .env` is not), while anything after it that is not a name
// character ends the token — including shell separators (`;`, `|`, `&`,
// whitespace, quotes) and another dotted component (`.env.local` is the same
// credential family). `*.pem` is a suffix convention rather than a dotfile,
// so only its trailing boundary matters.
const secretPathPattern = String.raw`(^|[^A-Za-z0-9_.-])\.(env|ssh|aws|gnupg|kube|netrc|npmrc)($|[^A-Za-z0-9_-])|\.pem($|[^A-Za-z0-9_-])|id_rsa|credentials`

function ruleToBuiltin(rule: Omit<AutoPermissionRule, "note">, note: string): AutoPermissionRule {
  return { ...rule, note }
}

export function builtinAutoPermissionConfig(): AutoPermissionConfig {
  const readOnlyCommands = [
    "git status",
    "git log",
    "git diff",
    "git show",
    "git branch",
    "ls",
    "pwd",
    "cat",
    "head",
    "tail",
    "wc",
    "rg",
    "grep",
    "which",
    "file",
    "stat"
  ]
  // `find` is read-only only while it carries no mutating action: -exec,
  // -execdir, -ok and -okdir run arbitrary programs, and -delete, -fprint*,
  // -fls write or remove files, so a bare `find` prefix rule would
  // auto-allow `find . -exec sh ...`. The classifier sees the command as one
  // string, so the lookahead scans the whole command — bounding it at a
  // shell separator let `find . ; find . -exec ...` (or a separator inside a
  // quoted argument) slip past — and the trailing \b keeps quoted flags
  // covered without blocking -executable. Anything the guard blocks falls
  // through to the dialog.
  const findAllow = String.raw`^find\b(?![\s\S]*-(?:execdir|exec|okdir|ok|delete|fprintf|fprint0|fprint|fls)\b)`
  return {
    defaults: { unmatched: "ask" },
    allow: [
      ...readOnlyCommands.map((command) => ruleToBuiltin({ tool: "Bash", commandPrefix: command }, "read-only command")),
      ruleToBuiltin({ tool: "Bash", commandRegex: findAllow }, "read-only command (find without mutating actions)"),
      ruleToBuiltin({ tool: ["Read", "Glob", "Grep", "TodoRead", "WebSearch"] }, "read-only tool")
    ],
    softDeny: [
      ruleToBuiltin({ tool: "Bash", commandRegex: String.raw`\bgit\s+reset\s+--hard\b` }, "history rewrite of working tree")
    ],
    hardDeny: [
      ruleToBuiltin({ tool: "Bash", commandRegex: String.raw`\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r` }, "recursive force delete"),
      ruleToBuiltin({ tool: "Bash", commandRegex: String.raw`\bsudo\s` }, "privilege escalation"),
      ruleToBuiltin({ tool: "Bash", commandRegex: String.raw`\b(curl|wget)\b[^|;&]*\|\s*(ba|z|fi)?sh\b` }, "remote code piped to shell"),
      ruleToBuiltin({ tool: "Bash", commandRegex: String.raw`\bgit\s+push\b[^;&]*--force` }, "force push"),
      ruleToBuiltin({ tool: ["Read", "Write", "Edit"], pathRegex: secretPathPattern }, "credential path"),
      ruleToBuiltin({ tool: "Bash", commandRegex: secretPathPattern }, "credential path in command")
    ]
  }
}

export function loadAutoPermissionConfig(configPath: string | undefined): AutoPermissionConfig {
  const base = builtinAutoPermissionConfig()
  if (!configPath) return base
  try {
    if (!existsSync(configPath)) return base
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"))
    if (!isRecord(parsed)) return base
    const defaults = isRecord(parsed.defaults) ? parsed.defaults : {}
    const unmatched = defaults.unmatched === "allow" || defaults.unmatched === "deny" || defaults.unmatched === "ask"
      ? defaults.unmatched
      : base.defaults.unmatched
    const rules = (key: "allow" | "softDeny" | "hardDeny"): AutoPermissionRule[] => {
      const value = parsed[key]
      if (!Array.isArray(value)) return base[key]
      return value.flatMap((entry): AutoPermissionRule[] => {
        if (!isRecord(entry)) return []
        const tool = asString(entry.tool) ?? (Array.isArray(entry.tool) ? entry.tool.filter((item): item is string => typeof item === "string") : undefined)
        if (!tool) return []
        return [{
          tool,
          commandPrefix: asString(entry.commandPrefix),
          commandRegex: asString(entry.commandRegex),
          pathPrefix: asString(entry.pathPrefix),
          pathRegex: asString(entry.pathRegex),
          note: asString(entry.note)
        }]
      })
    }
    return {
      defaults: { unmatched },
      allow: rules("allow"),
      softDeny: rules("softDeny"),
      hardDeny: rules("hardDeny")
    }
  } catch {
    // A broken config file must never break the TUI: fall back to built-ins.
    return base
  }
}

function commandOf(input: unknown): string {
  if (!isRecord(input)) return ""
  return asString(input.command) ?? ""
}

function pathOf(input: unknown): string {
  if (!isRecord(input)) return ""
  return asString(input.file_path) ?? asString(input.path) ?? ""
}

function prefixMatches(value: string, prefix: string): boolean {
  if (!value.startsWith(prefix)) return false
  if (value.length === prefix.length) return true
  return /[\s/]/u.test(value[prefix.length])
}

function ruleMatches(rule: AutoPermissionRule, request: PermissionRequestShape): boolean {
  const tools = Array.isArray(rule.tool) ? rule.tool : [rule.tool]
  if (!tools.includes(request.toolName)) return false
  const command = commandOf(request.input)
  const path = pathOf(request.input)
  if (rule.commandPrefix !== undefined && !prefixMatches(command, rule.commandPrefix)) return false
  if (rule.commandRegex !== undefined && !new RegExp(rule.commandRegex, "u").test(command)) return false
  if (rule.pathPrefix !== undefined && !prefixMatches(path, rule.pathPrefix)) return false
  if (rule.pathRegex !== undefined && !new RegExp(rule.pathRegex, "u").test(path)) return false
  return true
}

function firstMatch(rules: AutoPermissionRule[], request: PermissionRequestShape): AutoPermissionRule | undefined {
  return rules.find((rule) => ruleMatches(rule, request))
}

function describeRule(rule: AutoPermissionRule): string {
  if (rule.note) return rule.note
  if (rule.commandPrefix) return rule.commandPrefix
  if (rule.pathPrefix) return rule.pathPrefix
  const pattern = rule.commandRegex ?? rule.pathRegex
  if (pattern) return `pattern match (${pattern})`
  return "rule"
}

export function classifyPermissionRequest(
  request: PermissionRequestShape,
  config: AutoPermissionConfig
): AutoPermissionVerdict | null {
  const hardDeny = firstMatch(config.hardDeny, request)
  if (hardDeny) return { behavior: "deny", reason: `auto-permissions: ${describeRule(hardDeny)}`, matchedRule: hardDeny }
  const allowed = firstMatch(config.allow, request)
  if (allowed) return { behavior: "allow", reason: `auto-permissions: ${describeRule(allowed)} (${request.toolName})`, matchedRule: allowed }
  const softDeny = firstMatch(config.softDeny, request)
  if (softDeny) return { behavior: "deny", reason: `auto-permissions: ${describeRule(softDeny)}`, matchedRule: softDeny }
  switch (config.defaults.unmatched) {
    case "allow":
      return { behavior: "allow", reason: "auto-permissions: defaults.unmatched=allow", matchedRule: { tool: request.toolName, note: "defaults.unmatched=allow" } }
    case "deny":
      return { behavior: "deny", reason: "auto-permissions: defaults.unmatched=deny", matchedRule: { tool: request.toolName, note: "defaults.unmatched=deny" } }
    default:
      return null
  }
}

// The exact response object shape the permission dialog returns to the
// runtime (see defaultPermissionChoices / requestToolPermission). A null
// verdict means "no auto decision": the caller renders the human dialog.
export type PermissionDialogResponse = { decision: "allow" | "deny"; reason: string }

// Auto classification is opt-in: it runs only in the client's auto overlay
// mode, and only for ordinary tool-permission prompts. AskUserQuestion and
// plan approval are human decisions by design and are never auto-answered.
export function shouldAutoClassify(mode: string | undefined, toolName: string): boolean {
  if (mode !== "auto") return false
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/gu, "")
  return normalized !== "askuserquestion" && normalized !== "exitplanmode" && normalized !== "exitplanmodev2"
}

export function autoPermissionResponse(
  request: PermissionRequestShape,
  config: AutoPermissionConfig
): PermissionDialogResponse | null {
  const verdict = classifyPermissionRequest(request, config)
  if (!verdict) return null
  return { decision: verdict.behavior, reason: verdict.reason }
}
