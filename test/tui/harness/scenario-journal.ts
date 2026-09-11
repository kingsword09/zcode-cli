export interface ScenarioJournalEntry {
  at: number;
  channel: string;
  detail: unknown;
}

export class ScenarioJournal {
  readonly #startedAt = performance.now();
  readonly #entries: ScenarioJournalEntry[] = [];

  record(channel: string, detail: unknown): void {
    this.#entries.push({
      at: Math.round(performance.now() - this.#startedAt),
      channel,
      detail
    });
  }

  entries(): readonly ScenarioJournalEntry[] {
    return this.#entries;
  }

  format(): string {
    return this.#entries
      .map((entry) => `${String(entry.at).padStart(5, " ")}ms ${entry.channel} ${JSON.stringify(entry.detail)}`)
      .join("\n");
  }
}
