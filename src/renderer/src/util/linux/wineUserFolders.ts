import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

const USER_SHELL_FOLDERS =
  "software\\microsoft\\windows\\currentversion\\explorer\\user shell folders";
const ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

// Wine's Version 2 files escape UTF-16 code units, not JSON or JavaScript strings.
function decodeString(value: string): string {
  return value.replace(/\\(x[\da-fA-F]{1,4}|[0-7]{1,3}|.)/g, (_match, escape: string) => {
    if (escape.startsWith("x") && escape.length > 1) {
      return String.fromCharCode(parseInt(escape.slice(1), 16));
    }
    if (/^[0-7]+$/.test(escape)) return String.fromCharCode(parseInt(escape, 8));
    return ESCAPES[escape] ?? escape;
  });
}

function registryString(filename: string, name: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(filename, "utf8").replace(/^\uFEFF/, "");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return undefined;
    throw err;
  }
  if (
    !content.startsWith("WINE REGISTRY Version 2\n") &&
    !content.startsWith("WINE REGISTRY Version 2\r\n")
  ) {
    throw new Error(`Invalid Wine Registry file "${filename}"`);
  }
  let selected = false;
  for (const line of content.split(/\r?\n/)) {
    const section = /^\[((?:\\.|[^\]\\])*)\]/.exec(line);
    if (section) {
      selected = decodeString(section[1]).toLowerCase() === USER_SHELL_FOLDERS;
    } else if (selected) {
      const entry = /^"((?:\\.|[^"\\])*)"\s*=\s*(.*)$/.exec(line);
      if (!entry || decodeString(entry[1]).toLowerCase() !== name.toLowerCase()) continue;
      const text = /^(?:str(?:\(2\))?:)?"((?:\\.|[^"\\])*)"\s*$/.exec(entry[2]);
      if (text) return decodeString(text[1]);
      if (/^(?:dword:|hex:|hex\((?![12]\))[\da-f]+\):|str\(7\):)/.test(entry[2])) {
        return undefined;
      }
      throw new Error(`Invalid Wine folder value "${name}" in "${filename}"`);
    }
  }
  return undefined;
}

function expandFolder(value: string): string {
  // SHGetFolderPath expands a leading variable even for REG_SZ. Wine's standard
  // USERPROFILE/SystemDrive handling leaves any percent text in the suffix literal.
  if (!value.startsWith("%")) return value;
  const variable = /^%([^%]+)%/.exec(value)?.[1];
  const variables: Readonly<Record<string, string>> = {
    userprofile: "C:\\users\\steamuser",
    systemdrive: "C:",
  };
  const key = variable?.toLowerCase();
  if (key === undefined || !Object.hasOwn(variables, key)) {
    throw new Error(`Unsupported Wine folder environment variable "${variable}"`);
  }
  return variables[key] + value.slice(variable.length + 2);
}

function folderPath(prefix: string, value: string): string {
  if ([...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error("Invalid control character in Wine folder path");
  }
  const windows = value.replace(/^\\\\\?\\/, "");
  if (!/^[a-z]:[\\/]/i.test(windows)) {
    throw new Error(`Wine folder path must use an absolute drive path "${value}"`);
  }
  const drive = path.join(prefix, "dosdevices", `${windows[0].toLowerCase()}:`);
  let current = realpathSync.native(drive);
  const segments = path.win32.normalize(windows).slice(3).split(/[\\/]/).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const names = readdirSync(current);
    const matches = names.includes(segment)
      ? [segment]
      : names.filter((name) => name.toLowerCase() === segment.toLowerCase());
    if (matches.length > 1) throw new Error(`Ambiguous Wine folder component "${segment}"`);
    if (matches.length === 0) return path.join(current, ...segments.slice(index));
    current = path.join(current, matches[0]);
  }
  const info = statSync(current, { throwIfNoEntry: false });
  if (!info?.isDirectory())
    throw new Error(`Wine folder is not an accessible directory "${current}"`);
  return current;
}

/** Read persisted folder redirections without starting Wine or modifying its Registry. */
export function getWineUserFolder(
  prefix: string,
  id: "documents" | "localAppData",
): string | undefined {
  const name = id === "documents" ? "Personal" : "Local AppData";
  // Shell Folders is only Wine's expanded cache; User Shell Folders is authoritative.
  const entry =
    registryString(path.join(prefix, "user.reg"), name) ??
    registryString(path.join(prefix, "system.reg"), name);
  return entry === undefined ? undefined : folderPath(prefix, expandFolder(entry));
}
