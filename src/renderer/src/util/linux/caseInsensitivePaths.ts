import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Resolve Windows mod paths without renaming the game or the staging directory. */
export class CaseInsensitivePathResolver {
  private directories = new Map<string, Promise<Map<string, string[]>>>();
  constructor(private root: string) {}

  public async resolve(relativePath: string): Promise<string> {
    const normalized = relativePath.replace(/\\/g, "/");
    if (
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`Path escapes the game directory: "${relativePath}"`);
    }
    const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
    const resolved: string[] = [];
    for (const part of parts) {
      const parent = path.join(this.root, ...resolved);
      let pending = this.directories.get(parent);
      if (pending === undefined) {
        pending = this.readDirectory(parent);
        this.directories.set(parent, pending);
      }
      const entries = await pending;
      const key = part.toLowerCase();
      let candidates = entries.get(key);
      // Reserve new names before any await so concurrent files share one spelling.
      if (candidates === undefined) {
        candidates = [part];
        entries.set(key, candidates);
      } else if (candidates.length > 1) {
        throw new Error(
          `Ambiguous Windows file names in "${parent}": ${candidates.map((name) => `"${name}"`).join(", ")}`,
        );
      }
      resolved.push(candidates[0]);
    }
    return path.join(...resolved);
  }

  private async readDirectory(directory: string): Promise<Map<string, string[]>> {
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw err;
    }
    const entries = new Map<string, string[]>();
    for (const name of names) {
      const key = name.toLowerCase();
      const candidates = entries.get(key);
      if (candidates === undefined) {
        entries.set(key, [name]);
      } else {
        candidates.push(name);
      }
    }
    return entries;
  }
}

/** For locating existing executables; missing paths fail in the caller's stat. */
export async function resolveWindowsPath(root: string, relativePath: string): Promise<string> {
  return path.join(root, await new CaseInsensitivePathResolver(root).resolve(relativePath));
}
