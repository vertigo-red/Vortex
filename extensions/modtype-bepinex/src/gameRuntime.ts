import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { getBepInExPath, getSupportMap } from "./common";
import type { BepInExPlatform, IBepInExGameConfig } from "./types";

function executablePath(api: types.IExtensionApi, gameId: string): string {
  const discovery = api.getState().settings.gameMode.discovered[gameId];
  const game = util.getGame(gameId);
  if (!discovery?.path || !game)
    throw new util.ProcessCanceled("Discover the game before selecting a BepInEx package");
  const executable = discovery.executable ?? game.executable(discovery.path);
  if (!executable) throw new util.ProcessCanceled("The game's executable is not configured");
  return path.resolve(discovery.path, executable.replace(/\\/g, "/"));
}

export async function resolveGamePlatform(
  api: types.IExtensionApi,
  gameConf: IBepInExGameConfig,
): Promise<BepInExPlatform> {
  if (gameConf.targetPlatform !== undefined) {
    if (["win32", "linux", "darwin"].includes(gameConf.targetPlatform))
      return gameConf.targetPlatform;
    throw new util.DataInvalid("Invalid BepInEx target platform");
  }
  if (process.platform === "win32" || process.platform === "darwin") return process.platform;
  if (process.platform !== "linux")
    throw new util.ProcessCanceled("Unsupported BepInEx host platform");
  const file = await open(executablePath(api, gameConf.gameId), "r");
  try {
    const header = Buffer.alloc(4);
    await file.read(header, 0, 4, 0);
    if (header[0] === 0x4d && header[1] === 0x5a) return "win32";
    if (
      header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      (header[0] === 0x23 && header[1] === 0x21)
    )
      return "linux";
    throw new util.ProcessCanceled(
      "Cannot determine the game's BepInEx platform from its executable",
    );
  } finally {
    await file.close();
  }
}

export function addDoorstopOverride(existing: string, dll: "winhttp" | "version"): string {
  const hasOverride = existing.split(";").some((entry) => {
    const equals = entry.indexOf("=");
    if (equals === -1) return false;
    return entry
      .slice(0, equals)
      .split(",")
      .some((name) => {
        const normalized = name
          .trim()
          .toLowerCase()
          .replace(/^\*/, "")
          .replace(/\.dll$/, "");
        return normalized === dll || name.trim() === "*";
      });
  });
  return hasOverride
    ? existing
    : existing + (existing && !existing.endsWith(";") ? ";" : "") + dll + "=n,b";
}

export async function prepareBepInExLaunch(
  api: types.IExtensionApi,
  input: types.IRunParameters,
): Promise<types.IRunParameters> {
  if (
    process.platform !== "linux" ||
    path.basename(input.executable) !== "proton" ||
    !["run", "waitforexitandrun"].includes(input.args[0])
  )
    return input;
  const installPath = input.options.env?.STEAM_COMPAT_INSTALL_PATH;
  if (
    !installPath ||
    !input.options.env?.WINEPREFIX ||
    !input.args[1] ||
    !path.isAbsolute(input.args[1])
  )
    return input;
  const root = await realpath(installPath).catch(() => undefined);
  const launched = await realpath(input.args[1]).catch(() => undefined);
  if (!root || !launched) return input;
  const discoveries = api.getState().settings.gameMode.discovered;
  for (const gameConf of Object.values(getSupportMap())) {
    const discovery = discoveries[gameConf.gameId];
    if (!discovery?.path || gameConf.doorstopConfig?.doorstopType === "none") continue;
    if ((await realpath(discovery.path).catch(() => undefined)) !== root) continue;
    const gameExecutable = await Promise.resolve()
      .then(() => executablePath(api, gameConf.gameId))
      .then(realpath)
      .catch(() => undefined);
    if (gameExecutable !== launched) continue;
    const dll = gameConf.doorstopConfig?.doorstopType === "unity3" ? "version" : "winhttp";
    const loader = path.join(getBepInExPath(discovery.path, gameConf), dll + ".dll");
    if (!(await stat(loader).catch(() => undefined))?.isFile()) continue;
    const existing = input.options.env.WINEDLLOVERRIDES ?? process.env.WINEDLLOVERRIDES ?? "";
    const overrides = addDoorstopOverride(existing, dll);
    if (overrides === existing) return input;
    return {
      ...input,
      options: { ...input.options, env: { ...input.options.env, WINEDLLOVERRIDES: overrides } },
    };
  }
  return input;
}
