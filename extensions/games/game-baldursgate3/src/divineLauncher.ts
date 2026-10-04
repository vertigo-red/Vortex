import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const pendingCopies = new Map<string, Promise<string>>();
const LAUNCHER_NAME = "vortex-divine-launcher.exe";

async function copyLauncher(target: string, source: string): Promise<string> {
  // Electron can read bundled ASAR assets; Wine needs a real file in staging.
  const bytes = await fs.readFile(source);
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (stat?.isFile() && stat.size === bytes.length && (await fs.readFile(target)).equals(bytes)) {
    return target;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return target;
}

export async function ensureDivineLauncher(
  toolsDirectory: string,
  source = path.join(__dirname, "tools", LAUNCHER_NAME),
): Promise<string> {
  const target = path.join(toolsDirectory, LAUNCHER_NAME);
  const pending = pendingCopies.get(target);
  if (pending !== undefined) return pending;
  const operation = copyLauncher(target, source);
  pendingCopies.set(target, operation);
  try {
    return await operation;
  } finally {
    pendingCopies.delete(target);
  }
}
