import * as path from "path";

import { selectors, types, util } from "@nexusmods/vortex-api";
import * as Redux from "redux";

interface IGameSupport {
  settingsPath?: (game: types.IGame) => string;
  appDataPath?: (game: types.IGame) => string;
}

const localAppData = (game: types.IGame): string => util.getVortexPath("localAppData", game);

const gameSupport = util.makeOverlayableDictionary<string, IGameSupport>(
  {
    fallout3: {
      settingsPath: (game) =>
        path.join(util.getVortexPath("documents", game), "My Games", "Fallout3"),
      appDataPath: (game) => path.join(localAppData(game), "Fallout3"),
    },
    falloutnv: {
      settingsPath: (game) =>
        path.join(util.getVortexPath("documents", game), "My Games", "FalloutNV"),
      appDataPath: (game) => path.join(localAppData(game), "FalloutNV"),
    },
    fallout4: {
      settingsPath: (game) =>
        path.join(util.getVortexPath("documents", game), "My Games", "Fallout4"),
      appDataPath: (game) => path.join(localAppData(game), "Fallout4"),
    },
    fallout4vr: {
      settingsPath: (game) =>
        path.join(util.getVortexPath("documents", game), "My Games", "Fallout4VR"),
      appDataPath: (game) => path.join(localAppData(game), "Fallout4VR"),
    },
    starfield: {
      settingsPath: (game) =>
        path.join(util.getVortexPath("documents", game), "My Games", "Starfield"),
      appDataPath: (game) => path.join(localAppData(game), "Starfield"),
    },
    oblivion: {
      settingsPath: (game) =>
        path.join(util.getVortexPath("documents", game), "My Games", "Oblivion"),
      appDataPath: (game) => path.join(localAppData(game), "Oblivion"),
    },
    skyrim: {
      settingsPath: (game) =>
        path.join(util.getVortexPath("documents", game), "My Games", "Skyrim"),
      appDataPath: (game) => path.join(localAppData(game), "Skyrim"),
    },
    skyrimse: {
      settingsPath: (game) =>
        path.join(util.getVortexPath("documents", game), "My Games", "Skyrim Special Edition"),
      appDataPath: (game) => path.join(localAppData(game), "Skyrim Special Edition"),
    },
    skyrimvr: {
      settingsPath: (game) =>
        path.join(util.getVortexPath("documents", game), "My Games", "SkyrimVR"),
      appDataPath: (game) => path.join(localAppData(game), "SkyrimVR"),
    },
  },
  {
    xbox: {
      skyrimse: {
        settingsPath: (game) =>
          path.join(util.getVortexPath("documents", game), "My Games", "Skyrim Special Edition MS"),
        appDataPath: (game) => path.join(localAppData(game), "Skyrim Special Edition MS"),
      },
      fallout4: {
        settingsPath: (game) =>
          path.join(util.getVortexPath("documents", game), "My Games", "Fallout4 MS"),
        appDataPath: (game) => path.join(localAppData(game), "Fallout4 MS"),
      },
    },
    gog: {
      skyrimse: {
        settingsPath: (game) =>
          path.join(
            util.getVortexPath("documents", game),
            "My Games",
            "Skyrim Special Edition GOG",
          ),
        appDataPath: (game) => path.join(localAppData(game), "Skyrim Special Edition GOG"),
      },
      enderalspecialedition: {
        settingsPath: (game) =>
          path.join(
            util.getVortexPath("documents", game),
            "My Games",
            "Enderal Special Edition GOG",
          ),
        appDataPath: (game) => path.join(localAppData(game), "Enderal Special Edition GOG"),
      },
    },
    epic: {
      skyrimse: {
        settingsPath: (game) =>
          path.join(
            util.getVortexPath("documents", game),
            "My Games",
            "Skyrim Special Edition EPIC",
          ),
        appDataPath: (game) => path.join(localAppData(game), "Skyrim Special Edition EPIC"),
      },
      fallout4: {
        settingsPath: (game) =>
          path.join(util.getVortexPath("documents", game), "My Games", "Fallout4 EPIC"),
        appDataPath: (game) => path.join(localAppData(game), "Fallout4 EPIC"),
      },
    },
  },
  (gameId) => gameStoreForGame(gameId),
);

let gameStoreForGame: (gameId: string) => string = () => undefined;

export function initGameSupport(api: types.IExtensionApi) {
  gameStoreForGame = (gameId: string) =>
    selectors.discoveryByGame(api.store.getState(), gameId)?.store;
}

export function settingsPath(game: types.IGame): string {
  return gameSupport.get(game.id, "settingsPath")?.(game) ?? game.details?.settingsPath?.();
}

export function appDataPath(game: types.IGame): string {
  return gameSupport.get(game.id, "appDataPath")?.(game) ?? game.details?.appDataPath?.();
}
