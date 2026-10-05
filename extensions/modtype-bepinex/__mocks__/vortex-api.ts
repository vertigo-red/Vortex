import * as fsPromises from "node:fs/promises";

import semver from "semver";
import { vi } from "vitest";

export const util = {
  DataInvalid: class DataInvalid extends Error {},
  ProcessCanceled: class ProcessCanceled extends Error {},
  getGame: vi.fn(),
  semverCoerce: vi.fn((version: string) => semver.coerce(version)),
  getSafe: (object: unknown, keys: string[], fallback: unknown) =>
    keys.reduce((value: any, key) => value?.[key], object) ?? fallback,
};
export const fs = {
  statAsync: fsPromises.stat,
  readFileAsync: fsPromises.readFile,
  copyAsync: fsPromises.copyFile,
};
export const log = vi.fn();
export const selectors = { activeGameId: vi.fn(() => "other"), downloadPathForGame: vi.fn() };
export const actions = { setCompatibleGames: vi.fn() };
