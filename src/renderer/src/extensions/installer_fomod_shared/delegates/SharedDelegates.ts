import exeVersion from "exe-version";

import type { IExtensionApi } from "../../../types/IExtensionContext";
import type { IState } from "../../../types/IState";
import { getApplication } from "../../../util/application";
import { resolveWindowsGamePath } from "../../../util/gamePaths";
import { discoveryByGame } from "../../gamemode_management/selectors";
import { getGame } from "../../gamemode_management/util/getGame";
import { hasLoadOrder, hasSessionPlugins } from "../utils/guards";

const extenderExecutables: Record<string, Record<string, string>> = {
  oblivion: { obse: "obse_loader.exe" },
  skyrim: { skse: "skse_loader.exe" },
  skyrimse: { skse: "skse64_loader.exe", skse64: "skse64_loader.exe" },
  skyrimvr: { skse: "sksevr_loader.exe", sksevr: "sksevr_loader.exe" },
  fallout3: { fose: "fose_loader.exe" },
  falloutnv: { nvse: "nvse_loader.exe" },
  fallout4: { f4se: "f4se_loader.exe" },
  fallout4vr: { f4se: "f4sevr_loader.exe" },
  starfield: { sfse: "sfse_loader.exe" },
};

/**
 * Core delegates for FOMOD installer IPC communication
 * These are called by the C# installer process to query game/mod state
 */
export class SharedDelegates {
  public static async create(api: IExtensionApi, gameId: string): Promise<SharedDelegates> {
    const delegates = new SharedDelegates(api);
    await delegates.initialize(gameId);
    return delegates;
  }

  private mApi: IExtensionApi;
  private mGameVersion: string | null = null;
  private mGameId: string;
  private mGamePath: string | undefined;

  private constructor(api: IExtensionApi) {
    this.mApi = api;
  }

  private initialize = async (gameId: string): Promise<void> => {
    const state = this.mApi.getState();
    const discovery = discoveryByGame(state, gameId);
    this.mGameId = gameId;
    this.mGamePath = discovery?.path;
    const gameInfo = getGame(gameId);
    this.mGameVersion = (await gameInfo?.getInstalledVersion?.(discovery)) ?? null;
  };

  /**
   * Get the application version
   */
  public getAppVersion = (): string => {
    try {
      return getApplication().version;
    } catch (error) {
      return "";
    }
  };

  /**
   * Get the current game version
   */
  public getCurrentGameVersion = (): string => {
    try {
      return this.mGameVersion.split(/\-+/)[0];
    } catch (error) {
      return "";
    }
  };

  /**
   * Get the version of a script extender (e.g., SKSE, F4SE)
   */
  public getExtenderVersion = (extender: string): string => {
    try {
      const executable = extenderExecutables[this.mGameId]?.[extender?.toLowerCase()];
      if (executable === undefined || this.mGamePath === undefined) return "";
      const version = exeVersion(resolveWindowsGamePath(this.mGamePath, executable));
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) return "";
      // Script extender loaders encode 1.7.3 as the Windows file version 0.1.7.3.
      const parts = version.split(".");
      return (parts[0] === "0" ? parts.slice(1) : parts).join(".");
    } catch (error) {
      return "";
    }
  };

  /**
   * Get all plugins (mods with .esp/.esm/.esl files)
   */
  public getAllPlugins = (activeOnly: boolean): string[] => {
    try {
      const state = this.mApi.getState();
      if (!hasSessionPlugins(state.session)) {
        return [];
      }

      const pluginList = state.session.plugins?.pluginList ?? {};
      let plugins = Object.keys(pluginList);
      if (activeOnly === true) {
        plugins = plugins.filter((name) => this.isPluginEnabled(state, pluginList, plugins, name));
      }
      return plugins;
    } catch (error) {
      return [];
    }
  };

  private isPluginEnabled = (
    state: IState,
    pluginList: any,
    plugins: string[],
    pluginName: string,
  ) => {
    const existingPluginName = plugins.find(
      (plugin) => plugin.toLowerCase() === pluginName.toLowerCase(),
    );
    if (existingPluginName === undefined) {
      // unknown plugin can't be enabled
      return false;
    }
    if (pluginList[existingPluginName].isNative) {
      return true;
    }

    if (!hasLoadOrder(state)) {
      return false;
    }

    return state.loadOrder[existingPluginName]?.enabled ?? false;
  };
}
