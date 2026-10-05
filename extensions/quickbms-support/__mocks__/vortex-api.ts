import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { vi } from "vitest";

export const fs = {
  statAsync: stat,
  moveAsync: async (source: string, destination: string, options?: { overwrite?: boolean }) => {
    if (options?.overwrite) await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
    await rm(source, { recursive: true });
  },
};
export const log = vi.fn();
export const selectors = {
  gameById: (state: any, gameId: string) =>
    state.session?.gameMode?.known?.find((game: any) => game.id === gameId),
  discoveryByGame: (state: any, gameId: string) => state.settings.gameMode.discovered[gameId],
};
class ArgumentInvalid extends Error {}
class ProcessCanceled extends Error {}
export const util = {
  ArgumentInvalid,
  ProcessCanceled,
  getSafe: (object: any, keys: string[], fallback: any) =>
    keys.reduce((value, key) => value?.[key], object) ?? fallback,
  getVortexPath: vi.fn(),
  getProtonToolCommand: vi.fn(),
  executeToolProcess: vi.fn(),
};
