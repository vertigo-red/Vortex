import * as path from "path";

import { selectors, types, util } from "@nexusmods/vortex-api";

interface IGameSupport {
  folder: string;
}

let discoveryForGame: (gameId: string) => types.IDiscoveryResult = () => undefined;

const gameSupport = util.makeOverlayableDictionary<string, IGameSupport>(
  {
    fallout3: { folder: "Fallout3" },
    falloutnv: { folder: "FalloutNV" },
    fallout4: { folder: "Fallout4" },
    fallout4vr: { folder: "Fallout4VR" },
    starfield: { folder: "Starfield" },
    oblivion: { folder: "Oblivion" },
    skyrim: { folder: "Skyrim" },
    skyrimse: { folder: "Skyrim Special Edition" },
    skyrimvr: { folder: "SkyrimVR" },
  },
  {
    xbox: {
      skyrimse: { folder: "Skyrim Special Edition MS" },
      fallout4: { folder: "Fallout4 MS" },
    },
    gog: {
      skyrimse: { folder: "Skyrim Special Edition GOG" },
      enderalspecialedition: { folder: "Enderal Special Edition GOG" },
    },
    epic: {
      skyrimse: { folder: "Skyrim Special Edition EPIC" },
      fallout4: { folder: "Fallout4 EPIC" },
    },
  },
  (gameId) => discoveryForGame(gameId)?.store,
);

const localAppData: () => string = (() => {
  let cached: string;
  return () => {
    if (cached === undefined) {
      cached =
        process.env.LOCALAPPDATA || path.resolve(util.getVortexPath("appData"), "..", "Local");
    }
    return cached;
  };
})();

function userFolder(id: "documents" | "localAppData", gameId: string): string {
  if (process.platform !== "linux") {
    return id === "documents" ? util.getVortexPath("documents") : localAppData();
  }
  const discovery = discoveryForGame(gameId);
  if (!discovery?.path) {
    throw new util.ProcessCanceled(
      "Discover the game's Steam installation before opening its user folders.",
    );
  }
  // These Bethesda integrations use Windows user folders. Require a matching
  // Steam/Proton prefix rather than falling back to Linux host directories.
  return util.getGameUserPath(id, { ...discovery, store: "steam" });
}

export function initGameSupport(api: types.IExtensionApi) {
  discoveryForGame = (gameId) => selectors.discoveryByGame(api.store.getState(), gameId);
}

export function hasSettingsPath(game: types.IGame): boolean {
  return (
    game !== undefined &&
    (gameSupport.get(game.id, "folder") !== undefined || game.details?.settingsPath !== undefined)
  );
}

export function hasAppDataPath(game: types.IGame): boolean {
  return (
    game !== undefined &&
    (gameSupport.get(game.id, "folder") !== undefined || game.details?.appDataPath !== undefined)
  );
}

export function settingsPath(game: types.IGame): string {
  if (!game) return undefined;
  const folder = gameSupport.get(game.id, "folder");
  return folder !== undefined
    ? path.join(userFolder("documents", game.id), "My Games", folder)
    : game.details?.settingsPath?.();
}

export function appDataPath(game: types.IGame): string {
  if (!game) return undefined;
  const folder = gameSupport.get(game.id, "folder");
  return folder !== undefined
    ? path.join(userFolder("localAppData", game.id), folder)
    : game.details?.appDataPath?.();
}
