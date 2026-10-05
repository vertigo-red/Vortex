import { readdirSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

/** Only a game's enclosing drive_c identifies a prefix; never search unrelated prefixes. */
export function findWineSettingsPrefix(gamePath: string): string | undefined {
  const candidates = [path.resolve(gamePath)];
  try {
    candidates.push(realpathSync.native(gamePath));
  } catch (err) {
    if (getErrorCode(err) !== "ENOENT") throw err;
  }
  for (const candidate of candidates) {
    let current = candidate;
    for (;;) {
      if (
        path.basename(current).toLowerCase() === "drive_c" &&
        statSync(path.join(path.dirname(current), "user.reg"), { throwIfNoEntry: false })?.isFile()
      ) {
        return path.dirname(current);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return undefined;
}

/** A custom prefix must have one unambiguous user profile, independent of the host username. */
export function wineSettingsUser(prefix: string): string {
  if (
    !path.isAbsolute(prefix) ||
    !statSync(path.join(prefix, "user.reg"), { throwIfNoEntry: false })?.isFile()
  ) {
    throw new Error("Select an initialized Wine prefix containing drive_c and user.reg.");
  }
  const users = path.join(prefix, "drive_c", "users");
  const shared = new Set(["public", "default", "default user", "all users"]);
  const profiles = readdirSync(users).filter(
    (name) =>
      !shared.has(name.toLowerCase()) &&
      statSync(path.join(users, name), { throwIfNoEntry: false })?.isDirectory(),
  );
  if (profiles.length !== 1) {
    throw new Error("The selected Wine prefix must contain exactly one game user profile.");
  }
  return profiles[0];
}
