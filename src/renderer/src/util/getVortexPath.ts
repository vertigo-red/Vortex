import type { VortexPathBase, QualifiedPath } from "@vortex/shared/filesystem";
import type { VortexPaths } from "@vortex/shared/ipc";

import { ApplicationData } from "../applicationData";
import type { IDiscoveryResult } from "../extensions/gamemode_management/types/IDiscoveryResult";
import type { IGame } from "../types/IGame";
import { ProcessCanceled } from "./CustomErrors";
import { isGameUserPath, resolveGameUserPath, type IGamePrefixEntry } from "./linux/gameUserPaths";
import { VortexPathProvider } from "./vortexPathProvider";

export type AppPath = keyof VortexPaths;

interface IGamePathContext {
  discovery?: IDiscoveryResult;
  steamEntries?: readonly IGamePrefixEntry[];
}

let gameContext: ((game: IGame) => IGamePathContext) | undefined;

export function setGameUserPathContext(
  provider: ((game: IGame) => IGamePathContext) | undefined,
): void {
  gameContext = provider;
}

/**
 * Get an application path, or a game's Wine/Proton known folder when a game is supplied.
 * Application paths and native Linux games keep their host locations.
 * @public
 */
function getVortexPath(id: AppPath, game?: IGame, discovery?: IDiscoveryResult): string {
  const vortexPaths = ApplicationData.instance.paths;
  if (process.platform === "linux" && game && isGameUserPath(id)) {
    const context = gameContext?.(game);
    const installed = discovery ?? context?.discovery;
    const environment = { ...game.environment, ...installed?.environment };
    if (
      installed?.path ||
      environment.WINEPREFIX ||
      environment.STEAM_COMPAT_DATA_PATH ||
      process.env.WINEPREFIX
    ) {
      const executable = installed?.executable ?? game.executable(installed?.path);
      if (
        /\.(exe|bat|cmd)$/i.test(executable ?? "") ||
        environment.WINEPREFIX ||
        environment.STEAM_COMPAT_DATA_PATH
      ) {
        const result = resolveGameUserPath(id, {
          gamePath: installed?.path,
          store: installed?.store,
          environment,
          steamEntries: context?.steamEntries,
          defaultWinePrefix: process.env.WINEPREFIX,
        });
        if (result) return result;
        throw new ProcessCanceled(
          `Could not locate the Wine/Proton user folders for ${game.name}. Start the game once, or configure its WINEPREFIX environment variable in Vortex.`,
        );
      }
    }
  }
  return vortexPaths[id];
}

/** Bind legacy game-extension path calls to their owning game at call time. */
export function makeGamePathGetter(resolveGame: () => IGame | undefined): typeof getVortexPath {
  return (id, game, discovery) =>
    getVortexPath(
      id,
      game ?? (["documents", "appData", "localAppData"].includes(id) ? resolveGame() : undefined),
      discovery,
    );
}

export function getVortexQualifiedPath(base: VortexPathBase): Promise<QualifiedPath> {
  return VortexPathProvider.instance.fromBase(base);
}

export default getVortexPath;
