import * as path from "node:path";

import type { IGame } from "../../../types/IGame";
import { normalizeGameRelativePath, resolveWindowsGamePath } from "../../../util/gamePaths";

/** Activation and deployment must use the same existing default mod directory. */
export function getModPath(game: IGame, gamePath: string): string {
  const requested = game.queryModPath(gamePath) || ".";
  const windowsPaths =
    process.platform === "linux" && game.executable(gamePath)?.toLowerCase().endsWith(".exe");
  const modPath = windowsPaths ? normalizeGameRelativePath(requested) : requested;
  const absolutePath = path.isAbsolute(modPath) ? modPath : path.resolve(gamePath, modPath);
  if (!windowsPaths) return absolutePath;
  const gameRoot = path.resolve(gamePath);
  const relativePath = path.relative(gameRoot, absolutePath);
  const insideGame = relativePath !== ".." && !relativePath.startsWith(".." + path.sep);
  // The selected game root is already known; its ancestors need traversal, not listing access.
  return insideGame
    ? resolveWindowsGamePath(gameRoot, relativePath || ".")
    : resolveWindowsGamePath(path.dirname(absolutePath), path.basename(absolutePath));
}
