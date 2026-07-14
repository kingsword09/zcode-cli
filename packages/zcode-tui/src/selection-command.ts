import { asString, isRecord } from "./types.ts";

export interface SelectionInteraction {
  cancelStatus?: string;
  clearStatus?: string;
  emptyStatus?: string;
  help?: string;
  mask?: boolean;
  placeholder?: string;
  primary?: string;
  secondary?: string;
  status?: string;
  submitStatus?: string;
}

export interface SelectionCommand {
  command: string;
  description?: string;
  input?: SelectionInteraction;
  label: string;
  pending?: SelectionInteraction;
}

export interface ProtectedSubmission {
  cancelStatus?: string;
  displayInput: string;
  input: string;
  pending?: SelectionInteraction;
  recordHistory: boolean;
  secrets: string[];
  status?: string;
}

const apiKeyLoginPattern = /^(\/login\s+(?:zai|bigmodel)-coding-plan-api-key)(?:\s+([\s\S]*))?$/iu;

function interaction(value: unknown): SelectionInteraction | undefined {
  if (!isRecord(value)) return undefined;
  return {
    cancelStatus: asString(value.cancelStatus),
    clearStatus: asString(value.clearStatus),
    emptyStatus: asString(value.emptyStatus),
    help: asString(value.help),
    mask: value.mask === true,
    placeholder: asString(value.placeholder),
    primary: asString(value.primary),
    secondary: asString(value.secondary),
    status: asString(value.status),
    submitStatus: asString(value.submitStatus)
  };
}

export function parseSelectionCommand(value: unknown, index: number): SelectionCommand | null {
  if (!isRecord(value)) return null;
  const command = asString(value.command);
  if (!command) return null;
  const description = [asString(value.secondary), asString(value.meta)].filter(Boolean).join(" · ");
  return {
    command,
    description: description || undefined,
    input: interaction(value.input),
    label: asString(value.primary) ?? asString(value.label) ?? asString(value.id) ?? String(index),
    pending: interaction(value.pending)
  };
}

export function protectSubmission(input: string): ProtectedSubmission {
  const match = apiKeyLoginPattern.exec(input.trim());
  const secret = match?.[2]?.trim();
  if (!match || !secret) {
    return {
      displayInput: input,
      input,
      recordHistory: true,
      secrets: []
    };
  }
  return {
    displayInput: `${match[1]} [redacted]`,
    input,
    recordHistory: false,
    secrets: [secret]
  };
}

export function selectionSubmission(
  selection: SelectionCommand,
  value?: string
): ProtectedSubmission | null {
  if (!selection.input) {
    return {
      cancelStatus: selection.pending?.cancelStatus,
      displayInput: selection.command,
      input: selection.command,
      pending: selection.pending,
      recordHistory: true,
      secrets: [],
      status: selection.pending?.status
    };
  }
  const submitted = value?.trim();
  if (!submitted) return null;
  const masked = selection.input.mask === true;
  return {
    cancelStatus: selection.input.cancelStatus,
    displayInput: masked ? `${selection.command} [redacted]` : `${selection.command} ${submitted}`,
    input: `${selection.command} ${submitted}`,
    recordHistory: !masked,
    secrets: masked ? [submitted] : [],
    status: selection.input.submitStatus
  };
}

export function redactSecrets(message: string, secrets: string[]): string {
  return secrets.reduce(
    (redacted, secret) => secret ? redacted.replaceAll(secret, "[redacted]") : redacted,
    message
  );
}
