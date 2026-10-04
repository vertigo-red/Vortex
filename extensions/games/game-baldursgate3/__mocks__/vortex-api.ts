import * as nativeFs from "node:fs/promises";

import { vi } from "vitest";

export const fs = {
  readdirAsync: vi.fn(nativeFs.readdir),
  statAsync: vi.fn(nativeFs.stat),
  readFileAsync: vi.fn(nativeFs.readFile),
  writeFileAsync: vi.fn(nativeFs.writeFile),
  ensureDirWritableAsync: vi.fn(async (directory: string) =>
    nativeFs.mkdir(directory, { recursive: true }),
  ),
};
export const util = {
  ProcessCanceled: class ProcessCanceled extends Error {},
  MissingInterpreter: class MissingInterpreter extends Error {},
  getGameUserPath: vi.fn(),
  getProtonToolCommand: vi.fn(),
  getManifest: vi.fn(async () => ({ files: [] })),
  withErrorContext: (_key: string, _value: unknown, callback: () => unknown) => callback(),
  getSafe: (input: unknown, segments: string[], fallback: unknown) =>
    segments.reduce((value, key) => (value as Record<string, unknown>)?.[key], input) ?? fallback,
  getGame: vi.fn(() => ({ getInstalledVersion: async () => "4.1.1.1" })),
  Debouncer: class Debouncer {
    schedule = vi.fn();
  },
  ConcurrencyLimiter: class ConcurrencyLimiter {
    do<T>(callback: () => Promise<T>): Promise<T> {
      return Promise.resolve().then(callback);
    }
  },
};
export const selectors = {
  discoveryByGame: (state, id: string) => state.settings.gameMode.discovered[id],
  installPathForGame: vi.fn(),
  activeProfile: vi.fn(),
};
export const actions = {};
export const log = vi.fn();
