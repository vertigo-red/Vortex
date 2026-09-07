import * as path from "node:path";

/** Archive names use Windows separators even when extraction runs on Linux. */
export function archiveOutputPath(root: string, archiveName: string): string {
  const name = archiveName.replace(/\\/g, "/");
  if (
    !name ||
    name.includes("\0") ||
    path.posix.isAbsolute(name) ||
    path.win32.isAbsolute(name) ||
    /^[a-z]:/i.test(name) ||
    name.split("/").includes("..")
  ) {
    throw new Error(`Invalid archive path: "${archiveName}"`);
  }
  return path.join(root, ...name.split("/"));
}
