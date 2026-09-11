import {
  mount,
  probeTransports,
  type AutoMount,
  type AutoProbe
} from "mountx/auto";
import { createMemoryDriver } from "mountx/drivers/memory";
import type { FsDriver } from "mountx";

import type { ScenarioWorkspaceBackend } from "./scenario-workspace.ts";

export class ScenarioMountxUnavailableError extends Error {
  constructor(reason: string) {
    super(`Mountx workspace backend is unavailable: ${reason}`);
    this.name = "ScenarioMountxUnavailableError";
  }
}

export async function probeScenarioMountx(): Promise<AutoProbe> {
  return await probeTransports();
}

export interface MountxWorkspaceBackendOptions {
  driver?: FsDriver;
  name?: string;
}

export class MountxWorkspaceBackend implements ScenarioWorkspaceBackend {
  readonly name: string;
  readonly #driver: FsDriver;
  #mounted?: AutoMount;

  constructor(options: MountxWorkspaceBackendOptions = {}) {
    this.name = options.name ?? (options.driver ? "mountx-custom" : "mountx-memory");
    this.#driver = options.driver ?? createMemoryDriver();
  }

  async mount(directory: string): Promise<void> {
    if (this.#mounted) throw new Error("Mountx workspace backend is already mounted.");
    const probe = await probeScenarioMountx();
    if (!probe.chosen) {
      throw new ScenarioMountxUnavailableError(probe.reason ?? "no usable transport");
    }
    this.#mounted = await mount(this.#driver, directory, {
      signals: false,
      transport: probe.chosen
    });
  }

  async dispose(): Promise<void> {
    if (!this.#mounted) return;
    await this.#mounted.unmount();
    this.#mounted = undefined;
  }
}
