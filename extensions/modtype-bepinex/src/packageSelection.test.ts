import { describe, expect, it } from "vitest";

import releases from "./__fixtures__/releases.json";
import { getDownload } from "./common";
import { resolveBixPackage, resolveDownloadLink } from "./packageSelection";
import type { IBepInExGameConfig } from "./types";

const config = (version: string, extra: Partial<IBepInExGameConfig> = {}): IBepInExGameConfig => ({
  gameId: "fixture-game",
  autoDownloadBepInEx: true,
  bepinexVersion: version,
  ...extra,
});

describe("official BepInEx release assets", () => {
  it("accepts a cosmetic zero revision when the official release tag has three components", () => {
    expect(
      resolveDownloadLink(config("5.4.22.0"), releases, "win32").downloadLink.split("/").at(-1),
    ).toBe("BepInEx_x64_5.4.22.0.zip");
  });
  it("does not silently interpret the legacy unix architecture as x64", () => {
    expect(
      resolveDownloadLink(config("5.4.22", { architecture: "unix" }), releases, "linux")
        .downloadLink.split("/")
        .at(-1),
    ).toBe("BepInEx_unix_5.4.22.0.zip");
    expect(() =>
      resolveDownloadLink(config("5.4.23.3", { architecture: "unix" }), releases, "linux"),
    ).toThrow("No matching");
  });
  it.each([
    ["5.4.22", "win32", "x64", undefined, "BepInEx_x64_5.4.22.0.zip"],
    ["5.4.22", "win32", "x86", undefined, "BepInEx_x86_5.4.22.0.zip"],
    ["5.4.22", "linux", "x64", undefined, "BepInEx_unix_5.4.22.0.zip"],
    ["5.4.22", "darwin", "x64", undefined, "BepInEx_unix_5.4.22.0.zip"],
    ["5.4.23.3", "win32", "x64", undefined, "BepInEx_win_x64_5.4.23.3.zip"],
    ["5.4.23.3", "linux", "x64", undefined, "BepInEx_linux_x64_5.4.23.3.zip"],
    ["5.4.23.3", "linux", "x86", undefined, "BepInEx_linux_x86_5.4.23.3.zip"],
    ["5.4.23.3", "darwin", "x64", undefined, "BepInEx_macos_x64_5.4.23.3.zip"],
    ["6.0.0-pre.1", "win32", "x64", "unitymono", "BepInEx_UnityMono_x64_6.0.0-pre.1.zip"],
    ["6.0.0-pre.1", "linux", "x64", "unitymono", "BepInEx_UnityMono_unix_6.0.0-pre.1.zip"],
    ["6.0.0-pre.1", "win32", "x86", "unityil2cpp", "BepInEx_UnityIL2CPP_x86_6.0.0-pre.1.zip"],
    ["6.0.0-pre.2", "win32", "x64", "unitymono", "BepInEx-Unity.Mono-win-x64-6.0.0-pre.2.zip"],
    ["6.0.0-pre.2", "linux", "x86", "unitymono", "BepInEx-Unity.Mono-linux-x86-6.0.0-pre.2.zip"],
    ["6.0.0-pre.2", "win32", "x64", "unityil2cpp", "BepInEx-Unity.IL2CPP-win-x64-6.0.0-pre.2.zip"],
    [
      "6.0.0-pre.2",
      "linux",
      "x64",
      "unityil2cpp",
      "BepInEx-Unity.IL2CPP-linux-x64-6.0.0-pre.2.zip",
    ],
  ] as const)("selects %s / %s / %s / %s", (version, platform, architecture, unityBuild, name) => {
    const selected = resolveDownloadLink(
      config(version, { architecture, unityBuild }),
      releases,
      platform,
    );
    expect(selected.downloadLink.split("/").at(-1)).toBe(name);
  });

  it("does not use the Windows-only Nexus catalog for native games", () => {
    expect(getDownload(config("5.4.22"), "linux")).toBeUndefined();
    expect(getDownload(config("5.4.22"), "darwin")).toBeUndefined();
    expect(getDownload(config("5.4.22"), "win32")?.archiveName).toBe("BepInEx_x64_5.4.22.0.zip");
  });

  it("selects the latest revision regardless of GitHub array ordering", () => {
    const newer = releases.find((r) => r.tag_name === "v5.4.23.3")!;
    const older = JSON.parse(JSON.stringify(newer).replaceAll("5.4.23.3", "5.4.23.1"));
    expect(resolveDownloadLink(config("5.4.23"), [older, newer], "linux").version).toBe("5.4.23.3");
  });

  it("rejects a missing architecture instead of using the first asset", () => {
    expect(() =>
      resolveDownloadLink(
        config("6.0.0-pre.2", { architecture: "x86", unityBuild: "unityil2cpp" }),
        releases,
        "linux",
      ),
    ).toThrow("No matching");
  });

  it("keeps exact prerelease and fourth-component pins", () => {
    expect(resolveDownloadLink(config("6.0.0-pre.1"), releases, "win32").version).toBe(
      "6.0.0-pre.1",
    );
    expect(() => resolveDownloadLink(config("5.4.23.2"), releases, "linux")).toThrow("No matching");
  });

  it("rejects similarly named patchers, suffixed archives and a mismatched asset version", () => {
    const rgx = resolveBixPackage(config("5.4.23.3"), "win32").rgx;
    for (const name of [
      "BepInEx_Patcher_5.4.23.3.zip",
      "BepInEx_win_x64_5.4.23.3.zip.exe",
      "prefixBepInEx_win_x64_5.4.23.3.zip",
    ])
      expect(rgx.test(name)).toBe(false);
    expect(() =>
      resolveDownloadLink(
        config("5.4.23.3"),
        [
          {
            tag_name: "v5.4.23.3",
            assets: [
              {
                name: "BepInEx_win_x64_5.4.23.1.zip",
                browser_download_url: "https://example.invalid/other.zip",
              },
            ],
          },
        ],
        "win32",
      ),
    ).toThrow("No matching");
  });
});
