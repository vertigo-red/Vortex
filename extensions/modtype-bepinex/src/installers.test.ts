import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getSupportMap, INJECTOR_FILES } from "./common";
import {
  installInjector,
  installRootMod,
  testSupportedBepInExInjector,
  testSupportedRootMod,
} from "./installers";
import type { IBepInExGameConfig } from "./types";

vi.mock("./util", () => ({
  resolveBepInExConfiguration: vi.fn(async () => Buffer.from("fixture config")),
}));
const config: IBepInExGameConfig = { gameId: "target", autoDownloadBepInEx: true };
function register(extra: Partial<IBepInExGameConfig> = {}) {
  getSupportMap().target = { ...config, ...extra };
}
afterEach(() => {
  for (const id of Object.keys(getSupportMap())) delete getSupportMap()[id];
});

describe("BepInEx archive installation", () => {
  it("copies Unix Doorstop libraries without extensions and skips directories", async () => {
    register();
    const files = [
      "BepInEx/core/BepInEx.dll",
      "BepInEx/",
      "doorstop_libs/",
      "doorstop_libs/libdoorstop_x64",
      "doorstop_libs/libdoorstop_x86",
      "run_bepinex.sh",
      ".doorstop_version",
      "LICENSE",
    ];
    const result = await installInjector(files, "/unused", "target");
    expect(result.instructions.filter((i) => i.type === "copy").map((i) => i.destination)).toEqual(
      files.filter((f) => !f.endsWith("/")).map((f) => path.join(...f.split("/"))),
    );
  });
  it("strips a wrapper without duplicating the deployment root's installRelPath", async () => {
    register({ installRelPath: path.join("bin", "Game") });
    const files = [
      "pack/BepInEx/core/BepInEx.dll",
      "pack/doorstop_libs/libdoorstop_x64",
      "pack/run_bepinex.sh",
      "pack/notes 日本語 &;.txt",
      "unrelated.txt",
    ];
    const copies = (await installInjector(files, "/unused", "target")).instructions.filter(
      (i) => i.type === "copy",
    );
    expect(copies).toEqual(
      files.slice(0, 4).map((source) => ({
        type: "copy",
        source,
        destination: path.join(...source.split("/").slice(1)),
      })),
    );
    expect(copies.map((copy) => path.join("game-root", "bin", "Game", copy.destination))).toContain(
      path.join("game-root", "bin", "Game", "BepInEx", "core", "BepInEx.dll"),
    );
  });
  it("handles Windows separators on Linux and renames the unity3 proxy", async () => {
    register({ installRelPath: "bin", doorstopConfig: { doorstopType: "unity3" } });
    const files = ["pack\\BepInEx\\core\\BepInEx.dll", "pack\\winhttp.dll", "pack\\BepInEx\\"];
    const copies = (await installInjector(files, "/unused", "target")).instructions.filter(
      (i) => i.type === "copy",
    );
    expect(copies.map((i) => i.destination)).toEqual([
      path.join("BepInEx", "core", "BepInEx.dll"),
      "version.dll",
    ]);
  });
  it("omits only the proxy for hardpatched games", async () => {
    register({ doorstopConfig: { doorstopType: "none" } });
    const copies = (
      await installInjector(
        ["BepInEx/core/BepInEx.dll", "winhttp.dll", "LICENSE"],
        "/unused",
        "target",
      )
    ).instructions.filter((i) => i.type === "copy");
    expect(copies.map((i) => i.destination)).toEqual([
      path.join("BepInEx", "core", "BepInEx.dll"),
      "LICENSE",
    ]);
  });
  it("recognizes an injector archive with Windows separators", async () => {
    register();
    const files = INJECTOR_FILES.slice(0, 10).map((f) => "pack\\BepInEx\\core\\" + f);
    expect((await testSupportedBepInExInjector(files, "target")).supported).toBe(true);
    expect((await testSupportedBepInExInjector(files, "unregistered")).supported).toBe(false);
  });
  it("handles mixed separators in plugin archives", async () => {
    register();
    expect((await testSupportedRootMod(["plugins\\Plugin.dll"], "target")).supported).toBe(true);
    const copies = (
      await installRootMod(
        ["plugins\\Plugin.dll", "plugins/", "config/Plugin.cfg"],
        "/unused",
        "target",
      )
    ).instructions.filter((i) => i.type === "copy");
    expect(copies.map((i) => i.destination)).toEqual([
      path.join("plugins", "Plugin.dll"),
      path.join("config", "Plugin.cfg"),
    ]);
  });
});
