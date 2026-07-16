export const MAX_ACTIVE_TOOL_TEXT_CHARACTERS = 64_000;

const markerReserveCharacters = 128;
const compactConsumedChunksAt = 1_024;

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

/**
 * Append-only text storage for an active tool stream. Small values use the
 * native string fast path. Once the source exceeds the limit, only a stable
 * head and a chunked rolling tail are retained; materialization is deferred
 * until the view renders.
 */
export class BoundedToolText {
  readonly maximumCharacters: number;

  private full = "";
  private head = "";
  private tailChunks: string[] = [];
  private tailStart = 0;
  private tailCharacters = 0;
  private total = 0;
  private truncated = false;
  private cachedValue?: string;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly markerLimit: number;

  constructor(
    initialValue = "",
    maximumCharacters = MAX_ACTIVE_TOOL_TEXT_CHARACTERS
  ) {
    this.maximumCharacters = Math.max(1, limit(maximumCharacters));
    this.markerLimit = Math.min(
      markerReserveCharacters,
      Math.floor(this.maximumCharacters / 2)
    );
    const content = this.maximumCharacters - this.markerLimit;
    this.headLimit = Math.ceil(content / 2);
    this.tailLimit = Math.floor(content / 2);
    this.append(initialValue);
  }

  append(delta: string): void {
    if (!delta) return;
    this.cachedValue = undefined;
    const nextTotal = this.total + delta.length;
    if (!this.truncated && nextTotal <= this.maximumCharacters) {
      this.full += delta;
      this.total = nextTotal;
      return;
    }

    if (!this.truncated) this.beginTruncation(delta);
    else this.appendTail(delta);
    this.total = nextTotal;
  }

  replace(value: string): void {
    this.clear();
    this.append(value);
  }

  clear(): void {
    this.full = "";
    this.head = "";
    this.tailChunks = [];
    this.tailStart = 0;
    this.tailCharacters = 0;
    this.total = 0;
    this.truncated = false;
    this.cachedValue = undefined;
  }

  value(): string {
    if (!this.truncated) return this.full;
    if (this.cachedValue !== undefined) return this.cachedValue;
    const marker = safePrefix(
      `\n… ${this.omittedCharacters} characters omitted from active tool stream …\n`,
      this.markerLimit
    );
    this.cachedValue = `${this.head}${marker}${this.materializeTail()}`;
    return this.cachedValue;
  }

  get output(): string {
    return this.value();
  }

  get totalCharacters(): number {
    return this.total;
  }

  get retainedCharacters(): number {
    return this.full.length + this.head.length + this.tailCharacters;
  }

  get omittedCharacters(): number {
    if (!this.truncated) return 0;
    return Math.max(0, this.total - this.head.length - this.tailCharacters);
  }

  isTruncated(): boolean {
    return this.truncated;
  }

  toJSON(): string {
    return this.value();
  }

  toString(): string {
    return this.value();
  }

  private beginTruncation(delta: string): void {
    this.head = this.full.length >= this.headLimit
      ? safePrefix(this.full, this.headLimit)
      : `${this.full}${safePrefix(delta, this.headLimit - this.full.length)}`;
    const tail = delta.length >= this.tailLimit
      ? safeSuffix(delta, this.tailLimit)
      : safeSuffix(`${this.full}${delta}`, this.tailLimit);
    this.full = "";
    this.truncated = true;
    if (tail) {
      this.tailChunks = [tail];
      this.tailCharacters = tail.length;
    }
  }

  private appendTail(delta: string): void {
    if (this.tailLimit === 0) return;
    if (delta.length >= this.tailLimit) {
      const tail = safeSuffix(delta, this.tailLimit);
      this.tailChunks = tail ? [tail] : [];
      this.tailStart = 0;
      this.tailCharacters = tail.length;
      return;
    }

    this.tailChunks.push(delta);
    this.tailCharacters += delta.length;
    let excess = this.tailCharacters - this.tailLimit;
    while (excess > 0 && this.tailStart < this.tailChunks.length) {
      const first = this.tailChunks[this.tailStart]!;
      if (first.length <= excess) {
        this.tailChunks[this.tailStart] = "";
        this.tailStart += 1;
        this.tailCharacters -= first.length;
        excess -= first.length;
        continue;
      }
      const retained = safeSuffix(first, first.length - excess);
      this.tailChunks[this.tailStart] = retained;
      this.tailCharacters -= first.length - retained.length;
      excess = 0;
    }
    if (this.tailStart >= compactConsumedChunksAt
      && this.tailStart * 2 >= this.tailChunks.length) {
      this.tailChunks = this.tailChunks.slice(this.tailStart);
      this.tailStart = 0;
    }
  }

  private materializeTail(): string {
    if (this.tailStart === 0) return this.tailChunks.join("");
    return this.tailChunks.slice(this.tailStart).join("");
  }
}

export function toolTextValue(value: string | BoundedToolText | undefined): string | undefined {
  return value instanceof BoundedToolText ? value.value() : value;
}
