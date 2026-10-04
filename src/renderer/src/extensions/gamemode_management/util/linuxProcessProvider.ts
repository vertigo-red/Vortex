import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

import { getErrorCode } from "@vortex/shared";

import type { IProcessInfo, IProcessProvider } from "./processProvider";

const WINE_LOADER = /^wine(?:64)?(?:-preloader)?$/;
const PYTHON = /^python(?:\d+(?:\.\d+)*)?t?$/;
const SHELL = /^(?:ba|da|z|k)?sh$/;

function splitArguments(value: string): string[] {
  const args = value.split("\0");
  // Remove padding left when Wine shifts argv, while retaining interior empty arguments.
  while (args.at(-1) === "") args.pop();
  return args;
}

function parseStat(value: string, pid: number) {
  // comm can contain spaces, newlines and parentheses; fields begin after its last ')'.
  const open = value.indexOf("(");
  const close = value.lastIndexOf(")");
  const fields = value
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  if (
    Number(value.slice(0, open).trim()) !== pid ||
    open < 0 ||
    close < open ||
    !/^\d+$/.test(fields[1] ?? "") ||
    !/^\d+$/.test(fields[19] ?? "") ||
    fields[0] === "Z" ||
    fields[0] === "X"
  )
    return undefined;
  return { name: value.slice(open + 1, close), ppid: Number(fields[1]), startTime: fields[19] };
}

function scriptArgument(args: string[], runtime: string): string | undefined {
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") return args[index + 1];
    if (!arg.startsWith("-")) return arg;
    if (PYTHON.test(runtime)) {
      if (arg === "-W" || arg === "-X" || arg === "--check-hash-based-pycs") {
        index++;
      } else if (!/^-[bBdEIOPqsSuvx]+$/.test(arg) && !/^-[WX].+/.test(arg)) {
        // -c, -m, stdin and unknown options must not turn a later data argument into a script.
        return undefined;
      }
    } else if (!/^-[aefnuvx]+$/.test(arg)) {
      return undefined;
    }
  }
  return undefined;
}

function jarArgument(args: string[]): string | undefined {
  const withValue = new Set([
    "-cp",
    "-classpath",
    "--class-path",
    "-p",
    "--module-path",
    "--upgrade-module-path",
    "--add-modules",
    "--limit-modules",
    "--add-exports",
    "--add-opens",
    "--add-reads",
    "--patch-module",
    "--enable-native-access",
  ]);
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-jar") return args[index + 1];
    if (
      !arg.startsWith("-") ||
      [
        "-m",
        "--module",
        "-version",
        "--version",
        "-help",
        "--help",
        "-h",
        "-?",
        "--list-modules",
        "--describe-module",
        "-d",
      ].includes(arg)
    )
      return undefined;
    if (withValue.has(arg)) index++;
  }
  return undefined;
}

async function unixPath(value: string | undefined, cwd?: string): Promise<string | undefined> {
  if (!value || (!path.isAbsolute(value) && cwd === undefined)) return undefined;
  try {
    return await realpath(path.isAbsolute(value) ? value : path.resolve(cwd, value));
  } catch {
    return undefined;
  }
}

async function processLink(filename: string): Promise<string | undefined> {
  try {
    return await readlink(filename, "utf8");
  } catch {
    return undefined;
  }
}

async function nativeExecutable(directory: string): Promise<string | undefined> {
  const filename = path.join(directory, "exe");
  const executable = await processLink(filename);
  const suffix = " (deleted)";
  if (executable?.endsWith(suffix)) {
    try {
      // procfs still refers to the running inode after unlink. A literal suffix in a
      // linked filename must remain intact, and a replacement file must not hide the process.
      const running = await stat(filename, { bigint: true });
      if (running.nlink === 0n) return executable.slice(0, -suffix.length);
      try {
        const literal = await stat(executable, { bigint: true });
        if (literal.dev !== running.dev || literal.ino !== running.ino) {
          return executable.slice(0, -suffix.length);
        }
      } catch (err) {
        // Another hardlink can keep nlink positive after the original entry is removed.
        if (getErrorCode(err) === "ENOENT") return executable.slice(0, -suffix.length);
      }
    } catch {
      /* Keep the readable link if inode metadata is unavailable. */
    }
  }
  return executable;
}

async function windowsPath(root: string, segments: string[]): Promise<string | undefined> {
  try {
    let current = await realpath(root);
    for (const segment of segments) {
      if (segment === ".") continue;
      if (segment === "..") {
        current = path.dirname(current);
        continue;
      }
      const names = await readdir(current);
      const matches = names.includes(segment)
        ? [segment]
        : names.filter((name) => name.toLowerCase() === segment.toLowerCase());
      if (matches.length !== 1) return undefined;
      current = path.join(current, matches[0]);
    }
    return await realpath(current);
  } catch {
    return undefined;
  }
}

async function winePath(
  command: string | undefined,
  cwd: string | undefined,
  directory: string,
): Promise<string | undefined> {
  if (!command) return undefined;
  const value = command.replace(/^\\\\\?\\/, "");
  if (/^[a-z]:[\\/]/i.test(value)) {
    const environment = splitArguments(
      await readFile(path.join(directory, "environ"), "utf8").catch(() => ""),
    );
    const readVariable = (key: string) =>
      environment.find((item) => item.startsWith(`${key}=`))?.slice(key.length + 1);
    const compatData = readVariable("STEAM_COMPAT_DATA_PATH");
    const prefix =
      readVariable("WINEPREFIX") || (compatData ? path.join(compatData, "pfx") : undefined);
    if (!prefix || !path.isAbsolute(prefix)) return undefined;
    // Drive letters are per-prefix symlinks; Z: is not necessarily the host root.
    const drive = path.join(prefix, "dosdevices", `${value[0].toLowerCase()}:`);
    const relative = path.win32.normalize(value).slice(3);
    return windowsPath(drive, relative.split(/[\\/]/).filter(Boolean));
  }
  if (path.isAbsolute(value)) return unixPath(value);
  if (cwd === undefined || value.startsWith("\\") || /^[a-z]:/i.test(value)) return undefined;
  return windowsPath(cwd, value.replace(/\\/g, "/").split("/").filter(Boolean));
}

async function launchPath(
  nativePath: string | undefined,
  args: string[],
  cwd: string | undefined,
  directory: string,
): Promise<string | undefined> {
  if (nativePath === undefined) return undefined;
  const runtime = path.basename(nativePath);
  if (WINE_LOADER.test(runtime)) {
    // Wine removes its loader argv[0] after startup. Support either stage, never arbitrary arguments.
    // See Wine 10.0 dlls/ntdll/unix/env.c, rebuild_argv().
    const command = WINE_LOADER.test(path.basename(args[0] ?? "")) ? args[1] : args[0];
    return (await winePath(command, cwd, directory)) ?? nativePath;
  }
  if (PYTHON.test(runtime) || SHELL.test(runtime)) {
    return (await unixPath(scriptArgument(args, runtime), cwd)) ?? nativePath;
  }
  if (runtime === "java") return (await unixPath(jarArgument(args), cwd)) ?? nativePath;
  return nativePath;
}

/** Linux identities come from procfs, preserving argv boundaries and full executable names. */
export class LinuxProcessProvider implements IProcessProvider {
  constructor(private readonly procRoot: string = "/proc") {}

  public async list(): Promise<IProcessInfo[]> {
    const pids = (await readdir(this.procRoot)).filter((name) => /^\d+$/.test(name)).map(Number);
    const result: IProcessInfo[] = [];
    // Bound filesystem work during every 2–5 second poll, even on hosts with many processes.
    for (let offset = 0; offset < pids.length; offset += 16) {
      const batch = await Promise.all(
        pids.slice(offset, offset + 16).map((pid) => this.readProcess(pid)),
      );
      result.push(...batch.filter((proc): proc is IProcessInfo => proc !== undefined));
    }
    return result;
  }

  private async readProcess(pid: number): Promise<IProcessInfo | undefined> {
    const directory = path.join(this.procRoot, String(pid));
    try {
      const first = parseStat(await readFile(path.join(directory, "stat"), "utf8"), pid);
      if (first === undefined) return undefined;
      const [commandLine, nativePath, cwd] = await Promise.all([
        readFile(path.join(directory, "cmdline"), "utf8").catch(() => ""),
        nativeExecutable(directory),
        processLink(path.join(directory, "cwd")),
      ]);
      const executable = await launchPath(nativePath, splitArguments(commandLine), cwd, directory);
      const last = parseStat(await readFile(path.join(directory, "stat"), "utf8"), pid);
      if (last === undefined || first.startTime !== last.startTime) return undefined;
      return { pid, ppid: last.ppid, name: last.name, path: executable };
    } catch {
      // Processes can exit or become inaccessible while the snapshot is being read.
      return undefined;
    }
  }
}
