import { statSync } from "node:fs";
import * as path from "node:path";

import { getErrorMessageOrDefault } from "@vortex/shared";

import type { IDiscoveryResult } from "../extensions/gamemode_management/types/IDiscoveryResult";
import { ProcessCanceled } from "./CustomErrors";
import { resolveWindowsGamePath } from "./gamePaths";
import getVortexPath from "./getVortexPath";
import { findSteamGameForTool } from "./linux/gameEntry";
import { findWineSettingsPrefix, wineSettingsUser } from "./linux/wineSettingsPrefix";
import { getWineUserFolder } from "./linux/wineUserFolders";
import Steam, { type ISteamEntry } from "./Steam";

export type GameUserPath = "documents" | "localAppData";

/** Resolve game user files without starting Wine. Bethesda callers require a known prefix. */
export function getGameUserPath(
  id: GameUserPath,
  discovery?: Pick<IDiscoveryResult, "path" | "store" | "modSettingsPrefix">,
  requireWinePrefix: boolean = false,
): string {
  if (process.platform !== "linux") return getVortexPath(id);
  if (discovery?.path === undefined) {
    if (requireWinePrefix) {
      throw new ProcessCanceled("Discover the game's installation before managing its settings.");
    }
    return getVortexPath(id);
  }

  const entry = findSteamGameForTool(
    Steam.snapshot().entries as ISteamEntry[],
    discovery.path,
    undefined,
    discovery.path,
  );
  try {
    const explicit = discovery.modSettingsPrefix;
    const steamPrefix =
      entry?.usesProton && entry.compatDataPath
        ? path.join(entry.compatDataPath, "pfx")
        : undefined;
    const prefix =
      explicit ??
      steamPrefix ??
      (entry === undefined ? findWineSettingsPrefix(discovery.path) : undefined);
    if (prefix === undefined) {
      if (!requireWinePrefix && entry === undefined && discovery.store !== "steam")
        return getVortexPath(id);
      throw new Error(
        "The game's settings prefix could not be found. Initialize its Wine/Proton prefix, " +
          "then select it with 'Set Game Settings Prefix' in Games.",
      );
    }
    const steam = explicit === undefined && steamPrefix !== undefined;
    // Steam's profile is fixed; old discovered prefixes may not have persisted Registry files.
    const userName = steam ? "steamuser" : wineSettingsUser(prefix);
    const userPath = path.join(prefix, "drive_c", "users", userName);
    if (!statSync(userPath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("The game's Wine/Proton user directory could not be found.");
    }
    const redirected = getWineUserFolder(prefix, id, userName);
    if (redirected !== undefined) return redirected;
    if (id === "localAppData")
      return resolveWindowsGamePath(userPath, path.join("AppData", "Local"));
    // Keep Wine's symlinks: Documents may point to the user's host folder.
    const documents = resolveWindowsGamePath(userPath, "Documents");
    const legacyDocuments = resolveWindowsGamePath(userPath, "My Documents");
    return !statSync(documents, { throwIfNoEntry: false })?.isDirectory() &&
      statSync(legacyDocuments, { throwIfNoEntry: false })?.isDirectory()
      ? legacyDocuments
      : documents;
  } catch (err) {
    throw new ProcessCanceled(
      `The game's Wine/Proton user folder could not be resolved: ${getErrorMessageOrDefault(err)}`,
    );
  }
}
