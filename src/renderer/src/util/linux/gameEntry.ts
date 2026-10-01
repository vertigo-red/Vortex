import * as path from "node:path";

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
  if (discoveredGamePath !== undefined) {
    const entry = entries.find(
      (game) => path.resolve(game.gamePath) === path.resolve(discoveredGamePath),
    );
    if (entry !== undefined) return entry;
  }
  return entries
    .filter(
      (game) =>
        isInside(game.gamePath, executable) ||
        (workingDirectory && isInside(game.gamePath, workingDirectory)),
    )
    .sort((left, right) => right.gamePath.length - left.gamePath.length)[0];
}
