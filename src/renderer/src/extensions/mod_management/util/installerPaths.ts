import { readdir } from "node:fs/promises";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

import { ProcessCanceled } from "../../../util/CustomErrors";
import type { IInstruction } from "../types/IInstallResult";

/** Windows mod installers use both separators, even when Vortex runs on Linux. */
export function normalizeInstallerInstruction(
  instruction: IInstruction,
  platform: NodeJS.Platform = process.platform,
): IInstruction {
  if (platform !== "linux") {
    return instruction;
  }
  switch (instruction.type) {
    case "copy":
      return {
        ...instruction,
        source: instruction.source?.replace(/\\/g, "/"),
        destination: instruction.destination?.replace(/\\/g, "/"),
      };
    case "mkdir":
    case "generatefile":
    case "iniedit":
      return {
        ...instruction,
        destination: instruction.destination?.replace(/\\/g, "/"),
      };
    default:
      return instruction;
  }
}

interface IArchiveDirectoryIndex {
  exact: Set<string>;
  folded: Map<string, string[]>;
}

/** Cache directory indexes for one extracted archive; never change destination spelling. */
export function createArchiveSourceResolver(rootPath: string): (source: string) => Promise<string> {
  const root = path.resolve(rootPath);
  const directories = new Map<string, Promise<IArchiveDirectoryIndex | null>>();
  const readIndex = async (directory: string): Promise<IArchiveDirectoryIndex | null> => {
    try {
      const names = await readdir(directory);
      const folded = new Map<string, string[]>();
      for (const name of names) {
        const key = name.toLowerCase();
        const matches = folded.get(key) ?? [];
        matches.push(name);
        folded.set(key, matches);
      }
      return { exact: new Set(names), folded };
    } catch (err) {
      if (getErrorCode(err) === "ENOENT") {
        return null;
      }
      throw err;
    }
  };

  return async (source) => {
    const requested = path.join(root, source);
    const relative = path.relative(root, requested);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ProcessCanceled(`Installer source is outside the archive: "${source}"`);
    }
    if (process.platform !== "linux") {
      return requested;
    }

    const segments = relative.split(path.sep);
    let current = root;
    for (let idx = 0; idx < segments.length; idx++) {
      let pending = directories.get(current);
      if (pending === undefined) {
        pending = readIndex(current);
        directories.set(current, pending);
      }
      const index = await pending;
      const segment = segments[idx];
      if (index?.exact.has(segment)) {
        current = path.join(current, segment);
        continue;
      }
      const matches = index?.folded.get(segment.toLowerCase()) ?? [];
      if (matches.length > 1) {
        throw new ProcessCanceled(
          `Installer source has ambiguous filename casing: "${source}" (${matches.join(", ")})`,
        );
      }
      if (matches.length === 0) {
        // Keep the existing missing-file report in InstallManager.
        return path.join(current, ...segments.slice(idx));
      }
      current = path.join(current, matches[0]);
    }
    return current;
  };
}
