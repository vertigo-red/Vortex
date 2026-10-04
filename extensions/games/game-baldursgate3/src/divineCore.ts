import * as fs from "fs/promises";
import * as path from "node:path";

import { executeDivine } from "./divineProcess";
import type { DivineAction, IDivineOptions, IDivineOutput } from "./types";

export const DEFAULT_TIMEOUT_MS = 10000;

export class DivineExecMissing extends Error {
  constructor(message = "Divine executable is missing") {
    super(message);
    this.name = "DivineExecMissing";
  }
}

export class DivineMissingDotNet extends Error {
  constructor() {
    super("LSLib requires the Windows .NET 8 runtime in its execution environment.");
    this.name = "DivineMissingDotNet";
  }
}

export class DivineUnsupportedToolPath extends Error {
  constructor() {
    super(
      "The Windows .NET runtime cannot load Divine from a tools directory containing ';'. " +
        "Choose a BG3 staging folder without a semicolon.",
    );
    this.name = "DivineUnsupportedToolPath";
  }
}

export class DivineLaunchFailed extends Error {
  constructor(details: string) {
    super(`Divine could not start in its Proton environment: ${details.trim()}`);
    this.name = "DivineLaunchFailed";
  }
}

export class DivineTimedOut extends Error {
  constructor() {
    super("Divine process timed out");
    this.name = "DivineTimedOut";
  }
}

export class DivineAborted extends Error {
  constructor() {
    super("Divine operation was aborted");
    this.name = "DivineAborted";
  }
}

export class DivinePakInvalid extends Error {
  public readonly details: string;
  constructor(details: string) {
    super(`divine.exe reported pak is invalid: ${details}`);
    this.name = "DivinePakInvalid";
    this.details = details;
  }
}

export interface IExecErrorShape {
  code?: number | string;
  signal?: string;
  message?: string;
  stderr?: string;
  stdout?: string;
}

export interface IDivineRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  command?: { executable: string; args: string[]; env: Record<string, string> };
}

export async function resolveDivineExecutable(toolsDirectory: string): Promise<string> {
  let names: string[];
  try {
    names = await fs.readdir(toolsDirectory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new DivineExecMissing();
    throw err;
  }
  const matches = names.filter((name) => name.toLowerCase() === "divine.exe");
  if (matches.length !== 1) {
    throw new DivineExecMissing(
      "Install one unambiguous copy of Divine.exe in the LSLib tools directory.",
    );
  }
  return path.join(toolsDirectory, matches[0]);
}

export function buildDivineArgs(action: DivineAction, opts: IDivineOptions): string[] {
  // Default to 'error' (not 'off') so divine surfaces genuine failures on
  // stdout — the exit-code path alone doesn't distinguish "empty pak" from
  // "unreadable pak" for the list-package action.
  const args = [
    "--action",
    action,
    "--source",
    opts.source,
    "--game",
    "bg3",
    "--loglevel",
    opts.loglevel ?? "error",
  ];
  if (opts.destination !== undefined) {
    args.push("--destination", opts.destination);
  }
  if (opts.expression !== undefined) {
    args.push("--expression", opts.expression);
  }
  return args;
}

// divine.exe tags error lines with [ERROR] or [FATAL] at loglevel=error and
// above. Used to classify pak-format failures distinct from generic errors.
const PAK_INVALID_MARKER = /\[(?:ERROR|FATAL)\]/i;

function classifyPakInvalid(stdout: string, stderr: string): DivinePakInvalid | undefined {
  const stdoutTrim = stdout.trim();
  const stderrTrim = stderr.trim();
  if (PAK_INVALID_MARKER.test(stdoutTrim) || PAK_INVALID_MARKER.test(stderrTrim)) {
    return new DivinePakInvalid(stdoutTrim || stderrTrim);
  }
  return undefined;
}

export function translateDivineError(
  err: IExecErrorShape,
  action: DivineAction,
  signalAborted: boolean,
): Error {
  // Abort check runs first: a cancelled process exits via SIGTERM, which is
  // indistinguishable from a timeout by signal name alone.
  if (signalAborted) {
    return new DivineAborted();
  }
  if ([err.stderr, err.stdout].some((text) => text?.includes("VORTEX_BG3_UNSUPPORTED_TOOL_PATH"))) {
    return new DivineUnsupportedToolPath();
  }
  if (err.code === "ENOENT") {
    return new DivineExecMissing();
  }
  if (
    [err.message, err.stderr, err.stdout].some(
      (text) => text !== undefined && /You must install(?: or update)? \.NET/.test(text),
    )
  ) {
    return new DivineMissingDotNet();
  }
  const startupDiagnostic = [err.stderr, err.stdout].filter(Boolean).join("\n");
  if (/Failed to (?:create|initialize) CoreCLR|Vortex BG3 launcher:/.test(startupDiagnostic)) {
    return new DivineLaunchFailed(startupDiagnostic);
  }
  if (err.signal === "SIGTERM" && err.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new DivineTimedOut();
  }

  const stderrStr = typeof err.stderr === "string" ? err.stderr : "";
  const stdoutStr = typeof err.stdout === "string" ? err.stdout : "";

  const pakInvalid = classifyPakInvalid(stdoutStr, stderrStr);
  if (pakInvalid !== undefined) {
    return pakInvalid;
  }

  const stderrTrim = stderrStr.trim();
  const stdoutTrim = stdoutStr.trim();
  const parts: string[] = [`action=${action}`];
  if (typeof err.code === "number") {
    parts.push(`exitCode=${err.code}`);
  } else if (typeof err.code === "string") {
    parts.push(`code=${err.code}`);
  }
  if (err.signal) {
    parts.push(`signal=${err.signal}`);
  }
  if (stderrTrim) {
    parts.push(`stderr=${stderrTrim}`);
  }
  if (stdoutTrim) {
    parts.push(`stdout=${stdoutTrim}`);
  }
  const detail = parts.length > 1 ? parts.join("; ") : (err.message ?? "unknown");
  return new Error(`divine.exe failed: ${detail}`);
}

export function parsePackageListOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function commandEnvironment(command: NonNullable<IDivineRunOptions["command"]>): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => process.platform !== "linux" || !/^DOTNET_ROOT(?:_|\(|$)/i.test(name),
    ),
  );
  return { ...inherited, ...command.env };
}

function cliDiagnostics(stderr: string, throughProton: boolean): string {
  if (!throughProton) return stderr.trim();
  // Proton reports prefix setup on stderr; Wine also reports its active synchronization mode.
  return stderr
    .split(/\r?\n/)
    .filter((line) => !/^Proton: /.test(line) && !/^(?:e|f)sync: up and running\.$/.test(line))
    .join("\n")
    .trim();
}

export async function runDivineCore(
  exePath: string,
  action: DivineAction,
  opts: IDivineOptions,
  runOpts: IDivineRunOptions = {},
): Promise<IDivineOutput> {
  if (runOpts.signal?.aborted) throw new DivineAborted();
  try {
    if (!(await fs.stat(exePath)).isFile()) throw new DivineExecMissing();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DivineExecMissing();
    }
    throw e;
  }

  let stdout: string;
  let stderr: string;
  try {
    const command = runOpts.command;
    const result = await executeDivine(
      command?.executable ?? exePath,
      command?.args ?? buildDivineArgs(action, opts),
      {
        cwd: process.platform === "linux" && command ? path.dirname(exePath) : undefined,
        env: command ? commandEnvironment(command) : undefined,
        timeoutMs: runOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: runOpts.signal,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (e) {
    throw translateDivineError(e as IExecErrorShape, action, runOpts.signal?.aborted ?? false);
  }

  // The CLI exited successfully but divine may still have reported a problem:
  // failures show up on stdout (or occasionally stderr) with a bracketed
  // [ERROR]/[FATAL] marker rather than via non-zero exit.
  const pakInvalid = classifyPakInvalid(stdout, stderr);
  if (pakInvalid !== undefined) {
    throw pakInvalid;
  }
  const diagnostic = cliDiagnostics(
    stderr,
    process.platform === "linux" && runOpts.command !== undefined,
  );
  if (diagnostic) {
    throw new Error(`divine.exe failed: ${diagnostic}`);
  }
  if (!stdout && action !== "list-package") {
    return { stdout: "", returnCode: 2 };
  }
  return { stdout, returnCode: 0 };
}

export async function listPackageCore(
  exePath: string,
  pakPath: string,
  runOpts: IDivineRunOptions = {},
): Promise<string[]> {
  const res = await runDivineCore(exePath, "list-package", { source: pakPath }, runOpts);
  return parsePackageListOutput(res.stdout);
}

export async function extractPakCore(
  exePath: string,
  pakPath: string,
  destPath: string,
  pattern: string,
  runOpts: IDivineRunOptions = {},
): Promise<IDivineOutput> {
  return runDivineCore(
    exePath,
    "extract-package",
    { source: pakPath, destination: destPath, expression: pattern },
    runOpts,
  );
}
