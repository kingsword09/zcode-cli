import { sanitizeTerminalText, truncateGraphemes } from "./terminal-text.ts";
import { isRecord, type ListSkills, type UnknownRecord } from "./types.ts";

const skillCacheMilliseconds = 2_000;
const skillDescriptionLimit = 140;
const skillIdentifierLimit = 256;
const skillIdentifierPattern = /^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)*$/u;
const skillMentionPattern = /(^|\s)\$([A-Za-z0-9._:-]+)/gu;

export interface SkillEntry {
  description?: string;
  identifier: string;
  name: string;
}

export interface PreparedSkillPrompt {
  identifiers: string[];
  text: string;
}

export class SkillCatalog {
  private cached?: SkillEntry[];
  private expiresAt = 0;
  private inFlight?: Promise<SkillEntry[]>;

  constructor(private readonly listSkills?: ListSkills) {}

  async list(): Promise<SkillEntry[]> {
    if (!this.listSkills) return [];
    if (this.cached && Date.now() < this.expiresAt) return this.cached;
    if (this.inFlight) return await this.inFlight;

    const stale = this.cached;
    const request = Promise.resolve()
      .then(() => this.listSkills!())
      .then((result) => {
        const skills = normalizeSkillEntries(result);
        this.cached = skills;
        this.expiresAt = Date.now() + skillCacheMilliseconds;
        return skills;
      })
      .catch(() => {
        const fallback = stale ?? [];
        this.cached = fallback;
        this.expiresAt = Date.now() + skillCacheMilliseconds;
        return fallback;
      });
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = undefined;
    }
  }

  async preparePrompt(input: string): Promise<PreparedSkillPrompt | undefined> {
    if (!input.includes("$")) return undefined;
    const identifiers = resolveSkillMentions(input, await this.list());
    return identifiers.length > 0
      ? { identifiers, text: buildSkillInvocationPrompt(identifiers, input) }
      : undefined;
  }
}

export function normalizeSkillEntries(result: unknown): SkillEntry[] {
  if (!isRecord(result) || !Array.isArray(result.skills)) return [];

  const skills: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of result.skills) {
    if (!isRecord(candidate)) continue;
    const name = validSkillIdentifier(candidate.name);
    if (!name) continue;

    const qualifiedName = candidate.qualifiedName === undefined
      ? undefined
      : validSkillIdentifier(candidate.qualifiedName);
    if (candidate.qualifiedName !== undefined && !qualifiedName) continue;

    const identifier = qualifiedName ?? name;
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    const description = skillDescription(candidate);
    skills.push({
      identifier,
      name,
      ...(description ? { description } : {})
    });
  }
  return skills;
}

export function resolveSkillMentions(input: string, skills: SkillEntry[]): string[] {
  if (!input.includes("$") || skills.length === 0) return [];

  const byIdentifier = new Map(skills.map((skill) => [skill.identifier, skill]));
  const byName = new Map<string, SkillEntry[]>();
  for (const skill of skills) {
    const matches = byName.get(skill.name) ?? [];
    matches.push(skill);
    byName.set(skill.name, matches);
  }

  const identifiers: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(skillMentionPattern)) {
    const token = match[2];
    if (!token) continue;
    const exact = byIdentifier.get(token);
    const aliases = byName.get(token);
    const skill = exact ?? (aliases?.length === 1 ? aliases[0] : undefined);
    if (skill && !seen.has(skill.identifier)) {
      seen.add(skill.identifier);
      identifiers.push(skill.identifier);
    }
  }
  return identifiers;
}

export function buildSkillInvocationPrompt(
  identifiers: readonly string[],
  userRequest: string
): string {
  if (identifiers.length === 0 || identifiers.some((identifier) => !validSkillIdentifier(identifier))) {
    return userRequest;
  }

  const request = userRequest.trim();
  const requestText = request.length > 0
    ? `User request:\n${request}`
    : "No additional user request was provided. Load the skill and respond according to its instructions.";
  if (identifiers.length === 1) {
    const identifier = identifiers[0]!;
    return [
      `Use the skill named \`${identifier}\` for this turn.`,
      `First call the \`Skill\` tool with name \`${identifier}\` before doing the task.`,
      "After the skill content is loaded, follow its instructions and continue.",
      "",
      requestText
    ].join("\n");
  }

  const names = identifiers.map((identifier) => `\`${identifier}\``).join(", ");
  return [
    `Use the skills named ${names} for this turn.`,
    `First call the \`Skill\` tool once for each of these names before doing the task: ${names}.`,
    "After all skill content is loaded, follow the instructions and continue.",
    "",
    requestText
  ].join("\n");
}

function validSkillIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > skillIdentifierLimit) {
    return undefined;
  }
  return skillIdentifierPattern.test(value) ? value : undefined;
}

function skillDescription(candidate: UnknownRecord): string | undefined {
  const description = [candidate.description, candidate.whenToUse]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => sanitizeTerminalText(value, { preserveSgr: false }))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return description ? truncateGraphemes(description, skillDescriptionLimit) : undefined;
}
