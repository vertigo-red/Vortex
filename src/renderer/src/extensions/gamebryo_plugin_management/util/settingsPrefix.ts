import type { IExtensionApi, IExtensionContext } from "../../../types/IExtensionContext";
import { getGameUserPath } from "../../../util/getGameUserPath";
import { setGameParameters } from "../../gamemode_management/actions/settings";
import { discoveryByGame } from "../../gamemode_management/selectors";
import { activeGameId } from "../../profile_management/selectors";
import type { IPluginSync } from "../pluginSync";
import { gameSupported, initGameSupport, knownGame } from "./gameSupport";

type ApplyPrefix = (gameId: string, prefix: string | undefined) => Promise<void>;

/** Validate both locations before changing the game's plugin/settings routing. */
export async function selectSettingsPrefix(
  api: IExtensionApi,
  gameId: string,
  apply: ApplyPrefix,
  automatic: boolean = false,
): Promise<void> {
  try {
    const current = discoveryByGame(api.getState(), gameId);
    const prefix = automatic
      ? undefined
      : await api.selectDir({
          title: api.translate("Select the game's Wine prefix (folder containing drive_c)"),
          defaultPath: current?.modSettingsPrefix,
        });
    if (!automatic && !prefix) return;
    const discovery = { ...discoveryByGame(api.getState(), gameId), modSettingsPrefix: prefix };
    if (discovery.path === undefined) return;
    getGameUserPath("documents", discovery, true);
    getGameUserPath("localAppData", discovery, true);
    await apply(gameId, prefix);
  } catch (err) {
    api.showErrorNotification("Could not set game settings prefix", err, { allowReport: false });
  }
}

/** Flush the old files before moving the persistor and LOOT to the selected prefix. */
export async function applySettingsPrefix(
  api: IExtensionApi,
  sync: IPluginSync,
  waitForLoot: () => Promise<void>,
  gameId: string,
  prefix: string | undefined,
): Promise<void> {
  const active = activeGameId(api.getState()) === gameId && gameSupported(gameId);
  if (active) {
    await sync.stop();
    await waitForLoot();
  }
  api.store.dispatch(setGameParameters(gameId, { modSettingsPrefix: prefix }));
  await initGameSupport(api);
  if (active && activeGameId(api.getState()) === gameId) {
    api.events.emit("restart-helpers");
    await sync.start();
    await sync.refresh();
  }
}

export function registerSettingsPrefixActions(
  context: IExtensionContext,
  apply: ApplyPrefix,
  canChange: () => boolean,
): void {
  if (process.platform !== "linux") return;
  const available = (ids: string[]) =>
    canChange() &&
    knownGame(ids[0]) &&
    discoveryByGame(context.api.getState(), ids[0])?.path !== undefined;
  for (const group of ["game-managed-buttons", "game-unmanaged-buttons"]) {
    context.registerAction(
      group,
      125,
      "browse",
      {},
      "Set Game Settings Prefix",
      (ids: string[]) => {
        void selectSettingsPrefix(context.api, ids[0], apply);
      },
      available,
    );
    context.registerAction(
      group,
      126,
      "undo",
      {},
      "Use Automatic Settings Prefix",
      (ids: string[]) => {
        void selectSettingsPrefix(context.api, ids[0], apply, true);
      },
      (ids: string[]) =>
        available(ids) &&
        discoveryByGame(context.api.getState(), ids[0])?.modSettingsPrefix !== undefined,
    );
  }
}
