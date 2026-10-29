import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

import { parse } from "@nexusmods/steam-kv-parser";

export type GameUserPath = "documents" | "appData" | "localAppData" | "home" | "desktop";

export interface IGamePrefixEntry {
  gamePath: string;
  compatDataPath?: string;
}

export interface IGameUserPathOptions {
  gamePath?: string;
  store?: string;
  environment?: Record<string, string>;
  steamEntries?: readonly IGamePrefixEntry[];
  defaultWinePrefix?: string;
}

type Registry = Map<string, Map<string, string>>;
const registryCache = new Map<string, { stamp: string; registry: Registry }>();

export function isGameUserPath(id: string): id is GameUserPath {
  return ["documents", "appData", "localAppData", "home", "desktop"].includes(id);
}

function canonical(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

function directory(input: string): boolean {
  try {
    return statSync(input).isDirectory();
  } catch {
    return false;
  }
}

function steamPrefix(gamePath: string, entries: readonly IGamePrefixEntry[]): string | undefined {
  const installed = canonical(gamePath);
  const entry = entries
    .map((candidate) => ({ candidate, root: canonical(candidate.gamePath) }))
    .filter(({ root }) => installed === root || installed.startsWith(root + path.sep))
    .sort((left, right) => right.root.length - left.root.length)[0]?.candidate;
  if (entry?.compatDataPath) return path.join(entry.compatDataPath, "pfx");

  // A manually located install can be used before the store's first scan.
  // Match its real manifest instead of assuming a game's first/standard appid.
  for (let parent = gamePath; path.dirname(parent) !== parent; parent = path.dirname(parent)) {
    if (path.basename(parent).toLowerCase() !== "steamapps") continue;
    let manifests: string[];
    try {
      manifests = readdirSync(parent).filter((file) => /^appmanifest_\d+\.acf$/.test(file));
    } catch {
      continue;
    }
    for (const name of manifests) {
      try {
        const manifest = parse(readFileSync(path.join(parent, name), "utf8"));
        if (manifest.key !== "AppState") continue;
        const leaf = (key: string) => {
          const node = manifest.children.find(
            (child) => child.type === "leaf" && child.key === key,
          );
          return node?.type === "leaf" ? node.value : undefined;
        };
        const appid = leaf("appid");
        const installdir = leaf("installdir");
        if (!appid || !/^\d+$/.test(appid) || !installdir) continue;
        const root = canonical(path.join(parent, "common", installdir));
        if (installed === root || installed.startsWith(root + path.sep)) {
          return path.join(parent, "compatdata", appid, "pfx");
        }
      } catch {
        // One corrupt manifest must not hide other valid installations.
      }
    }
  }
  return undefined;
}

/** Locate this install's prefix, with per-game overrides taking precedence. */
export function findGamePrefix(options: IGameUserPathOptions): string | undefined {
  const environment = options.environment ?? {};
  if (environment.WINEPREFIX) return path.resolve(environment.WINEPREFIX);
  if (environment.STEAM_COMPAT_DATA_PATH)
    return path.resolve(environment.STEAM_COMPAT_DATA_PATH, "pfx");
  if (options.gamePath) {
    for (
      let parent = path.resolve(options.gamePath);
      path.dirname(parent) !== parent;
      parent = path.dirname(parent)
    ) {
      if (path.basename(parent).toLowerCase() === "drive_c") return path.dirname(parent);
    }
    const fromSteam =
      options.store === undefined || options.store === "steam"
        ? steamPrefix(options.gamePath, options.steamEntries ?? [])
        : undefined;
    if (fromSteam) return fromSteam;
  }
  return options.defaultWinePrefix ? path.resolve(options.defaultWinePrefix) : undefined;
}

const unescape = (value: string) => value.replace(/\\([\\"])/g, "$1");

function readRegistry(prefix: string): Registry {
  const file = path.join(prefix, "user.reg");
  try {
    const stat = statSync(file);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const cached = registryCache.get(file);
    if (cached?.stamp === stamp) return cached.registry;
    const registry: Registry = new Map();
    let section: Map<string, string> | undefined;
    const wanted = new Set([
      "volatile environment",
      (explorer + "User Shell Folders").toLowerCase(),
      (explorer + "Shell Folders").toLowerCase(),
    ]);
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const heading = /^\[(.*)\]/.exec(line);
      if (heading) {
        const name = unescape(heading[1]).toLowerCase();
        section = wanted.has(name) ? new Map() : undefined;
        if (section) registry.set(name, section);
      } else if (section) {
        const entry = /^"((?:\\.|[^"\\])*)"=(?:str\(2\):)?"((?:\\.|[^"\\])*)"\s*$/.exec(line);
        if (entry) section.set(unescape(entry[1]).toLowerCase(), unescape(entry[2]));
      }
    }
    registryCache.set(file, { stamp, registry });
    return registry;
  } catch {
    return new Map();
  }
}

function registryValue(registry: Registry, section: string, name: string): string | undefined {
  return registry.get(section.toLowerCase())?.get(name.toLowerCase());
}

const explorer = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\";
function shellFolder(registry: Registry, name: string): string | undefined {
  return (
    registryValue(registry, explorer + "User Shell Folders", name) ??
    registryValue(registry, explorer + "Shell Folders", name)
  );
}

/** Wine is case-insensitive; native Node file access on Linux is not. */
function caseCorrect(input: string): string {
  const { root } = path.parse(input);
  let current = root;
  for (const part of input.slice(root.length).split(path.sep).filter(Boolean)) {
    const exact = path.join(current, part);
    if (existsSync(exact)) {
      current = exact;
      continue;
    }
    try {
      const actual = readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase());
      current = path.join(current, actual ?? part);
    } catch {
      current = exact;
    }
  }
  return current;
}

function windowsPath(prefix: string, input: string): string | undefined {
  const match = /^([a-z]):[\\/](.*)$/i.exec(path.win32.normalize(input));
  if (!match) return undefined;
  const drive = match[1].toLowerCase();
  const root =
    drive === "c" ? path.join(prefix, "drive_c") : path.join(prefix, "dosdevices", drive + ":");
  return caseCorrect(path.join(root, ...match[2].split(/[\\/]+/)));
}

function userProfile(prefix: string, registry: Registry): string | undefined {
  const configured = registryValue(registry, "Volatile Environment", "USERPROFILE");
  if (configured && windowsPath(prefix, configured)) return configured;
  const personal = shellFolder(registry, "Personal");
  const profile = personal && /^([a-z]:\\users\\[^\\]+)/i.exec(personal)?.[1];
  if (profile) return profile;
  const users = path.join(prefix, "drive_c", "users");
  try {
    const names = readdirSync(users).filter(
      (name) =>
        !/^(public|default|default user|all users)$/i.test(name) &&
        directory(path.join(users, name)),
    );
    const steamUser = names.find((name) => name.toLowerCase() === "steamuser");
    const user = steamUser ?? (names.length === 1 ? names[0] : undefined);
    return user ? `C:\\users\\${user}` : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve Wine's configured known folders without changing Vortex's own paths. */
export function resolveGameUserPath(
  id: GameUserPath,
  options: IGameUserPathOptions,
): string | undefined {
  const prefix = findGamePrefix(options);
  if (!prefix || !directory(path.join(prefix, "drive_c"))) return undefined;
  const registry = readRegistry(prefix);
  const profile = userProfile(prefix, registry);
  if (!profile) return undefined;
  const variables: Record<string, string> = {
    userprofile: profile,
    homedrive: profile.slice(0, 2),
    homepath: profile.slice(2),
    username: path.win32.basename(profile),
    appdata: path.win32.join(profile, "AppData", "Roaming"),
    localappdata: path.win32.join(profile, "AppData", "Local"),
  };
  const expand = (value: string) =>
    value.replace(/%([^%]+)%/g, (match, name: string) => variables[name.toLowerCase()] ?? match);
  const defaults: Record<GameUserPath, string> = {
    home: profile,
    documents: path.win32.join(profile, "Documents"),
    appData: variables.appdata,
    localAppData: variables.localappdata,
    desktop: path.win32.join(profile, "Desktop"),
  };
  const keys: Partial<Record<GameUserPath, string>> = {
    documents: "Personal",
    appData: "AppData",
    localAppData: "Local AppData",
    desktop: "Desktop",
  };
  const configured = keys[id] && shellFolder(registry, keys[id]);
  const expanded = expand(configured || defaults[id]);
  return windowsPath(prefix, expanded.includes("%") ? defaults[id] : expanded);
}
