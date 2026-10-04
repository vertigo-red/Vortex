import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const pendingCopies = new Map<string, Promise<string>>();
const LAUNCHER_NAME = "vortex-divine-launcher.exe";
const OUTPUT_HOOK_NAME = "vortex-divine-utf8.dll";

async function copyAsset(target: string, bytes: Buffer): Promise<string> {
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

async function stageLauncher(target: string, source: string): Promise<string> {
  // Electron can read bundled ASAR assets; Wine needs real files in staging.
  // Read both assets before changing staging so a missing bundle fails cleanly.
  const [launcher, hook] = await Promise.all([
    fs.readFile(source),
    fs.readFile(path.join(path.dirname(source), OUTPUT_HOOK_NAME)),
  ]);
  await Promise.all([
    copyAsset(target, launcher),
    copyAsset(path.join(path.dirname(target), OUTPUT_HOOK_NAME), hook),
  ]);
  return target;
}

export async function ensureDivineLauncher(
  toolsDirectory: string,
  source = path.join(__dirname, "tools", LAUNCHER_NAME),
): Promise<string> {
  const target = path.join(toolsDirectory, LAUNCHER_NAME);
  const pending = pendingCopies.get(target);
  if (pending !== undefined) return pending;
  const operation = stageLauncher(target, source);
  pendingCopies.set(target, operation);
  try {
    return await operation;
  } finally {
    pendingCopies.delete(target);
  }
}
