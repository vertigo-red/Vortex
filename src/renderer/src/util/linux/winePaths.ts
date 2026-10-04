import { readdirSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

function canonicalPath(input: string): string {
  let directory = input;
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(directory), ...suffix);
    } catch (err) {
      if (!["ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
      const parent = path.dirname(directory);
      if (directory === parent) throw err;
      suffix.unshift(path.basename(directory));
      directory = parent;
    }
  }
}

/** Convert a host path through the selected prefix's actual DOS drive mappings. */
export function toWinePath(prefix: string, input: string): string {
  if (!path.isAbsolute(input)) throw new Error(`Expected an absolute Linux path: ${input}`);
  const target = canonicalPath(input);
  const devices = path.join(prefix, "dosdevices");
  const drives = readdirSync(devices)
    .filter((name) => /^[a-z]:$/.test(name))
    .flatMap((name) => {
      const drive = path.join(devices, name);
      if (!statSync(drive, { throwIfNoEntry: false })?.isDirectory()) return [];
      const root = realpathSync.native(drive);
      const relative = path.relative(root, target);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
        return [];
      }
      return [{ name, root, relative }];
    })
    .sort(
      (left, right) => right.root.length - left.root.length || left.name.localeCompare(right.name),
    );
  const selected = drives[0];
  if (selected === undefined) throw new Error(`No Wine drive maps the Linux path: ${input}`);
  const invalidComponent = selected.relative
    .split(path.sep)
    .some(
      (segment) =>
        /[ .]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
    );
  const hasControl = Array.from(selected.relative).some(
    (character) => character.charCodeAt(0) < 32,
  );
  if (/[\\:*?"<>|]/.test(selected.relative) || hasControl || invalidComponent) {
    throw new Error(`The Linux path cannot be represented as a Windows filename: ${input}`);
  }
  return `${selected.name.toUpperCase()}\\${selected.relative.replaceAll(path.sep, "\\")}`;
}
