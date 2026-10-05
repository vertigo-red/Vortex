import { util } from "@nexusmods/vortex-api";
import semver from "semver";

import type {
  BepInExPlatform,
  IBepInExGameConfig,
  IBIXPackageResolver,
  IGithubRelease,
} from "./types";

export function resolveBixPackage(
  gameConf: IBepInExGameConfig,
  targetPlatform: BepInExPlatform = "win32",
): IBIXPackageResolver {
  const version =
    gameConf.bepinexCoercedVersion ?? semver.coerce(gameConf.bepinexVersion ?? "5.4.22")?.version;
  if (version === undefined) throw new util.DataInvalid("Invalid BepInEx version");
  const architecture = gameConf.architecture ?? "x64";
  if (targetPlatform === "win32" && architecture === "unix") {
    throw new util.DataInvalid("A Windows BepInEx package requires x86 or x64 architecture");
  }
  const arch = architecture === "unix" ? "x64" : architecture;
  const platform =
    targetPlatform === "win32" ? "win" : targetPlatform === "darwin" ? "macos" : "linux";
  const unity = gameConf.unityBuild ?? "unitymono";
  const prefixes = semver.gte(version, "6.0.0")
    ? [
        "BepInEx-Unity\\." +
          (unity === "unityil2cpp" ? "IL2CPP" : "Mono") +
          "-" +
          platform +
          "-" +
          arch,
        ...(targetPlatform === "win32"
          ? ["BepInEx_" + unity + "_" + arch]
          : unity === "unitymono"
            ? ["BepInEx_UnityMono_unix"]
            : []),
      ]
    : [
        "BepInEx_" + platform + "_" + arch,
        targetPlatform === "win32" ? "BepInEx_" + arch : "BepInEx_unix",
      ];
  const availablePrefixes =
    architecture === "unix" ? prefixes.filter((prefix) => prefix.endsWith("unix")) : prefixes;
  return {
    rgx: new RegExp(
      "^(?:" +
        availablePrefixes.join("|") +
        ")[_-](?<version>[0-9]+(?:\\.[0-9]+){2,3}(?:-[A-Za-z0-9.-]+)?)\\.(?:zip|7z)$",
      "i",
    ),
    version,
    architecture,
    unityBuild: gameConf.unityBuild,
  };
}

function releaseVersion(tag: string): string {
  return tag.replace(/^v/i, "");
}

export function normalizeBepInExVersion(version: string): string {
  return version.replace(/^v/i, "").replace(/^(\d+\.\d+\.\d+)\.0$/, "$1");
}

export function resolveDownloadLink(
  gameConf: IBepInExGameConfig,
  currentReleases: IGithubRelease[],
  targetPlatform: BepInExPlatform = "win32",
): { version: string; downloadLink: string } {
  const { rgx, version } = resolveBixPackage(gameConf, targetPlatform);
  const requested =
    gameConf.bepinexVersion === undefined
      ? undefined
      : normalizeBepInExVersion(gameConf.bepinexVersion);
  const exact =
    requested !== undefined && (requested.includes("-") || /^\d+\.\d+\.\d+\.\d+$/.test(requested));
  const releases = [...currentReleases].sort((a, b) => {
    const lhs = releaseVersion(a.tag_name);
    const rhs = releaseVersion(b.tag_name);
    return semver.valid(lhs) && semver.valid(rhs)
      ? semver.rcompare(lhs, rhs)
      : rhs.localeCompare(lhs, "en", { numeric: true });
  });
  for (const release of releases) {
    const tag = releaseVersion(release.tag_name);
    if (exact ? tag !== requested : semver.coerce(tag)?.version !== version) continue;
    const asset = release.assets.find((candidate) => {
      const match = rgx.exec(candidate.name);
      const archiveVersion = match?.groups?.version;
      return (
        (archiveVersion === tag || archiveVersion === tag + ".0") &&
        typeof candidate.browser_download_url === "string" &&
        candidate.browser_download_url !== ""
      );
    });
    if (asset !== undefined) return { version: tag, downloadLink: asset.browser_download_url };
  }
  throw new util.DataInvalid(
    "No matching BepInEx archive for " +
      targetPlatform +
      "/" +
      (gameConf.architecture ?? "x64") +
      " " +
      (requested ?? version),
  );
}
