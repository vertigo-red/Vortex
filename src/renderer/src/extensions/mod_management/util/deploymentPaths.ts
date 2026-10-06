import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

import type { IExtensionApi } from "../../../types/IExtensionContext";
import { ProcessCanceled } from "../../../util/CustomErrors";
import * as fs from "../../../util/fs";
import getNormalizeFunc, { type Normalize } from "../../../util/getNormalizeFunc";
import { getGame } from "../../gamemode_management/util/getGame";

export function usesWindowsGamePaths(api: IExtensionApi, gameId: string): boolean {
  if (process.platform !== "linux") return false;
  const game = getGame(gameId);
  const discovery = api.getState().settings.gameMode.discovered[gameId];
  return game?.executable(discovery?.path)?.toLowerCase().endsWith(".exe") === true;
}

/** Game conflicts follow the selected game's rules, rather than the host filesystem alone. */
export async function getDeploymentNormalize(
  api: IExtensionApi,
  gameId: string,
  destinationPath: string,
): Promise<Normalize> {
  const windowsPaths = usesWindowsGamePaths(api, gameId);
  const normalize = await getNormalizeFunc(
    destinationPath,
    windowsPaths ? { caseSensitive: false } : undefined,
  );
  return windowsPaths ? (input) => normalize(input.replace(/\\/g, "/")) : normalize;
}

/**
 * Reuse existing spellings and reserve new directory names before parallel linking starts.
 * Reading each directory once also avoids one filesystem round trip per path component/file.
 */
export class WindowsDeploymentPaths {
  private directories = new Map<string, Map<string, string[]>>();

  constructor(
    private root: string,
    private backupTag: string,
  ) {}

  public async resolve(relativePath: string): Promise<string> {
    const segments = path.normalize(relativePath).split(path.sep);
    let current = this.root;
    const resolved: string[] = [];
    for (const requested of segments) {
      if (requested === ".") continue;
      const names = await this.readDirectory(current);
      const folded = requested.toUpperCase();
      const matches = names.get(folded) ?? [];
      if (matches.length > 1) {
        throw new ProcessCanceled(
          `Ambiguous Windows game path "${path.join(current, requested)}".`,
        );
      }
      const spelling = matches[0] ?? requested;
      names.set(folded, [spelling]);
      resolved.push(spelling);
      current = path.join(current, spelling);
    }
    return path.join(...resolved);
  }

  private async readDirectory(directory: string): Promise<Map<string, string[]>> {
    let names = this.directories.get(directory);
    if (names !== undefined) return names;
    names = new Map();
    let entries: string[];
    try {
      entries = await fs.readdirAsync(directory);
    } catch (err) {
      if (getErrorCode(err) !== "ENOENT") throw err;
      entries = [];
    }
    for (const entry of entries) {
      const folded = entry.toUpperCase();
      names.set(folded, [...(names.get(folded) ?? []), entry]);
    }
    const backups = new Map<string, string[]>();
    for (const entry of entries.filter((name) => name.endsWith(this.backupTag))) {
      const original = entry.slice(0, -this.backupTag.length);
      const folded = original.toUpperCase();
      backups.set(folded, [...(backups.get(folded) ?? []), original]);
    }
    for (const [folded, originals] of backups) {
      // Restoring a deleted link must keep the spelling of its original backup.
      if (!names.has(folded)) names.set(folded, originals);
    }
    this.directories.set(directory, names);
    return names;
  }
}
