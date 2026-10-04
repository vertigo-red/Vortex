import { vi } from "vitest";

export const fs = { statAsync: vi.fn() };
export const selectors = {
  discoveryByGame: (state: any, gameId: string) => state.settings.gameMode.discovered[gameId],
  activeGameId: (state: any) => state.settings.profiles.activeGameId,
};
class ProcessCanceled extends Error {}
export const util = {
  ProcessCanceled,
  getGame: vi.fn(),
  getGameUserPath: vi.fn(),
  getVortexPath: vi.fn((id: string) => `/host/${id}`),
  opn: vi.fn(),
  makeOverlayableDictionary: (
    base: Record<string, any>,
    layers: Record<string, any>,
    layer: (key: string) => string,
  ) => ({
    get: (key: string, field: string) => layers[layer(key)]?.[key]?.[field] ?? base[key]?.[field],
  }),
};
