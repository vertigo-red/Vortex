import { createReadStream } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";

import { vi } from "vitest";

export const fs = {
  createReadStream,
  statAsync: stat,
  readFileAsync: readFile,
  writeFileAsync: vi.fn(writeFile),
  removeAsync: vi.fn((file: string) => rm(file, { force: true })),
};
export const log = vi.fn();
export const actions = {
  setModAttribute: vi.fn(),
  setModInstallationPath: vi.fn(),
};
export const selectors = {
  installPathForGame: (state: any, gameId: string) => state.settings.mods.installPath[gameId],
  discoveryByGame: (state: any, gameId: string) => state.settings.gameMode.discovered[gameId],
};
class ProcessCanceled extends Error {}
class SetupError extends Error {}
class ConcurrencyLimiter {
  async do<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}
export const util = {
  ProcessCanceled,
  SetupError,
  ConcurrencyLimiter,
  getProtonToolCommand: vi.fn(),
  getSafe: (object: any, keys: string[], fallback: any) =>
    keys.reduce((value, key) => value?.[key], object) ?? fallback,
};
