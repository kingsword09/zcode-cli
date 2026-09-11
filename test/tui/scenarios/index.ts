import { permissionRequestQueueScenario } from "./permission-request-queue.ts";
import type { TuiScenario } from "./types.ts";
import { writeAndDiffScenario } from "./write-and-diff.ts";

const scenarios = new Map<string, TuiScenario>([
  [permissionRequestQueueScenario.name, permissionRequestQueueScenario],
  [writeAndDiffScenario.name, writeAndDiffScenario]
]);

export function listTuiScenarios(): TuiScenario[] {
  return [...scenarios.values()];
}

export function findTuiScenario(name: string): TuiScenario {
  const scenario = scenarios.get(name);
  if (!scenario) {
    throw new Error(`Unknown TUI scenario "${name}". Available: ${[...scenarios.keys()].join(", ")}`);
  }
  return scenario;
}
