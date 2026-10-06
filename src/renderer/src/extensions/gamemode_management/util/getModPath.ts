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
  return windowsPaths ? resolveWindowsGamePath("", absolutePath) : absolutePath;
}
