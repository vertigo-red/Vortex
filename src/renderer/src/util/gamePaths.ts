import { readdirSync } from "node:fs";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

import { ProcessCanceled } from "./CustomErrors";

/** Relative paths declared by game extensions can use Windows separators on Linux. */
export function normalizeGameRelativePath(relativePath: string): string {
  return process.platform === "linux" ? relativePath.replace(/\\/g, "/") : relativePath;
}

export function gameFilePath(directory: string, relativePath: string): string {
  return path.join(directory, normalizeGameRelativePath(relativePath));
}

/** Windows game/config directories may have different spelling on a case-sensitive disk. */
export function resolveWindowsGamePath(directory: string, relativePath: string): string {
  if (process.platform !== "linux") return path.join(directory, relativePath);
  if (path.isAbsolute(relativePath)) {
    const joined = path.join(directory, relativePath);
    const root = path.parse(joined).root;
    return resolveWindowsGamePath(root, joined.slice(root.length));
  }
  const segments = path.normalize(normalizeGameRelativePath(relativePath)).split(path.sep);
  let current = directory;
  for (let index = 0; index < segments.length; index++) {
    const requested = segments[index];
    let names: string[];
    try {
      names = readdirSync(current);
    } catch (err) {
      if (getErrorCode(err) === "ENOENT") return path.join(current, ...segments.slice(index));
      throw err;
    }
    const matches = names.includes(requested)
      ? [requested]
      : names.filter((name) => name.toLowerCase() === requested.toLowerCase());
    if (matches.length > 1) {
      throw new ProcessCanceled(`Ambiguous Windows game path "${path.join(current, requested)}".`);
    }
    if (matches.length === 0) return path.join(current, ...segments.slice(index));
    current = path.join(current, matches[0]);
  }
  return current;
}
