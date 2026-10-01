import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { parse, type VDFObject, type VDFValue } from "simple-vdf";

export function vdfValue(root: VDFValue | undefined, ...keys: string[]): VDFValue | undefined {
  let value = root;
  for (const key of keys) {
    if (typeof value !== "object" || value === null) return undefined;
    const actualKey = Object.keys(value).find((entry) => entry.toLowerCase() === key.toLowerCase());
    value = actualKey === undefined ? undefined : value[actualKey];
  }
  return value;
}

export function parseSteamLibraries(contents: string, steamPath: string): string[] {
  const folders = vdfValue(parse(contents) as VDFObject, "libraryfolders");
  const libraries = new Set([steamPath]);
  if (typeof folders !== "object" || folders === null) return [...libraries];

  // Library indices need not be contiguous. Older clients store paths as leaves.
  for (const [index, entry] of Object.entries(folders)) {
    if (!/^\d+$/.test(index)) continue;
    const libraryPath = typeof entry === "string" ? entry : vdfValue(entry, "path");
    if (typeof libraryPath === "string" && path.isAbsolute(libraryPath)) {
      libraries.add(path.normalize(libraryPath));
    }
  }
  return [...libraries];
}

export async function readSteamLibraries(steamPath: string): Promise<string[]> {
  for (const directory of ["steamapps", "config"]) {
    let contents: string;
    try {
      contents = await readFile(path.join(steamPath, directory, "libraryfolders.vdf"), "utf8");
    } catch (err) {
      if (["ENOENT", "EACCES", "EPERM"].includes((err as NodeJS.ErrnoException).code)) continue;
      throw err;
    }
    try {
      return parseSteamLibraries(contents, steamPath);
    } catch {
      // A partially written file must not hide the base library; try the legacy location.
    }
  }
  return [steamPath];
}
