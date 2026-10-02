import * as fs from "fs";
import { homedir } from "node:os";
import * as path from "path";

/**
 * Default Steam installation paths for Linux systems
 * Ordered by likelihood (most common first)
 */
export function getLinuxSteamPaths(): string[] {
  const home = homedir();
  const dataHome = process.env.XDG_DATA_HOME;
  return [
    ...new Set([
      ...(dataHome && path.isAbsolute(dataHome) ? [path.join(dataHome, "Steam")] : []),
      path.join(home, ".local", "share", "Steam"), // XDG standard (native)
      path.join(home, ".steam", "debian-installation"), // Debian/Ubuntu symlink
      path.join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam"), // Flatpak
      path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
      path.join(home, "snap", "steam", "common", ".local", "share", "Steam"), // Snap
      path.join(home, ".steam", "root"),
      path.join(home, ".steam", "steam"), // Legacy
    ]),
  ];
}

/**
 * Check if a path is a valid Steam installation
 */
export function isValidSteamPath(steamPath: string): boolean {
  try {
    return fs.statSync(path.join(steamPath, "steamapps")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find the first valid Steam installation path on Linux
 */
export function findLinuxSteamPath(): string | undefined {
  for (const steamPath of getLinuxSteamPaths()) {
    if (isValidSteamPath(steamPath)) {
      return steamPath;
    }
  }
  return undefined;
}
