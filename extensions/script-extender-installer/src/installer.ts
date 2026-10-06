import * as path from "node:path";

import { selectors, types, util } from "@nexusmods/vortex-api";

import supportData from "./gameSupport";
import { getScriptExtenderVersion } from "./util";

const archivePath = (file: string): string => file.replace(/\\/g, "/");

function validArchivePath(file: string): string {
  const source = archivePath(file);
  if (source.startsWith("/") || /^[a-z]:/i.test(source) || source.split("/").includes("..")) {
    throw new util.DataInvalid(`Invalid script extender archive path "${file}".`);
  }
  return source;
}

function findLoaders(files: string[], gameId: string): string[] {
  const executable = supportData[gameId]?.scriptExtExe.toLowerCase();
  return executable === undefined
    ? []
    : files.filter(
        (file) =>
          !archivePath(file).endsWith("/") &&
          path.posix.basename(archivePath(file)).toLowerCase() === executable,
      );
}

async function testSupported(files: string[], gameId: string): Promise<types.ISupportedResult> {
  return { supported: findLoaders(files, gameId).length > 0, requiredFiles: [] };
}

function copyInstruction(
  rootPath: string,
  file: string,
  gamePath: string | undefined,
): types.IInstruction {
  const source = validArchivePath(file);
  const relative = path.posix.relative(rootPath, source);
  const destination = path.join(...relative.split("/"));
  return {
    type: "copy",
    source: path.join(...source.split("/")),
    destination:
      process.platform === "linux" && gamePath !== undefined
        ? path.relative(gamePath, util.resolveWindowsGamePath(gamePath, destination))
        : destination,
  };
}

async function installScriptExtender(
  api: types.IExtensionApi,
  files: string[],
  destinationPath: string,
  gameId: string,
): Promise<types.IInstallResult> {
  const gameData = supportData[gameId];
  if (gameData === undefined) {
    throw new util.DataInvalid(`Script extender installation is not supported for "${gameId}".`);
  }
  const loaders = findLoaders(files, gameId);
  if (loaders.length !== 1) {
    throw new util.DataInvalid(
      `Expected one "${gameData.scriptExtExe}" in the mod archive; found ${loaders.length}.`,
    );
  }
  const scriptExtender = validArchivePath(loaders[0]);
  const rootPath = path.posix.dirname(scriptExtender);
  const gamePath = selectors.discoveryByGame(api.getState(), gameId)?.path;
  const instructions = files
    .filter(
      (file) =>
        !archivePath(file).endsWith("/") &&
        (rootPath === "." || archivePath(file).startsWith(`${rootPath}/`)),
    )
    .map((file) => copyInstruction(rootPath, file, gamePath));

  const scriptExtenderVersion = await getScriptExtenderVersion(
    path.join(destinationPath, ...scriptExtender.split("/")),
  );
  if (scriptExtenderVersion === undefined) {
    throw new util.DataInvalid(`Could not read the version of "${gameData.scriptExtExe}".`);
  }
  instructions.push(...gameData.attributes(scriptExtenderVersion), {
    type: "rule",
    rule: {
      reference: {
        logicalFileName: gameData.name,
        versionMatch: `<${scriptExtenderVersion} || >${scriptExtenderVersion}`,
      },
      type: "conflicts",
      comment: "Incompatible Script Extender",
    },
  });

  // Keep the loader/DLLs at the game root and scripts under Data in one managed mod.
  instructions.push({ type: "setmodtype", value: "dinput" });
  return { instructions };
}

export { testSupported, installScriptExtender };
