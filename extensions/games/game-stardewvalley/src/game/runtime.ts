import { statSync } from "node:fs";
import path from "node:path";

/** The game assembly is shared by modern Windows, Linux, and macOS installs. */
export const GAME_ASSEMBLY = "Stardew Valley.dll";
export const WINDOWS_GAME_EXE = "Stardew Valley.exe";
export const NATIVE_GAME_EXE = "StardewValley";

/** Check a launcher without treating permission errors as a different runtime. */
export function isLauncherFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch (err) {
    if (["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw err;
  }
}

/**
 * Resolve the selected installation's runtime. Linux can manage native games
 * and Windows games in Wine/Proton prefixes. Prefer the native launcher when
 * both launchers exist, including legacy Unix installations containing an exe.
 * With no installation path, preserve the host's default executable metadata.
 */
export function resolveGamePlatform(
  gamePath?: string,
  hostPlatform: NodeJS.Platform = process.platform,
): NodeJS.Platform {
  if (hostPlatform !== "linux" || gamePath === undefined) {
    return hostPlatform;
  }
  if (isLauncherFile(path.join(gamePath, NATIVE_GAME_EXE))) {
    return "linux";
  }
  if (isLauncherFile(path.join(gamePath, WINDOWS_GAME_EXE))) {
    return "win32";
  }
  throw new Error(
    `Stardew Valley launcher not found in ${gamePath}. Expected ${NATIVE_GAME_EXE} or ${WINDOWS_GAME_EXE}.`,
  );
}

/** Return the launcher belonging to the selected installation. */
export function resolveGameExecutable(
  gamePath?: string,
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  return resolveGamePlatform(gamePath, hostPlatform) === "win32"
    ? WINDOWS_GAME_EXE
    : NATIVE_GAME_EXE;
}
