import { realpathSync } from "node:fs";
import * as path from "node:path";

function resolveGamePath(input: string): string {
  const resolved = path.resolve(input);
  if (process.platform !== "linux") return resolved;
  let directory = resolved;
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(directory), ...suffix);
    } catch {
      // Resolve the existing parent even if an executable has not been installed yet.
      const parent = path.dirname(directory);
      if (parent === directory) return resolved;
      suffix.unshift(path.basename(directory));
      directory = parent;
    }
  }
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** Resolve an external tool by its game's discovery path before examining the tool's location. */
export function findSteamGameForTool<T extends { gamePath: string }>(
  entries: T[],
  executable: string,
  workingDirectory?: string,
  discoveredGamePath?: string,
): T | undefined {
  const games = entries.map((game) => ({ game, directory: resolveGamePath(game.gamePath) }));
  if (discoveredGamePath !== undefined) {
    const discovered = resolveGamePath(discoveredGamePath);
    // Discovery selects the prefix. A tool in another game must never override it.
    return games.find(({ directory }) => directory === discovered)?.game;
  }
  const candidates = [executable, workingDirectory]
    .filter((candidate): candidate is string => candidate !== undefined && candidate !== "")
    .map(resolveGamePath);
  return games
    .filter(({ directory }) => candidates.some((candidate) => isInside(directory, candidate)))
    .sort((left, right) => right.directory.length - left.directory.length)[0]?.game;
}
