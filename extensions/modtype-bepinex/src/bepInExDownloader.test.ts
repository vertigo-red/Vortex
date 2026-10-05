import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ensureBepInExPack } from "./bepInExDownloader";
import { addGameSupport, getSupportMap, MODTYPE_BIX_INJECTOR } from "./common";
import { downloadFromGithub } from "./githubDownloader";

vi.mock("./githubDownloader", () => ({
  downloadFromGithub: vi.fn(async () => {}),
  checkForUpdates: vi.fn(async () => "5.4.22"),
}));
const hostPlatform = process.platform;
let root: string;
let api: types.IExtensionApi;
let state: any;

beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  root = await mkdtemp(path.join(os.tmpdir(), "vortex-bepinex-download-"));
  await writeFile(path.join(root, "game"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  vi.mocked(util.getGame).mockReturnValue({
    id: "target",
    name: "Fixture Game",
    requiredFiles: ["game"],
    executable: () => "game",
    queryModPath: () => ".",
  });
  state = {
    settings: { gameMode: { discovered: { target: { path: root } } } },
    persistent: {
      mods: { target: {} },
      downloads: { files: { cached: { localPath: "BepInEx_x64_5.4.22.0.zip", game: ["target"] } } },
    },
  };
  api = {
    getState: () => state,
    store: { dispatch: vi.fn() },
    events: {
      emit: vi.fn((event, _id, _silent, callback) => {
        if (event === "start-install-download") callback(null, "installed");
        return true;
      }),
    },
  } as unknown as types.IExtensionApi;
  addGameSupport({ gameId: "target", autoDownloadBepInEx: true });
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: hostPlatform, configurable: true });
  vi.clearAllMocks();
  for (const id of Object.keys(getSupportMap())) delete getSupportMap()[id];
  await rm(root, { recursive: true, force: true });
});

it("routes a native game directly to GitHub instead of the cached Windows Nexus archive", async () => {
  await ensureBepInExPack(api, "target");
  expect(downloadFromGithub).toHaveBeenCalledWith(api, getSupportMap().target);
  expect(api.events.emit).not.toHaveBeenCalled();
});

it("uses the Windows Nexus archive for an MZ game despite the Linux host", async () => {
  await writeFile(path.join(root, "game"), "MZfixture");
  await ensureBepInExPack(api, "target");
  expect(api.events.emit).toHaveBeenCalledWith(
    "start-install-download",
    "cached",
    true,
    expect.any(Function),
  );
  expect(downloadFromGithub).not.toHaveBeenCalled();
});

it("does not guess or download a package when the game executable is unknown", async () => {
  await writeFile(path.join(root, "game"), "unknown");
  await expect(ensureBepInExPack(api, "target")).rejects.toThrow("Cannot determine");
  expect(downloadFromGithub).not.toHaveBeenCalled();
  expect(api.events.emit).not.toHaveBeenCalled();
});

it("registers supported IL2CPP prereleases instead of rejecting them as BepInEx 5", () => {
  addGameSupport({
    gameId: "il2cpp",
    autoDownloadBepInEx: true,
    unityBuild: "unityil2cpp",
    bepinexVersion: "6.0.0-pre.2",
  });
  expect(getSupportMap().il2cpp.bepinexCoercedVersion).toBe("6.0.0");
  expect(() =>
    addGameSupport({
      gameId: "invalid",
      autoDownloadBepInEx: true,
      unityBuild: "unityil2cpp",
      bepinexVersion: "5.4.22",
    }),
  ).toThrow("6.0.0");
});

it("reinstalls an explicitly pinned prerelease when a different prerelease is installed", async () => {
  await writeFile(path.join(root, "game"), "MZfixture");
  addGameSupport({ gameId: "target", autoDownloadBepInEx: true, bepinexVersion: "6.0.0-pre.2" });
  state.persistent.mods.target.old = {
    type: MODTYPE_BIX_INJECTOR,
    attributes: { version: "6.0.0-pre.1" },
  };
  await ensureBepInExPack(api, "target");
  expect(downloadFromGithub).toHaveBeenCalled();
});

it("retains an installed injector matching the exact four-component pin", async () => {
  addGameSupport({ gameId: "target", autoDownloadBepInEx: true, bepinexVersion: "5.4.23.3" });
  state.persistent.mods.target.current = {
    type: MODTYPE_BIX_INJECTOR,
    attributes: { version: "5.4.23.3" },
  };
  await ensureBepInExPack(api, "target");
  expect(downloadFromGithub).not.toHaveBeenCalled();
  expect(api.events.emit).not.toHaveBeenCalled();
});

it("treats a cosmetic .0 as the same installed release", async () => {
  addGameSupport({ gameId: "target", autoDownloadBepInEx: true, bepinexVersion: "5.4.22.0" });
  state.persistent.mods.target.current = {
    type: MODTYPE_BIX_INJECTOR,
    attributes: { version: "5.4.22" },
  };
  await ensureBepInExPack(api, "target");
  expect(downloadFromGithub).not.toHaveBeenCalled();
});
