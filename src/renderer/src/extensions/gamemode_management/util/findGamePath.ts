import { stat } from "node:fs/promises";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

import type { IGame } from "../../../types/IGame";
import { ProcessCanceled } from "../../../util/CustomErrors";
import { gameFilePath, normalizeGameRelativePath } from "../../../util/gamePaths";

/** Find the installation root when a user selects an executable's nested directory. */
export async function findGamePath(
  game: Pick<IGame, "requiredFiles">,
  selectedPath: string,
): Promise<string> {
  const requiredFiles = game.requiredFiles ?? [];
  const maxDepth = requiredFiles.reduce((depth, file) => {
    const relative = normalizeGameRelativePath(file);
    const components = relative.split(process.platform === "win32" ? /[/\\]/ : path.sep);
    return Math.max(depth, components.length);
  }, 0);

  let directory = selectedPath;
  for (let depth = 0; depth <= maxDepth; ++depth) {
    try {
      await Promise.all(requiredFiles.map((file) => stat(gameFilePath(directory, file))));
    } catch (err) {
      if (getErrorCode(err) === "ENOENT") {
        directory = path.dirname(directory);
        continue;
      }
      // Store-managed games can be inaccessible to Vortex while remaining launchable.
    }
    return directory;
  }
  throw new ProcessCanceled("not found");
}
