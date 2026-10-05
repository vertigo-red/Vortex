import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import * as path from "node:path";

import { fs, log, selectors, types, util } from "@nexusmods/vortex-api";
import PromiseBB from "bluebird";

import type { ArcGame } from "./types";

export interface IARCOptions {
  compression?: boolean;
  forceCompression?: boolean;
  game?: ArcGame;
  version?: number;
}

/** ARCtool writes Windows paths and does not terminate the final record with another Path key. */
export function parseARCList(input: string): string[] {
  const files: string[] = [];
  let file: string | undefined;
  let extension = "";
  const finish = () => {
    if (file) {
      const name = file + (extension ? "." + extension.replace(/^\./, "") : "");
      files.push(process.platform === "linux" ? name.replace(/\\/g, "/") : name);
    }
  };
  for (const line of input.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "Path") {
      finish();
      file = value;
      extension = "";
    } else if (key === "correctExt") extension = value;
  }
  finish();
  return files;
}

class ARCWrapper {
  private mApi: types.IExtensionApi;
  private mGameId?: string;

  constructor(api: types.IExtensionApi, gameId?: string) {
    this.mApi = api;
    this.mGameId = gameId;
  }

  public list(archivePath: string, options: IARCOptions = {}): PromiseBB<string[]> {
    return PromiseBB.resolve(
      this.withWorkspace(async (workspace) => {
        const input = path.join(workspace, "source.arc");
        await copyFile(archivePath, input);
        await this.run("l", [{ path: input }], options, workspace);
        return parseARCList(await readFile(input + ".verbose.txt", "utf8"));
      }),
    );
  }

  public extract(
    archivePath: string,
    outputPath: string,
    options: IARCOptions = {},
  ): PromiseBB<void> {
    return PromiseBB.resolve(
      this.withWorkspace(async (workspace) => {
        const input = path.join(workspace, "source.arc");
        await copyFile(archivePath, input);
        await this.run("x", ["-txt", { path: input }], options, workspace);
        const extracted = path.join(workspace, "source");
        // Missing output is a failure even when ARCtool exits with status zero.
        if (!(await stat(extracted)).isDirectory())
          throw new Error("ARCtool did not extract the archive");
        await stat(input + ".txt");
        await fs.moveAsync(extracted, outputPath, { overwrite: true });
        await fs.moveAsync(input + ".txt", outputPath + ".arc.txt", { overwrite: true });
      }),
    );
  }

  public create(archivePath: string, source: string, options: IARCOptions = {}): PromiseBB<void> {
    return PromiseBB.resolve(
      this.withWorkspace(async (workspace) => {
        const input = path.join(workspace, "source");
        await cp(source, input, { recursive: true });
        const args: Array<string | { path: string }> = [];
        try {
          await copyFile(source + ".arc.txt", input + ".arc.txt");
          args.push("-txt");
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
          log("warn", "file order file missing", { source });
        }
        await this.run("c", [...args, { path: input }], options, workspace);
        const generated = input + ".arc";
        const file = await open(generated, "r");
        try {
          const header = Buffer.alloc(8);
          const { bytesRead } = await file.read(header, 0, 8, 0);
          if (bytesRead < 8 || header.toString("ascii", 0, 4) !== "ARC\0") {
            throw new Error("ARCtool did not create a valid archive");
          }
        } finally {
          await file.close();
        }
        // Rename a sibling only after the complete new archive is available. Preserve the old file on failure.
        const replacement = path.join(path.dirname(archivePath), `.vortex-arc-${randomUUID()}.tmp`);
        try {
          await copyFile(generated, replacement);
          await rename(replacement, archivePath);
        } finally {
          await rm(replacement, { force: true });
        }
      }),
    );
  }

  private async withWorkspace<T>(
    operation: (workspace: string) => globalThis.Promise<T>,
  ): globalThis.Promise<T> {
    // The legacy ARC executable uses narrow paths. Linux's system temp directory avoids
    // embedding a non-ASCII home/user-data name in its copied input arguments.
    const parent = path.join(util.getVortexPath("temp"), "vortex-archive-tools");
    await mkdir(parent, { recursive: true });
    const workspace = await mkdtemp(path.join(parent, "arc-"));
    try {
      return await operation(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  private async run(
    command: string,
    parameters: Array<string | { path: string }>,
    options: IARCOptions,
    cwd: string,
  ): globalThis.Promise<void> {
    const args: Array<string | { path: string }> = [
      "-" + command,
      "-" + (options.game ?? "DD"),
      "-pc",
      "-texRE6",
      "-alwayscomp",
      "-v",
      (options.version ?? 7).toFixed(),
      ...parameters,
    ];
    const tool = path.join(__dirname, "ARCtool.exe");
    const launch =
      process.platform === "linux"
        ? await util.getProtonToolCommand(
            path.join(__dirname, "vortex-archive-launcher.exe"),
            [{ path: tool }, ...args],
            this.mGameId
              ? selectors.discoveryByGame(this.mApi.store.getState(), this.mGameId)
              : undefined,
          )
        : {
            executable: tool,
            args: args.map((arg) => (typeof arg === "string" ? arg : arg.path)),
            env: {},
          };
    const result = await util.executeToolProcess(launch.executable, launch.args, {
      cwd,
      env: { ...process.env, ...launch.env },
    });
    // ARCtool reports many failures on stdout with status zero. Proton's stderr also contains benign logs.
    const errors = (result.stdout + "\n" + result.stderr)
      .split(/\r?\n/)
      .filter((line) => /^\s*Error\b/i.test(line) || line.startsWith("Vortex archive launcher:"));
    if (errors.length) throw new Error(errors.join("\n"));
  }
}

export default ARCWrapper;
