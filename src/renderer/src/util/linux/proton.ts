import * as path from "node:path";

import { getErrorMessageOrDefault } from "@vortex/shared";
import { parse } from "simple-vdf";

import * as fs from "../fs";
import { log } from "../log";
import { readSteamLibraries, vdfValue } from "./steamLibraries";

export interface IProtonInfo {
  usesProton: boolean;
  compatDataPath?: string;
  protonPath?: string;
}

export async function detectProtonUsage(steamAppsPath: string, appId: string): Promise<boolean> {
  try {
    const prefix = await fs.statAsync(
      path.join(getCompatDataPath(steamAppsPath, appId), "pfx", "drive_c"),
    );
    return prefix.isDirectory();
  } catch {
    return false;
  }
}

export function getCompatDataPath(steamAppsPath: string, appId: string): string {
  return path.join(steamAppsPath, "compatdata", appId);
}

export function getWinePrefixPath(compatDataPath: string): string {
  return path.join(compatDataPath, "pfx");
}

export async function getConfiguredProtonName(
  steamPath: string,
  appId: string,
): Promise<string | undefined> {
  try {
    const config = parse(
      (await fs.readFileAsync(path.join(steamPath, "config", "config.vdf"))).toString(),
    );
    const mapping = vdfValue(
      config,
      "InstallConfigStore",
      "Software",
      "Valve",
      "Steam",
      "CompatToolMapping",
    );
    const name = vdfValue(mapping, appId, "name") ?? vdfValue(mapping, "0", "name");
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch (err) {
    log("debug", "Could not read Steam compatibility configuration", {
      error: getErrorMessageOrDefault(err),
    });
    return undefined;
  }
}

async function hasProtonLauncher(directory: string): Promise<boolean> {
  try {
    return (await fs.statAsync(path.join(directory, "proton"))).isFile();
  } catch {
    return false;
  }
}

async function subdirectories(directory: string): Promise<string[]> {
  try {
    return (await fs.readdirAsync(directory)).map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

function folderMatchesName(folder: string, name: string): boolean {
  if (folder.toLowerCase() === name.toLowerCase()) return true;
  const keyword = /^proton_(.+)$/i.exec(name)?.[1];
  if (keyword === undefined) return false;
  // proton_9 must never match Proton 19 by a substring accident.
  if (/^\d+$/.test(keyword)) return new RegExp(`^proton[ -]+${keyword}(?:\\.|$)`, "i").test(folder);
  return folder.toLowerCase().replace(/[ -]+/g, "_") === `proton_${keyword.toLowerCase()}`;
}

async function resolveToolMetadata(directory: string, name: string): Promise<string | undefined> {
  try {
    const metadata = parse(
      (await fs.readFileAsync(path.join(directory, "compatibilitytool.vdf"))).toString(),
    );
    const tool = vdfValue(metadata, "compatibilitytools", "compat_tools", name);
    if (typeof tool !== "object" || tool === null) return undefined;
    const installPath = vdfValue(tool, "install_path");
    const resolved = path.resolve(directory, typeof installPath === "string" ? installPath : ".");
    return (await hasProtonLauncher(resolved)) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveProtonPath(
  steamPath: string,
  protonName: string,
): Promise<string | undefined> {
  // Tool names come from a local configuration file; never interpret them as paths.
  if (/[\\/]/.test(protonName) || protonName === "." || protonName === "..") return undefined;
  const libraries = await readSteamLibraries(steamPath);
  const directories = [
    ...(await subdirectories(path.join(steamPath, "compatibilitytools.d"))),
    ...(
      await Promise.all(
        libraries.map((library) => subdirectories(path.join(library, "steamapps", "common"))),
      )
    ).flat(),
  ];

  // The tool's own manifest is authoritative, including custom directory names.
  for (const directory of directories) {
    const resolved = await resolveToolMetadata(directory, protonName);
    if (resolved !== undefined) return resolved;
  }
  for (const directory of directories) {
    if (
      folderMatchesName(path.basename(directory), protonName) &&
      (await hasProtonLauncher(directory))
    )
      return directory;
  }
  return undefined;
}

/** Used only when no explicit compatibility tool is configured. */
export async function findLatestProton(steamPath: string): Promise<string | undefined> {
  const libraries = await readSteamLibraries(steamPath);
  const directories = (
    await Promise.all(
      libraries.map((library) => subdirectories(path.join(library, "steamapps", "common"))),
    )
  ).flat();
  const candidates = directories.filter((directory) =>
    /^proton[ -]+\d/i.test(path.basename(directory)),
  );
  candidates.sort((left, right) =>
    path.basename(right).localeCompare(path.basename(left), "en", { numeric: true }),
  );
  for (const directory of candidates) {
    if (await hasProtonLauncher(directory)) return directory;
  }
  return undefined;
}

async function getPrefixProtonPath(compatDataPath: string): Promise<string | undefined> {
  try {
    // Proton records its fonts and library directories in config_info. Reuse that build
    // when Steam has no explicit mapping, rather than upgrading a prefix just to run a tool.
    const lines = (await fs.readFileAsync(path.join(compatDataPath, "config_info")))
      .toString()
      .split(/\r?\n/);
    for (const line of lines.slice(1, 3)) {
      if (!path.isAbsolute(line)) continue;
      let directory = line;
      for (let depth = 0; depth < 4; ++depth) {
        if (await hasProtonLauncher(directory)) return directory;
        directory = path.dirname(directory);
      }
    }
  } catch {
    // Older Proton releases may not have recorded this information.
  }
  return undefined;
}

export async function getProtonInfo(
  steamPath: string,
  steamAppsPath: string,
  appId: string,
): Promise<IProtonInfo> {
  const compatDataPath = getCompatDataPath(steamAppsPath, appId);
  const protonName = await getConfiguredProtonName(steamPath, appId);
  // A stale compatdata directory is not evidence that a native game still uses Proton.
  if (protonName?.toLowerCase().startsWith("steamlinuxruntime")) return { usesProton: false };
  const usesProton = await detectProtonUsage(steamAppsPath, appId);
  if (!usesProton) return { usesProton: false };

  const protonPath =
    protonName !== undefined
      ? await resolveProtonPath(steamPath, protonName)
      : await getPrefixProtonPath(compatDataPath);
  // An unavailable selected build stays unavailable. Choosing an arbitrary installed
  // version here can migrate the game's existing Wine prefix.
  return { usesProton: true, compatDataPath, protonPath };
}

export function isWindowsExecutable(filePath: string): boolean {
  return [".exe", ".bat", ".cmd"].includes(path.extname(filePath).toLowerCase());
}

export function buildProtonEnvironment(
  compatDataPath: string,
  steamPath: string,
  existingEnv?: Record<string, string>,
  appId: string = path.basename(compatDataPath),
  gamePath?: string,
): Record<string, string> {
  return {
    ...existingEnv,
    STEAM_COMPAT_DATA_PATH: compatDataPath,
    STEAM_COMPAT_CLIENT_INSTALL_PATH: steamPath,
    STEAM_COMPAT_APP_ID: appId,
    SteamAppId: appId,
    SteamGameId: appId,
    ...(gamePath ? { STEAM_COMPAT_INSTALL_PATH: gamePath } : {}),
    WINEPREFIX: getWinePrefixPath(compatDataPath),
  };
}

export function buildProtonCommand(
  protonPath: string,
  exePath: string,
  args: string[],
): { executable: string; args: string[] } {
  const script = [".bat", ".cmd"].includes(path.extname(exePath).toLowerCase());
  return {
    executable: path.join(protonPath, "proton"),
    args: script ? ["run", "cmd.exe", "/c", exePath, ...args] : ["run", exePath, ...args],
  };
}
