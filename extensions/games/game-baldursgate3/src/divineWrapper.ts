/* eslint-disable */
import * as path from "path";

import { log, selectors, types, util } from "@nexusmods/vortex-api";

import { GAME_ID } from "./common";
import {
  DEFAULT_TIMEOUT_MS,
  DivineAborted,
  DivineLaunchFailed,
  DivineMissingDotNet,
  DivinePakInvalid,
  DivineUnsupportedToolPath,
  IDivineRunOptions,
  buildDivineArgs,
  parsePackageListOutput,
  resolveDivineExecutable,
  runDivineCore,
} from "./divineCore";
import { ensureDivineLauncher } from "./divineLauncher";
import { DivineAction, IDivineOptions, IDivineOutput } from "./types";
import { getLatestLSLibMod, logError } from "./util";

// Bound concurrent CLI processes; surface failed operations without repeated prefix launches.
const concurrencyLimiter: util.ConcurrencyLimiter = new util.ConcurrencyLimiter(5);

// Module-level AbortController lets callers cancel all in-flight and queued
// divine operations at once (e.g. when switching games). Replaced after each
// abort so subsequent calls run normally.
let abortController = new AbortController();

export function abortDivineOperations(): void {
  abortController.abort();
  abortController = new AbortController();
  // Let queued callbacks observe their captured aborted signal and settle their promises.
}

async function resolveExePath(api: types.IExtensionApi): Promise<string> {
  const state = api.getState();
  const stagingFolder = selectors.installPathForGame(state, GAME_ID);
  const lsLib = getLatestLSLibMod(api);
  if (lsLib === undefined) {
    throw new Error("LSLib/Divine tool is missing");
  }
  return resolveDivineExecutable(path.join(stagingFolder, lsLib.installationPath, "tools"));
}

async function runDivine(
  api: types.IExtensionApi,
  action: DivineAction,
  divineOpts: IDivineOptions,
): Promise<IDivineOutput> {
  // Capture the signal at enqueue time. If the controller is replaced by
  // abortDivineOperations() while this call is queued, the
  // captured signal stays aborted and every attempt fails fast.
  const signal = abortController.signal;
  return concurrencyLimiter.do(async () => {
    try {
      if (signal.aborted) throw new DivineAborted();
      const exePath = await resolveExePath(api);
      const runOpts: IDivineRunOptions = { signal, timeoutMs: DEFAULT_TIMEOUT_MS };
      if (process.platform === "linux") {
        let launcherPath: string;
        try {
          launcherPath = await ensureDivineLauncher(path.dirname(exePath));
        } catch (error) {
          throw new util.ProcessCanceled(
            `Vortex's BG3 launcher could not be prepared: ${error.message}`,
          );
        }
        const args = buildDivineArgs(action, divineOpts);
        runOpts.command = await util.getProtonToolCommand(
          launcherPath,
          [
            { path: exePath },
            ...args.map((arg, index) =>
              ["--source", "--destination"].includes(args[index - 1]) ? { path: arg } : arg,
            ),
          ],
          api.getState().settings.gameMode.discovered?.[GAME_ID],
        );
        runOpts.command.env.WINEDEBUG = "-all";
      }
      return await runDivineCore(exePath, action, divineOpts, runOpts);
    } catch (error) {
      if (signal.aborted) throw new DivineAborted();
      if (error instanceof DivineUnsupportedToolPath || error instanceof DivineLaunchFailed) {
        throw new util.ProcessCanceled(error.message);
      }
      throw error;
    }
  });
}

export async function extractPak(
  api: types.IExtensionApi,
  pakPath: string,
  destPath: string,
  pattern: string,
): Promise<IDivineOutput> {
  return runDivine(api, "extract-package", {
    source: pakPath,
    destination: destPath,
    expression: pattern,
  });
}

export async function listPackage(api: types.IExtensionApi, pakPath: string): Promise<string[]> {
  let res: IDivineOutput | undefined;
  try {
    res = await runDivine(api, "list-package", { source: pakPath });
  } catch (error) {
    if (error instanceof DivineAborted || error instanceof DivinePakInvalid) {
      throw error;
    }
    logError(`listPackage caught error: `, { error });

    if (error instanceof DivineMissingDotNet) {
      log("error", "Missing .NET", error.message);
      api.dismissNotification("bg3-reading-paks-activity");
      api.showErrorNotification(
        "LSLib requires .NET 8",
        (process.platform === "linux"
          ? "Install the Windows .NET 8 x64 runtime in Baldur's Gate 3's selected Steam/Proton prefix. " +
            "Installing the Linux runtime does not satisfy Divine's Windows dependency. " +
            "Run the Microsoft installer through this game's selected Proton build, then restart Vortex."
          : "LSLib requires .NET 8 Desktop Runtime to be installed.") +
          "[br][/br][br][/br]" +
          "[url=https://dotnet.microsoft.com/download/dotnet/8.0]Download .NET 8 from Microsoft[/url]",
        { id: "bg3-dotnet-error", allowReport: false, isBBCode: true },
      );
    }
    throw error;
  }

  return parsePackageListOutput(res?.stdout ?? "");
}
