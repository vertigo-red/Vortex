import { fs, selectors, types, log } from "@nexusmods/vortex-api";
import Bluebird from "bluebird";
import getVersion from "exe-version";
import * as semver from "semver";

import supportData from "./gameSupport";
import { IGameSupport } from "./types";

const getGameStore = (gameId: string, api: types.IExtensionApi): string | undefined =>
  selectors.discoveryByGame(api.getState(), gameId)["store"];

const getScriptExtenderVersion = async (extenderPath: string): Promise<string | undefined> => {
  try {
    await fs.statAsync(extenderPath);
    const exeVersion = getVersion(extenderPath);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(exeVersion)) return undefined;
    // SKSE 1.7.3 is encoded as the Windows file version 0.1.7.3.
    const parts = exeVersion.split(".");
    return semver.coerce((parts[0] === "0" ? parts.slice(1) : parts).join("."))?.version;
  } catch (err) {
    log("debug", "Script extender version unavailable:", { extenderPath, error: err });
    return undefined;
  }
};

const getGamePath = (gameId: string, api): string => {
  const state: types.IState = api.store.getState();
  const discovery = state.settings.gameMode.discovered[gameId];
  if (discovery !== undefined) {
    return discovery.path;
  } else {
    return undefined;
  }
};

function toBlue<T>(func: (...args: any[]) => Promise<T>): (...args: any[]) => Bluebird<T> {
  return (...args: any[]) => Bluebird.resolve(func(...args));
}

function clearNotifications(api: types.IExtensionApi, preserveMissing?: boolean) {
  Object.keys(supportData).forEach((key) => {
    if (!preserveMissing) {
      api.dismissNotification(`scriptextender-missing-${key}`);
    }
    api.dismissNotification(`scriptextender-update-${key}`);
  });
}

function ignoreNotifications(gameSupport: IGameSupport) {
  // Allows the github downloader to set the ignore flag.
  const match = Object.keys(supportData).find((key) => key === gameSupport.gameId);
  supportData[match].ignore = true;
}

export {
  getGameStore,
  getScriptExtenderVersion,
  getGamePath,
  toBlue,
  clearNotifications,
  ignoreNotifications,
};
