import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { selectors, types, util } from "@nexusmods/vortex-api";

import type { IListEntry, IQBMSOpProps, IQBMSOptions } from "./types";
import { QuickBMSError } from "./types";

const QUICK_BMS_ERRORMSG = [
  "success",
  "encountered an unknown error",
  "unable to allocate memory",
  "missing input file",
  "unable to write output file",
  "file compression error (Review BMS script)",
  "file encryption error (Review BMS script)",
  "external dll file has reported an error",
  "BMS script syntax error",
  "invalid quickbms arguments provided",
  "error accessing input/output folder",
  "user/external application has terminated QuickBMS",
  "extra IO error",
  "failed to update QuickBMS",
];

function wildcardExpression(pattern: string, caseSensitive: boolean): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  const expression = normalized
    .split(/(\{\}|\*|\?)/)
    .map((part) =>
      part === "{}" || part === "*"
        ? ".*"
        : part === "?"
          ? "."
          : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${expression}$`, caseSensitive ? "" : "i");
}

/** Keep filenames with spaces and use stateless, literal wildcard matching. */
export function parseQBMSList(
  input: string,
  wildCards?: string[],
  caseSensitive = false,
): IListEntry[] {
  const filters = wildCards?.map((pattern) => wildcardExpression(pattern, caseSensitive));
  return input.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*([0-9a-fA-F]+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const [, offset, size, name] = match;
    const filePath = name.replace(/\\/g, "/");
    return !filters || filters.some((filter) => filter.test(filePath))
      ? [{ offset, size, filePath }]
      : [];
  });
}

function validateArguments(props: IQBMSOpProps): void {
  if (
    !path.isAbsolute(props.bmsScriptPath) ||
    path.extname(props.bmsScriptPath).toLowerCase() !== ".bms"
  ) {
    throw new util.ArgumentInvalid("bmsScriptPath");
  }
  if (!path.isAbsolute(props.archivePath)) throw new util.ArgumentInvalid("archivePath");
  if (!props.operationPath || !path.isAbsolute(props.operationPath))
    throw new util.ArgumentInvalid("operationPath");
}

async function run(
  api: types.IExtensionApi,
  props: IQBMSOpProps,
  command?: string,
): Promise<string> {
  validateArguments(props);
  const options: IQBMSOptions = props.qbmsOptions ?? {};
  const parent = path.join(util.getVortexPath("userData"), "temp", "archive-tools");
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(path.join(parent, "qbms-"));
  try {
    const args: Array<string | { path: string }> = [];
    if (command) args.push("-" + command);
    if (command === "w" && options.allowResize !== undefined) {
      args.push("-r");
      if (options.allowResize) args.push("-r");
    }
    if (options.quiet) args.push("-q");
    if (options.verbose) args.push("-v");
    if (options.overwrite) args.push("-o");
    if (options.caseSensitive) args.push("-I");
    if (options.keepTemporaryFiles) args.push("-T");
    if (options.wildCards) {
      const filterFile = path.join(workspace, "filters.txt");
      await writeFile(filterFile, options.wildCards.join("\n"), "utf8");
      args.push("-f", { path: filterFile });
    }
    args.push(
      { path: props.bmsScriptPath },
      { path: props.archivePath },
      { path: props.operationPath },
    );
    const tool = path.join(__dirname, "quickbms_4gb_files.exe");
    const launch =
      process.platform === "linux"
        ? await util.getProtonToolCommand(
            path.join(__dirname, "vortex-archive-launcher.exe"),
            [{ path: tool }, ...args],
            props.gameMode
              ? selectors.discoveryByGame(api.store.getState(), props.gameMode)
              : undefined,
          )
        : {
            executable: tool,
            args: args.map((arg) => (typeof arg === "string" ? arg : arg.path)),
            env: {},
          };
    try {
      const result = await util.executeToolProcess(launch.executable, launch.args, {
        // Keep the existing tool-relative DLL lookup behaviour for CALLDLL scripts.
        cwd: __dirname,
        env: { ...process.env, ...launch.env },
        timeoutMs: 30 * 60 * 1000,
        idleTimeoutMs: 15000,
        keepAliveMs: 5000,
      });
      if (/\bError:/i.test(result.stderr))
        throw Object.assign(new Error("QuickBMS reported an error"), result);
      if (options.createLog) {
        await writeFile(
          path.join(util.getVortexPath("userData"), "quickbms.log"),
          result.stdout + "\n" + result.stderr,
          "utf8",
        );
      }
      return result.stdout;
    } catch (err) {
      const description =
        err.code === "ETIMEDOUT"
          ? "QBMS has timed out"
          : typeof err.code === "number"
            ? (QUICK_BMS_ERRORMSG[err.code] ?? QUICK_BMS_ERRORMSG[1])
            : err.message;
      throw new QuickBMSError(
        `quickbms(${err.code ?? "error"}) - ${description}`,
        `${err.stderr ?? ""}\n${err.stdout ?? ""}`.split(/\r?\n/),
      );
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function reImport(api: types.IExtensionApi, props: IQBMSOpProps): Promise<void> {
  if (props.qbmsOptions?.allowResize === undefined)
    throw new util.ArgumentInvalid("Re-import version was not specified");
  await run(api, props, "w");
}

export async function extract(api: types.IExtensionApi, props: IQBMSOpProps): Promise<void> {
  await run(api, props);
}

export async function list(api: types.IExtensionApi, props: IQBMSOpProps): Promise<IListEntry[]> {
  const output = await run(api, props, "l");
  return parseQBMSList(output, props.qbmsOptions?.wildCards, props.qbmsOptions?.caseSensitive);
}

export async function write(api: types.IExtensionApi, props: IQBMSOpProps): Promise<void> {
  await run(api, props, "w");
}
