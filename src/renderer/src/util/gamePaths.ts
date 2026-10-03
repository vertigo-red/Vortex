import * as path from "node:path";

/** Relative paths declared by game extensions can use Windows separators on Linux. */
export function normalizeGameRelativePath(relativePath: string): string {
  return process.platform === "linux" ? relativePath.replace(/\\/g, "/") : relativePath;
}

export function gameFilePath(directory: string, relativePath: string): string {
  return path.join(directory, normalizeGameRelativePath(relativePath));
}
