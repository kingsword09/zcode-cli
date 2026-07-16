export const MAX_RETAINED_TOOL_PAYLOAD_CHARACTERS = 64_000;
export const MAX_RETAINED_TOOL_PAYLOAD_NODES = 1_024;
export const MAX_RETAINED_TOOL_PAYLOAD_DEPTH = 8;
export const MAX_RETAINED_TOOL_PAYLOAD_ENTRIES = 64;
export const MAX_RETAINED_TOOL_IMAGE_CHARACTERS = 16_384;

export interface ToolPayloadLimits {
  characters: number;
  depth: number;
  entries: number;
  nodes: number;
}

export interface ToolPayloadSize {
  characters: number;
  nodes: number;
}

export interface CompactedToolPayloads {
  size: ToolPayloadSize;
  truncated: boolean;
  values: unknown[];
}

export const TOOL_PAYLOAD_LIMITS: ToolPayloadLimits = {
  characters: MAX_RETAINED_TOOL_PAYLOAD_CHARACTERS,
  depth: MAX_RETAINED_TOOL_PAYLOAD_DEPTH,
  entries: MAX_RETAINED_TOOL_PAYLOAD_ENTRIES,
  nodes: MAX_RETAINED_TOOL_PAYLOAD_NODES
};

const truncatedMarker = "\n… retained tool payload truncated …\n";
export const OMITTED_BINARY_PAYLOAD_PREFIX = "[binary payload omitted:";

export function isOmittedBinaryPayload(value: string): boolean {
  return value.startsWith(OMITTED_BINARY_PAYLOAD_PREFIX);
}

function limit(value: number): number {
  return Math.max(0, Math.floor(value));
}

function safePrefix(value: string, maximum: number): string {
  let end = Math.min(value.length, limit(maximum));
  if (end > 0
    && end < value.length
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[end]!)) {
    end -= 1;
  }
  return value.slice(0, end);
}

function safeSuffix(value: string, maximum: number): string {
  let start = Math.max(0, value.length - limit(maximum));
  if (start > 0
    && start < value.length
    && /[\uD800-\uDBFF]/u.test(value[start - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[start]!)) {
    start += 1;
  }
  return value.slice(start);
}

class ToolPayloadCompactor {
  private characters = 0;
  private nodes = 0;
  private readonly active = new Set<object>();
  private readonly seen = new Map<object, unknown>();
  truncated = false;

  constructor(private readonly limits: ToolPayloadLimits) {}

  compact(value: unknown, depth = 0, key?: string, binary = false): unknown {
    if (this.nodes >= this.limits.nodes) {
      this.truncated = true;
      return undefined;
    }
    this.nodes += 1;

    if (typeof value === "string") return this.compactString(value, key, binary);
    if (value === null || value === undefined
      || typeof value === "boolean" || typeof value === "number") {
      return value;
    }
    if (typeof value === "bigint") return this.compactString(String(value), key, false);
    if (typeof value !== "object") return this.compactString(String(value), key, false);
    if (depth >= this.limits.depth) {
      this.truncated = true;
      return this.compactString("[maximum retained depth reached]", key, false);
    }
    if (this.active.has(value)) {
      this.truncated = true;
      return this.compactString("[circular reference omitted]", key, false);
    }
    if (this.seen.has(value)) return this.seen.get(value);

    if (value instanceof Error) {
      const retained = Object.create(Error.prototype) as Error;
      this.seen.set(value, retained);
      this.active.add(value);
      const name = this.compact(value.name, depth + 1, "name");
      const message = this.compact(value.message, depth + 1, "message");
      retained.name = typeof name === "string" ? name : "Error";
      retained.message = typeof message === "string" ? message : "";
      this.active.delete(value);
      return retained;
    }
    if (Array.isArray(value)) {
      const retained: unknown[] = [];
      this.seen.set(value, retained);
      this.active.add(value);
      const maximum = Math.min(value.length, this.limits.entries);
      for (let index = 0; index < maximum; index += 1) {
        if (this.exhausted()) break;
        retained.push(this.compact(value[index], depth + 1, String(index)));
      }
      if (retained.length < value.length) this.truncated = true;
      this.active.delete(value);
      return retained;
    }

    const source = value as Record<string, unknown>;
    const retained: Record<string, unknown> = {};
    this.seen.set(value, retained);
    this.active.add(value);
    const entries = Object.entries(source);
    const maximum = Math.min(entries.length, this.limits.entries);
    const imageRecord = [source.mimeType, source.mediaType, source.media_type]
      .some((candidate) => typeof candidate === "string" && candidate.startsWith("image/"));
    for (let index = 0; index < maximum; index += 1) {
      if (this.exhausted()) break;
      const [entryKey, entryValue] = entries[index]!;
      if (!this.reserveKey(entryKey)) break;
      retained[entryKey] = this.compact(
        entryValue,
        depth + 1,
        entryKey,
        imageRecord && (entryKey === "data" || entryKey === "base64")
      );
    }
    if (Object.keys(retained).length < entries.length) this.truncated = true;
    this.active.delete(value);
    return retained;
  }

  size(): ToolPayloadSize {
    return { characters: this.characters, nodes: this.nodes };
  }

  private compactString(value: string, key?: string, binary = false): string {
    const binaryValue = binary
      || /^data:[^;]+;base64,/iu.test(value)
      || (key === "base64" && value.length > 256);
    const available = Math.max(0, this.limits.characters - this.characters);
    const omitBinary = binaryValue
      && (value.length > MAX_RETAINED_TOOL_IMAGE_CHARACTERS || value.length > available);
    const source = omitBinary
      ? `${OMITTED_BINARY_PAYLOAD_PREFIX} ${value.length} characters]`
      : value;
    if (omitBinary) this.truncated = true;

    if (source.length <= available) {
      this.characters += source.length;
      return source;
    }
    this.truncated = true;
    if (available <= truncatedMarker.length) {
      const retained = safePrefix(truncatedMarker, available);
      this.characters += retained.length;
      return retained;
    }
    const content = available - truncatedMarker.length;
    const head = Math.ceil(content / 2);
    const tail = Math.floor(content / 2);
    const retained = `${safePrefix(source, head)}${truncatedMarker}${safeSuffix(source, tail)}`;
    this.characters += retained.length;
    return retained;
  }

  private reserveKey(key: string): boolean {
    if (this.characters + key.length > this.limits.characters) {
      this.truncated = true;
      return false;
    }
    this.characters += key.length;
    return true;
  }

  private exhausted(): boolean {
    return this.nodes >= this.limits.nodes || this.characters >= this.limits.characters;
  }
}

export function compactToolPayloads(
  values: readonly unknown[],
  requestedLimits: ToolPayloadLimits = TOOL_PAYLOAD_LIMITS
): CompactedToolPayloads {
  const limits = {
    characters: limit(requestedLimits.characters),
    depth: limit(requestedLimits.depth),
    entries: limit(requestedLimits.entries),
    nodes: limit(requestedLimits.nodes)
  };
  const compactor = new ToolPayloadCompactor(limits);
  const retained = values.map((value) => compactor.compact(value));
  return {
    size: compactor.size(),
    truncated: compactor.truncated,
    values: retained
  };
}

export function toolPayloadSize(value: unknown): ToolPayloadSize {
  let characters = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    nodes += 1;
    if (typeof candidate === "string") {
      characters += candidate.length;
      return;
    }
    if (typeof candidate !== "object" || candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(candidate)) {
      characters += key.length;
      visit(item);
    }
  };
  visit(value);
  return { characters, nodes };
}
