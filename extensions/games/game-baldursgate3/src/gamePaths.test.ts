import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { fs, util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  documentsPath,
  getPlayerProfiles,
  modsPath,
  profilesPath,
  scriptExtenderPath,
} from "./gamePaths";
import type { IModSettings } from "./types";
import { globalProfilePath, readModSettings, writeModSettings } from "./util";

let root: string;
let userPath: string;
let discovery: types.IDiscoveryResult;
let state: types.IState;
let api: types.IExtensionApi;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vortex-bg3-paths-"));
  userPath = path.join(root, "Secondary Library", "Proton AppData");
  discovery = { path: path.join(root, "BG3"), store: "steam" } as types.IDiscoveryResult;
  state = {
    settings: { gameMode: { discovered: { baldursgate3: discovery } } },
  } as unknown as types.IState;
  api = { getState: () => state, store: { getState: () => state } } as types.IExtensionApi;
  vi.mocked(util.getGameUserPath).mockReturnValue(userPath);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("BG3 discovered user files", () => {
  it("routes mods, profiles and Script Extender to the game's Local AppData", () => {
    const gameRoot = path.join(userPath, "Larian Studios", "Baldur's Gate 3");
    expect(documentsPath(api)).toBe(gameRoot);
    expect(modsPath(api)).toBe(path.join(gameRoot, "Mods"));
    expect(profilesPath(api)).toBe(path.join(gameRoot, "PlayerProfiles"));
    expect(scriptExtenderPath(api)).toBe(path.join(gameRoot, "Script Extender"));
    expect(util.getGameUserPath).toHaveBeenCalledWith("localAppData", discovery);
  });

  it("uses a supplied setup or query discovery before stored discovery", () => {
    const selected = { path: path.join(root, "Other library", "BG3") };
    modsPath(api, selected);
    expect(util.getGameUserPath).toHaveBeenLastCalledWith(
      "localAppData",
      process.platform === "linux" ? { ...selected, store: "steam" } : selected,
    );
  });

  it.skipIf(process.platform !== "linux")(
    "requires game discovery instead of writing host AppData",
    () => {
      delete state.settings.gameMode.discovered.baldursgate3;
      expect(() => modsPath(api)).toThrow(util.ProcessCanceled);
      expect(util.getGameUserPath).not.toHaveBeenCalled();
    },
  );

  it("propagates an unresolved prefix before creating user directories", async () => {
    vi.mocked(util.getGameUserPath).mockImplementationOnce(() => {
      throw new util.ProcessCanceled("Launch the game once");
    });
    await expect(getPlayerProfiles(api)).rejects.toThrow("Launch the game once");
    expect(fs.readdirAsync).not.toHaveBeenCalled();
  });

  it("reads profiles afresh, including newly created directories with dots", async () => {
    expect(await getPlayerProfiles(api)).toEqual([]);
    const directory = profilesPath(api);
    await mkdir(path.join(directory, "Default"), { recursive: true });
    await mkdir(path.join(directory, "Public"));
    await writeFile(path.join(directory, "NotAProfile"), "file");
    expect(await getPlayerProfiles(api)).toEqual(["Public"]);
    await mkdir(path.join(directory, "Player.2"));
    expect((await getPlayerProfiles(api)).sort()).toEqual(["Player.2", "Public"]);
    await rm(path.join(directory, "Public"), { recursive: true });
    expect(await getPlayerProfiles(api)).toEqual(["Player.2"]);
  });

  it("surfaces filesystem permission errors", async () => {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    vi.mocked(fs.readdirAsync).mockRejectedValueOnce(error);
    await expect(getPlayerProfiles(api)).rejects.toBe(error);
  });

  it("uses the existing Public profile for setup, reads and writes", async () => {
    const profile = path.join(profilesPath(api), "Public");
    await mkdir(profile, { recursive: true });
    const settings = path.join(profile, "modsettings.lsx");
    await writeFile(settings, '<save><region id="Existing" /></save>');
    expect(await globalProfilePath(api, discovery)).toBe(profile);
    expect((await readModSettings(api)).save.region[0].$.id).toBe("Existing");
    await writeModSettings(
      api,
      { save: { region: [{ $: { id: "Updated" } }] } } as unknown as IModSettings,
      "Public",
    );
    expect(await readFile(settings, "utf8")).toContain('id="Updated"');
    await expect(
      readFile(path.join(documentsPath(api), "Public", "modsettings.lsx")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });
});
