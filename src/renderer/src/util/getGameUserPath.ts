import { statSync } from "node:fs";
import * as path from "node:path";

import type { IDiscoveryResult } from "../extensions/gamemode_management/types/IDiscoveryResult";
import { ProcessCanceled } from "./CustomErrors";
import getVortexPath from "./getVortexPath";
import { findSteamGameForTool } from "./linux/gameEntry";
import Steam, { type ISteamEntry } from "./Steam";

export type GameUserPath = "documents" | "localAppData";

/** Resolve user files for a discovered Steam/Proton game, including secondary libraries. */
export function getGameUserPath(
  id: GameUserPath,
  discovery?: Pick<IDiscoveryResult, "path" | "store">,
): string {
  if (process.platform !== "linux" || discovery?.path === undefined) {
    return getVortexPath(id);
  }

  const entry = findSteamGameForTool(
    Steam.snapshot().entries as ISteamEntry[],
    discovery.path,
    undefined,
    discovery.path,
  );
  if (entry === undefined && discovery.store !== "steam") {
    return getVortexPath(id);
  }

  const userPath = entry?.compatDataPath
    ? path.join(entry.compatDataPath, "pfx", "drive_c", "users", "steamuser")
    : undefined;
  if (
    !entry?.usesProton ||
    userPath === undefined ||
    !statSync(userPath, { throwIfNoEntry: false })?.isDirectory()
  ) {
    throw new ProcessCanceled(
      "The game's Proton user directory could not be found. Launch the game once in Steam and refresh game discovery before managing its settings or plugins.",
    );
  }

  if (id === "localAppData") return path.join(userPath, "AppData", "Local");
  // Keep Wine's directory symlinks: they may redirect Documents to the user's host folder.
  const documents = path.join(userPath, "Documents");
  const legacyDocuments = path.join(userPath, "My Documents");
  return !statSync(documents, { throwIfNoEntry: false })?.isDirectory() &&
    statSync(legacyDocuments, { throwIfNoEntry: false })?.isDirectory()
    ? legacyDocuments
    : documents;
}
