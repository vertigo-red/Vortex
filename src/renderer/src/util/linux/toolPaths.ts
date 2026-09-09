import * as path from "node:path";

import * as fsExtra from "fs-extra";

import type { ITool } from "../../types/ITool";
import { resolveWindowsPath } from "./caseInsensitivePaths";
import { isWindowsExecutable } from "./proton";

/**
 * Vortex runs natively on Linux but many managed games still use Windows path semantics
 * inside a Wine/Proton prefix or install root. We use the declared executable as the
 * compatibility discriminator so native Linux games remain case-sensitive.
 */
export function usesWindowsPathSemantics(tool: ITool, root?: string): boolean {
  return process.platform === "linux" && isWindowsExecutable(tool.executable(root));
}

/** Resolve a tool-relative path using the filesystem semantics appropriate for that tool. */
export async function resolveToolPath(tool: ITool, root: string, relativePath: string): Promise<string> {
  if (usesWindowsPathSemantics(tool, root)) {
    // resolveWindowsPath creates a fresh resolver for each independent filesystem operation,
    // avoiding stale directory-entry caches across discovery/revalidation cycles.
    return resolveWindowsPath(root, relativePath);
  }
  return path.join(root, relativePath);
}

/** Verify every required file exists. Missing files surface as ENOENT from stat(). */
export async function verifyToolRequiredFiles(tool: ITool, root: string): Promise<void> {
  await Promise.all((tool.requiredFiles || []).map(async (relativePath) => {
    const resolved = await resolveToolPath(tool, root, relativePath);
    await fsExtra.stat(resolved);
  }));
}

/** Return the executable relative path with the actual on-disk spelling where applicable. */
export async function resolveToolExecutable(tool: ITool, root: string): Promise<string> {
  const declared = tool.executable(root);
  const resolved = await resolveToolPath(tool, root, declared);
  return path.relative(root, resolved);
}
