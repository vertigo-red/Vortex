import { stat } from "node:fs/promises";
import * as path from "node:path";

import { vi } from "vitest";

export const fs = { statAsync: stat };
export const selectors = {
  discoveryByGame: (state: any, gameId: string) => state.settings.gameMode.discovered[gameId],
};
export const util = {
  DataInvalid: class DataInvalid extends Error {},
  resolveWindowsGamePath: (directory: string, relative: string) => path.join(directory, relative),
};
export const log = vi.fn();
