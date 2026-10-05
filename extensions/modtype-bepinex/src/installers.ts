/* eslint-disable */
import path from "path";

import { types } from "@nexusmods/vortex-api";
import Parser, { IniFile, WinapiFormat } from "vortex-parse-ini";

import {
  BEPINEX_CONFIG_REL_PATH,
  DOORSTOPPER_CONFIG,
  DOORSTOPPER_HOOK,
  getSupportMap,
  INJECTOR_FILES,
  MODTYPE_BIX_INJECTOR,
} from "./common";
import { IDoorstopConfig, UnityDoorstopType } from "./types";
import { resolveBepInExConfiguration } from "./util";

function archiveSegments(file: string): string[] {
  return file.split(/[\\/]/);
}

function archiveName(file: string): string {
  return archiveSegments(file).at(-1) ?? "";
}

function makeCopy(
  source: string,
  alternativeFileName?: string,
  idx: number = 0,
): types.IInstruction {
  const segments = archiveSegments(source).slice(Math.max(0, idx));
  if (alternativeFileName !== undefined) segments[segments.length - 1] = alternativeFileName;
  return {
    type: "copy",
    source,
    // The mod type's deployment root already includes installRelPath.
    destination: path.join(...segments),
  };
}

/**
 * Below function is only relevant for BIX versions 5.4.22 or lower.
 */
async function applyDoorStopConfig(config: IDoorstopConfig, filePath: string) {
  const parser = new Parser(new WinapiFormat());
  const iniData: IniFile<any> = await parser.read(filePath);
  iniData.data["UnityDoorstop"]["enabled"] = true;
  iniData.data["UnityDoorstop"]["targetAssembly"] =
    config.targetAssembly !== undefined
      ? config.targetAssembly
      : "BepInEx\\core\\BepInEx.Preloader.dll";
  iniData.data["UnityDoorstop"]["redirectOutputLog"] =
    config.redirectOutputLog !== undefined ? config.redirectOutputLog : false;
  iniData.data["UnityDoorstop"]["ignoreDisableSwitch"] =
    config.ignoreDisableSwitch !== undefined ? config.ignoreDisableSwitch : true;
  iniData.data["UnityDoorstop"]["dllSearchPathOverride"] =
    config.dllOverrideRelPath !== undefined ? config.dllOverrideRelPath : "";
  return parser.write(filePath, iniData);
}

const MINIMUM_INJECTOR_MATCHES = 8;
export async function testSupportedBepInExInjector(
  files: string[],
  gameId: string,
): Promise<types.ISupportedResult> {
  if (getSupportMap()[gameId] === undefined) {
    return { supported: false, requiredFiles: [] };
  }

  const filesMatched = files.filter((file) =>
    INJECTOR_FILES.map((f) => f.toLowerCase()).includes(archiveName(file).toLowerCase()),
  );
  return Promise.resolve({
    supported: filesMatched.length > MINIMUM_INJECTOR_MATCHES,
    requiredFiles: [],
  });
}

export async function installInjector(
  files: string[],
  destinationPath: string,
  gameId: string,
): Promise<types.IInstallResult> {
  const gameConfig = getSupportMap()[gameId];
  const idx = (() => {
    const bixFile = files.find((file) => {
      const segments = archiveSegments(file);
      return segments.includes("BepInEx");
    });
    if (!bixFile) {
      return -1;
    }
    return archiveSegments(bixFile).indexOf("BepInEx");
  })();
  const rootFile = files.find((file) => archiveSegments(file).includes("BepInEx"));
  const wrapper =
    rootFile === undefined ? [] : archiveSegments(rootFile).slice(0, Math.max(0, idx));
  const doorStopConfig = gameConfig.doorstopConfig;
  const doorstopType: UnityDoorstopType =
    doorStopConfig?.doorstopType !== undefined ? doorStopConfig.doorstopType : "default";
  const modTypeInstruction: types.IInstruction = {
    type: "setmodtype",
    value: MODTYPE_BIX_INJECTOR,
  };
  const attribInstr: types.IInstruction = {
    type: "attribute",
    key: "customFileName",
    value: "Bepis Injector Extensible",
  };
  /**
   * The doorstopper format changed in 5.4.23 and in 6.x.x pre-release
   *  versions. Rather than constantly changing our code to match any
   *  their configuration changes, we might as well leave the default values in.
   */
  // if (doorStopConfig !== undefined) {
  //   try {
  //     const configFilePath = files.find(file => path.basename(file) === DOORSTOPPER_CONFIG);
  //     if (configFilePath !== undefined) {
  //       // This BIX package uses UnityDoorstop - attempt to modify the configuration.
  //       await applyDoorStopConfig(doorStopConfig, path.join(destinationPath, configFilePath));
  //     }
  //   } catch (err) {
  //     return Promise.reject(err);
  //   }
  // }

  const configData = await resolveBepInExConfiguration(gameId);
  const configInstr: types.IInstruction = {
    type: "generatefile",
    data: configData,
    destination: BEPINEX_CONFIG_REL_PATH,
  };

  const instructions: types.IInstruction[] = files.reduce(
    (accum, file) => {
      if (
        /[\\/]$/.test(file) ||
        wrapper.some((segment, index) => archiveSegments(file)[index] !== segment)
      ) {
        return accum;
      }
      if (doorstopType !== "default" && archiveName(file).toLowerCase() === DOORSTOPPER_HOOK) {
        switch (doorstopType) {
          case "unity3": {
            accum.push(makeCopy(file, "version.dll", idx));
            break;
          }
          case "none": {
            return accum;
          }
        }
      } else {
        accum.push(makeCopy(file, undefined, idx));
      }
      return accum;
    },
    [modTypeInstruction, attribInstr, configInstr],
  );

  return Promise.resolve({ instructions });
}

const ROOT_DIRS = ["plugins", "config", "patchers"];
export async function testSupportedRootMod(
  files: string[],
  gameId: string,
): Promise<types.ISupportedResult> {
  if (getSupportMap()[gameId] === undefined) {
    return { supported: false, requiredFiles: [] };
  }

  const filtered = files.filter((file) => {
    // We expect the root mod to have the same directory structure as BepInEx's
    //  root directory, which means that the very first segments should have a
    //  patchers, plugins or config directory.
    const segments = archiveSegments(file);
    return ROOT_DIRS.includes(segments[0]);
  });

  return { supported: filtered.length > 0, requiredFiles: [] };
}

export async function installRootMod(
  files: string[],
  destinationPath: string,
  _gameId: string,
): Promise<types.IInstallResult> {
  const modTypeInstruction: types.IInstruction = {
    type: "setmodtype",
    value: "bepinex-root",
  };
  const instructions: types.IInstruction[] = files
    .filter((file) => !/[\\/]$/.test(file))
    .map((file) => makeCopy(file));
  instructions.push(modTypeInstruction);
  return Promise.resolve({ instructions });
}
