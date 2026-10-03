import { readdir } from "node:fs/promises";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

/** An existing load order cannot be selected safely from multiple Linux case variants. */
export class PluginFileCasingError extends Error {
  public readonly code = "ENOTUNIQ";

  constructor(directory: string, fileName: string, matches: string[]) {
    super(
      `Multiple filenames match "${fileName}" in "${directory}": ` +
        matches.map((name) => `"${name}"`).join(", ") +
        ". Resolve the conflicting filenames before refreshing the plugin list.",
    );
  }
}

/** Resolve both control files afresh; a different tool may have renamed them since the last read. */
export async function resolvePluginFilePaths(directory: string): Promise<{
  plugins: string;
  loadorder: string;
}> {
  let names: string[] = [];
  if (process.platform === "linux") {
    try {
      names = await readdir(directory);
    } catch (err) {
      if (getErrorCode(err) !== "ENOENT") {
        throw err;
      }
    }
  }

  const resolve = (fileName: string): string => {
    if (names.includes(fileName)) {
      return path.join(directory, fileName);
    }
    const matches = names.filter((name) => name.toLowerCase() === fileName);
    if (matches.length > 1) {
      throw new PluginFileCasingError(directory, fileName, matches);
    }
    return path.join(directory, matches[0] ?? fileName);
  };

  return { plugins: resolve("plugins.txt"), loadorder: resolve("loadorder.txt") };
}
