import * as fs from "node:fs/promises";
import * as path from "node:path";

export function archiveOutputPath(root: string, archiveName: string): string {
  const name = archiveName.replace(/\\/g, "/");
  if (!name || name.includes("\0") || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)
      || /^[a-z]:/i.test(name) || name.split("/").includes("..")) {
    throw new Error(`Invalid archive path: "${archiveName}"`);
  }
  return path.join(root, ...name.split("/"));
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export async function prepareArchiveOutputPath(root: string, archiveName: string): Promise<string> {
  const lexical = archiveOutputPath(root, archiveName);
  await fs.mkdir(root, { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  const relative = path.relative(path.resolve(root), path.resolve(lexical));
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error(`Invalid archive path: "${archiveName}"`);
  let current = canonicalRoot;
  for (const part of parts.slice(0, -1)) {
    const next = path.join(current, part);
    try {
      const stat = await fs.lstat(next);
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(next);
        if (!inside(canonicalRoot, target)) {
          throw new Error(`Archive path escapes extraction root through symlink: "${archiveName}"`);
        }
        if (!(await fs.stat(target)).isDirectory()) {
          throw new Error(`Archive parent is not a directory: "${archiveName}"`);
        }
        current = target;
      } else if (stat.isDirectory()) {
        current = await fs.realpath(next);
      } else {
        throw new Error(`Archive parent is not a directory: "${archiveName}"`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      await fs.mkdir(next);
      current = await fs.realpath(next);
    }
    if (!inside(canonicalRoot, current)) {
      throw new Error(`Archive path escapes extraction root: "${archiveName}"`);
    }
  }
  const output = path.join(current, parts[parts.length - 1]);
  try {
    if ((await fs.lstat(output)).isSymbolicLink()) {
      throw new Error(`Archive output is a symlink: "${archiveName}"`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return output;
}
