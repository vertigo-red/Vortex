import { accessSync, constants, statSync } from "node:fs";
import * as path from "node:path";

import { getErrorMessageOrDefault } from "@vortex/shared";

import type { IDiscoveryResult } from "../extensions/gamemode_management/types/IDiscoveryResult";
import { MissingInterpreter, ProcessCanceled } from "./CustomErrors";
import { findSteamGameForTool } from "./linux/gameEntry";
import { buildProtonCommand, buildProtonEnvironment } from "./linux/proton";
import { toWinePath } from "./linux/winePaths";
import Steam, { type ISteamEntry } from "./Steam";

/** Prepare a Windows CLI launch in the discovered game's selected Proton build and prefix. */
export async function getProtonToolCommand(
  executable: string,
  args: Array<string | { path: string }>,
  discovery: Pick<IDiscoveryResult, "path" | "store">,
): Promise<{ executable: string; args: string[]; env: Record<string, string> }> {
  if (process.platform !== "linux" || !discovery?.path) {
    throw new ProcessCanceled("A discovered Linux Steam/Proton game is required to run this tool.");
  }
  const steamExecutable = await Steam.getGameStorePath();
  const entry = findSteamGameForTool(
    Steam.snapshot().entries as ISteamEntry[],
    executable,
    undefined,
    discovery.path,
  );
  if (!steamExecutable || !entry?.usesProton || !entry.protonPath || !entry.compatDataPath) {
    throw new MissingInterpreter(
      "The game's selected Proton installation could not be found. " +
        "Select an installed compatibility tool in Steam, launch the game once, and refresh discovery.",
    );
  }
  const prefix = path.join(entry.compatDataPath, "pfx");
  try {
    accessSync(path.join(entry.protonPath, "proton"), constants.X_OK);
    if (!statSync(path.join(prefix, "drive_c"), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("The game's Proton prefix has not been initialized. Launch the game once.");
    }
    const command = buildProtonCommand(
      entry.protonPath,
      toWinePath(prefix, executable),
      args.map((arg) => (typeof arg === "string" ? arg : toWinePath(prefix, arg.path))),
    );
    return {
      ...command,
      env: buildProtonEnvironment(
        entry.compatDataPath,
        path.dirname(steamExecutable),
        undefined,
        entry.appid,
        entry.gamePath,
      ),
    };
  } catch (err) {
    throw new ProcessCanceled(
      `The Proton tool launch could not be prepared: ${getErrorMessageOrDefault(err)}`,
    );
  }
}
