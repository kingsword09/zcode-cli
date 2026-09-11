import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { PromptCallOptions, RuntimeAdapter } from "../../../packages/zcode-tui/src/types.ts";

export type ScenarioValue<T> = T | ((context: ScenarioTurnContext) => T | Promise<T>);
export type ScenarioInputMatcher = string | RegExp | ((input: unknown) => boolean);

export interface ScenarioTurnContext {
  readonly input: unknown;
  readonly options: PromptCallOptions;
  value<T>(key: string): T;
}

export interface ScenarioEmitStep {
  type: "emit";
  event: ScenarioValue<unknown>;
}

export interface ScenarioDelayStep {
  type: "delay";
  milliseconds: number;
}

export interface ScenarioPermissionStep {
  type: "permissions";
  mode?: "parallel" | "sequential";
  requests: ScenarioValue<readonly unknown[]>;
  saveAs: string;
}

export interface ScenarioWriteFilesStep {
  type: "writeFiles";
  files: ScenarioValue<Readonly<Record<string, string | Uint8Array>>>;
}

export interface ScenarioRespondStep {
  type: "respond";
  response: ScenarioValue<string>;
  metadata?: ScenarioValue<Record<string, unknown>>;
}

export type ScenarioRuntimeStep =
  | ScenarioDelayStep
  | ScenarioEmitStep
  | ScenarioPermissionStep
  | ScenarioRespondStep
  | ScenarioWriteFilesStep;

export interface ScenarioTurn {
  id: string;
  match: ScenarioInputMatcher;
  steps: readonly ScenarioRuntimeStep[];
}

export interface ScenarioRuntimeDefinition {
  turns: readonly ScenarioTurn[];
  workspaceDirectory?: string;
  journalPath?: string;
  unmatchedResponse?: ScenarioValue<string>;
}

export interface ScenarioRuntimeJournalEntry {
  sequence: number;
  kind: string;
  detail: unknown;
}

export class ScenarioRuntimeJournal {
  readonly #entries: ScenarioRuntimeJournalEntry[] = [];
  readonly #path?: string;

  constructor(path?: string) {
    this.#path = path;
  }

  record(kind: string, detail: unknown): void {
    const entry = {
      sequence: this.#entries.length + 1,
      kind,
      detail
    };
    this.#entries.push(entry);
    if (this.#path) appendFileSync(this.#path, `${JSON.stringify(entry)}\n`);
  }

  entries(): readonly ScenarioRuntimeJournalEntry[] {
    return this.#entries;
  }
}

export interface ScenarioRuntimeAdapter extends Pick<RuntimeAdapter, "submitPrompt"> {
  journal: ScenarioRuntimeJournal;
}

async function scenarioValue<T>(value: ScenarioValue<T>, context: ScenarioTurnContext): Promise<T> {
  if (typeof value !== "function") return value;
  return await (value as (context: ScenarioTurnContext) => T | Promise<T>)(context);
}

function inputMatches(matcher: ScenarioInputMatcher, input: unknown): boolean {
  if (typeof matcher === "string") return input === matcher;
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(String(input));
  }
  return matcher(input);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Scenario turn aborted", "AbortError");
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds === 0) return;
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Scenario turn aborted", "AbortError"));
    };
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolveDelay();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function workspacePath(workspaceDirectory: string, path: string): string {
  const root = resolve(workspaceDirectory);
  const destination = resolve(root, path);
  if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
    throw new Error(`Scenario write escapes the workspace: ${path}`);
  }
  return destination;
}

function validateDefinition(definition: ScenarioRuntimeDefinition): void {
  const ids = new Set<string>();
  for (const turn of definition.turns) {
    if (!turn.id || ids.has(turn.id)) throw new Error(`Scenario turn id must be unique: ${turn.id || "(empty)"}`);
    ids.add(turn.id);
    const responses = turn.steps.flatMap((step, index) => step.type === "respond" ? [index] : []);
    if (responses.length !== 1 || responses[0] !== turn.steps.length - 1) {
      throw new Error(`Scenario turn "${turn.id}" must end with exactly one respond step.`);
    }
    for (const step of turn.steps) {
      if (step.type === "delay" && (!Number.isFinite(step.milliseconds) || step.milliseconds < 0)) {
        throw new Error(`Scenario turn "${turn.id}" has an invalid delay.`);
      }
      if (step.type === "permissions" && !step.saveAs) {
        throw new Error(`Scenario turn "${turn.id}" must name its permission result.`);
      }
    }
  }
}

export function createScenarioRuntime(definition: ScenarioRuntimeDefinition): ScenarioRuntimeAdapter {
  validateDefinition(definition);
  const journal = new ScenarioRuntimeJournal(definition.journalPath);

  const submitPrompt = async (input: unknown, options: PromptCallOptions): Promise<unknown> => {
    throwIfAborted(options.abortSignal);
    const turn = definition.turns.find((candidate) => inputMatches(candidate.match, input));
    if (!turn) {
      if (definition.unmatchedResponse !== undefined) {
        const values = new Map<string, unknown>();
        const context = turnContext(input, options, values);
        const response = await scenarioValue(definition.unmatchedResponse, context);
        journal.record("turn.unmatched", { input, response });
        return { response };
      }
      journal.record("turn.unmatched", { input });
      throw new Error(`No scenario turn matches input: ${String(input)}`);
    }

    const values = new Map<string, unknown>();
    const context = turnContext(input, options, values);
    journal.record("turn.start", { input, turnId: turn.id });
    try {
      for (const [index, step] of turn.steps.entries()) {
        throwIfAborted(options.abortSignal);
        journal.record("step.start", { index, turnId: turn.id, type: step.type });
        if (step.type === "delay") {
          await delay(step.milliseconds, options.abortSignal);
        } else if (step.type === "emit") {
          const event = await scenarioValue(step.event, context);
          await options.onEvent?.(event);
          journal.record("event.emit", { event, turnId: turn.id });
        } else if (step.type === "permissions") {
          if (!options.requestPermission) throw new Error("Scenario permission callback is unavailable.");
          const requests = await scenarioValue(step.requests, context);
          const invoke = (request: unknown) => options.requestPermission!(
            request,
            { abortSignal: options.abortSignal }
          );
          const results: unknown[] = [];
          if ((step.mode ?? "sequential") === "parallel") {
            results.push(...await Promise.all(requests.map(invoke)));
          } else {
            for (const request of requests) results.push(await invoke(request));
          }
          values.set(step.saveAs, results);
          journal.record("permissions.finish", {
            count: requests.length,
            mode: step.mode ?? "sequential",
            results,
            saveAs: step.saveAs,
            turnId: turn.id
          });
        } else if (step.type === "writeFiles") {
          if (!definition.workspaceDirectory) {
            throw new Error(`Scenario turn "${turn.id}" writes files without a workspaceDirectory.`);
          }
          const files = await scenarioValue(step.files, context);
          await Promise.all(Object.entries(files).map(async ([path, contents]) => {
            const destination = workspacePath(definition.workspaceDirectory!, path);
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, contents);
          }));
          journal.record("files.write", { paths: Object.keys(files), turnId: turn.id });
        } else {
          const response = await scenarioValue(step.response, context);
          const metadata = step.metadata ? await scenarioValue(step.metadata, context) : {};
          const result = { ...metadata, response };
          journal.record("turn.finish", { result, turnId: turn.id });
          return result;
        }
        journal.record("step.finish", { index, turnId: turn.id, type: step.type });
      }
      throw new Error(`Scenario turn "${turn.id}" ended without a response.`);
    } catch (error) {
      journal.record("turn.error", {
        error: error instanceof Error ? error.message : String(error),
        turnId: turn.id
      });
      throw error;
    }
  };

  return { journal, submitPrompt };
}

function turnContext(
  input: unknown,
  options: PromptCallOptions,
  values: Map<string, unknown>
): ScenarioTurnContext {
  return {
    input,
    options,
    value<T>(key: string): T {
      if (!values.has(key)) throw new Error(`Scenario value is unavailable: ${key}`);
      return values.get(key) as T;
    }
  };
}
