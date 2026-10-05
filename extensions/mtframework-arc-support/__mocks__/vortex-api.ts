import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { vi } from "vitest";

export const fs = {
  moveAsync: async (source: string, destination: string, options?: { overwrite?: boolean }) => {
    if (options?.overwrite) await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
    await rm(source, { recursive: true });
  },
};
export const log = vi.fn();
export const selectors = {
  discoveryByGame: (state: any, gameId: string) => state.settings.gameMode.discovered[gameId],
};
class ArgumentInvalid extends Error {}
export const util = {
  ArgumentInvalid,
  getVortexPath: vi.fn(),
  getProtonToolCommand: vi.fn(),
  executeToolProcess: vi.fn(),
};
