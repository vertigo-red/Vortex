import * as path from "node:path";

import { fs, util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { GAME_ID } from "./common";

type GameDiscovery = Pick<types.IDiscoveryResult, "path" | "store">;

export function documentsPath(api: types.IExtensionApi, discovery?: GameDiscovery): string {
  const game = discovery ?? api.getState().settings.gameMode.discovered?.[GAME_ID];
  if (process.platform === "linux" && !game?.path) {
    throw new util.ProcessCanceled("Discover Baldur's Gate 3 before managing its user files.");
  }
  // BG3 has no native Linux build. An unmatched install must not fall back to host AppData.
  const userPath = util.getGameUserPath(
    "localAppData",
    process.platform === "linux" ? { ...game, store: "steam" } : game,
  );
  return path.join(userPath, "Larian Studios", "Baldur's Gate 3");
}

export function modsPath(api: types.IExtensionApi, discovery?: GameDiscovery): string {
  return path.join(documentsPath(api, discovery), "Mods");
}

export function profilesPath(api: types.IExtensionApi, discovery?: GameDiscovery): string {
  return path.join(documentsPath(api, discovery), "PlayerProfiles");
}

export function scriptExtenderPath(api: types.IExtensionApi): string {
  return path.join(documentsPath(api), "Script Extender");
}

export async function getPlayerProfiles(api: types.IExtensionApi): Promise<string[]> {
  const directory = profilesPath(api);
  let names: string[];
  try {
    names = await fs.readdirAsync(directory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const profiles = await Promise.all(
    names
      .filter((name) => name !== "Default")
      .map(async (name) => {
        try {
          return (await fs.statAsync(path.join(directory, name))).isDirectory() ? name : undefined;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw err;
        }
      }),
  );
  return profiles.filter((name): name is string => name !== undefined);
}
