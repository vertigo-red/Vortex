import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appDataPath,
  gameDataPath,
  initGameSupport,
} from "../extensions/gamebryo_plugin_management/util/gameSupport";
import { setGameParameters } from "../extensions/gamemode_management/actions/settings";
import { getGame } from "../extensions/gamemode_management/util/getGame";
import { iniFiles } from "../extensions/ini_prep/gameSupport";
import {
  getIniFilePath,
  initGameSupport as initFomod,
} from "../extensions/installer_fomod_shared/utils/gameSupport";
import { resetHarnessRegistries } from "../test-utils/builders";
import { makeGamebryoHarness } from "../test-utils/gamebryoTest";
import { ProcessCanceled } from "./CustomErrors";
import { getGameUserPath } from "./getGameUserPath";
import type { ISteamEntry } from "./Steam";

const steam = vi.hoisted(() => ({ entries: [] as ISteamEntry[] }));
vi.mock("./Steam", () => ({ default: { snapshot: () => ({ entries: steam.entries }) } }));

describe.skipIf(process.platform !== "linux")("Skyrim Legendary Edition settings on Linux", () => {
  let root: string;
  let prefix: string;
  let user: string;
  let game: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vortex-skyrim-le-"));
    prefix = path.join(root, "Префикс with spaces");
    user = path.join(prefix, "drive_c", "users", "Player");
    game = path.join(prefix, "drive_c", "Games", "Skyrim");
    await mkdir(path.join(user, "Documents"), { recursive: true });
    await mkdir(path.join(prefix, "drive_c", "users", "Public"));
    await mkdir(path.join(prefix, "dosdevices"));
    await symlink(path.join(prefix, "drive_c"), path.join(prefix, "dosdevices", "c:"));
    await mkdir(path.join(game, "Data"), { recursive: true });
    await writeFile(path.join(game, "TESV.exe"), "game");
    await writeFile(path.join(prefix, "user.reg"), "WINE REGISTRY Version 2\n");
  });

  afterEach(async () => {
    steam.entries = [];
    resetHarnessRegistries();
    await rm(root, { recursive: true, force: true });
  });

  const arrange = async (gamePath = game, modSettingsPrefix?: string) => {
    const harness = makeGamebryoHarness({ gameId: "skyrim", gamePath });
    harness.api.store.dispatch(setGameParameters("skyrim", { modSettingsPrefix }));
    // Exercise the real game wrapper with Skyrim's Data folder and TESV executable.
    getGame("skyrim").queryModPath = () => "Data";
    getGame("skyrim").executable = () => "TESV.exe";
    await initGameSupport(harness.api);
    initFomod(harness.api);
    return harness;
  };

  it("uses a manually selected Wine installation and its actual user, without launcher metadata", async () => {
    await arrange();
    expect(appDataPath("skyrim")).toBe(path.join(user, "AppData", "Local", "Skyrim"));
    expect(iniFiles("skyrim", { path: game })).toEqual([
      path.join(user, "Documents", "My Games", "Skyrim", "Skyrim.ini"),
      path.join(user, "Documents", "My Games", "Skyrim", "SkyrimPrefs.ini"),
    ]);
    expect(getIniFilePath("skyrim")).toBe(iniFiles("skyrim", { path: game })[0]);
    expect(gameDataPath("skyrim")).toBe(path.join(game, "Data"));
    expect(getGame("skyrim").getModPaths(game)[""]).toBe(gameDataPath("skyrim"));
  });

  it("selects Skyrim LE's Steam 72850 prefix instead of another game's prefix", async () => {
    const steamPrefix = path.join(root, "steamapps", "compatdata", "72850", "pfx");
    const steamUser = path.join(steamPrefix, "drive_c", "users", "steamuser");
    await mkdir(steamUser, { recursive: true });
    const externalGame = path.join(root, "steamapps", "common", "Skyrim");
    await mkdir(externalGame, { recursive: true });
    steam.entries = [
      {
        appid: "72850",
        gamePath: externalGame,
        usesProton: true,
        gameStoreId: "steam",
        name: "Skyrim",
        compatDataPath: path.dirname(steamPrefix),
      },
    ];
    await arrange(externalGame);
    expect(appDataPath("skyrim")).toBe(path.join(steamUser, "AppData", "Local", "Skyrim"));
    expect(getIniFilePath("skyrim")).toBe(
      path.join(steamUser, "Documents", "My Games", "Skyrim", "Skyrim.ini"),
    );
  });

  it("uses an explicit prefix for a game stored outside drive_c, even with Steam discovery", async () => {
    const externalGame = path.join(root, "Games", "Skyrim");
    await mkdir(externalGame, { recursive: true });
    steam.entries = [
      {
        appid: "72850",
        gamePath: externalGame,
        usesProton: false,
        gameStoreId: "steam",
        name: "Skyrim",
      },
    ];
    await arrange(externalGame, prefix);
    expect(appDataPath("skyrim")).toBe(path.join(user, "AppData", "Local", "Skyrim"));
    expect(getIniFilePath("skyrim")).toBe(
      path.join(user, "Documents", "My Games", "Skyrim", "Skyrim.ini"),
    );
  });

  it("resolves a game directory alias back to its enclosing prefix", async () => {
    const alias = path.join(root, "Game shortcut");
    await symlink(game, alias);
    expect(getGameUserPath("documents", { path: alias }, true)).toBe(path.join(user, "Documents"));
  });

  it("expands USERPROFILE using the selected prefix's user and respects folder redirection", async () => {
    await writeFile(
      path.join(prefix, "user.reg"),
      String.raw`WINE REGISTRY Version 2

[Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders]
"Personal"=str(2):"%USERPROFILE%\\Documents\\Game settings"
"Local AppData"=str(2):"%USERPROFILE%\\Game AppData"
`,
    );
    await arrange();
    expect(appDataPath("skyrim")).toBe(path.join(user, "Game AppData", "Skyrim"));
    expect(getIniFilePath("skyrim")).toBe(
      path.join(user, "Documents", "Game settings", "My Games", "Skyrim", "Skyrim.ini"),
    );
  });

  it("uses the existing spelling of Data, settings folders and INI filenames", async () => {
    await rm(path.join(game, "Data"), { recursive: true });
    await mkdir(path.join(game, "data"));
    await mkdir(path.join(user, "Documents", "my games", "skyrim"), { recursive: true });
    await writeFile(path.join(user, "Documents", "my games", "skyrim", "skyrim.ini"), "settings");
    await mkdir(path.join(user, "appdata", "local", "skyrim"), { recursive: true });
    await arrange();
    expect(gameDataPath("skyrim")).toBe(path.join(game, "data"));
    expect(getGame("skyrim").getModPaths(game)[""]).toBe(path.join(game, "data"));
    expect(appDataPath("skyrim")).toBe(path.join(user, "appdata", "local", "skyrim"));
    expect(getIniFilePath("skyrim")).toBe(
      path.join(user, "Documents", "my games", "skyrim", "skyrim.ini"),
    );
    expect(getIniFilePath("skyrim")).toBe(iniFiles("skyrim", { path: game })[0]);
  });

  it("refuses an unknown external prefix instead of writing Bethesda settings in the host", async () => {
    expect(() => getGameUserPath("documents", undefined, true)).toThrow(
      "Discover the game's installation",
    );
    const externalGame = path.join(root, "Unknown Skyrim");
    await mkdir(externalGame);
    await arrange(externalGame);
    expect(() => appDataPath("skyrim")).toThrow("Set Game Settings Prefix");
    expect(() => getIniFilePath("skyrim")).toThrow(ProcessCanceled);
  });

  it("refuses a stale explicit prefix and multiple user profiles without guessing", async () => {
    expect(() =>
      getGameUserPath(
        "documents",
        { path: game, modSettingsPrefix: path.join(root, "Missing") },
        true,
      ),
    ).toThrow(ProcessCanceled);
    await mkdir(path.join(prefix, "drive_c", "users", "Another Player"));
    expect(() => getGameUserPath("documents", { path: game }, true)).toThrow("exactly one");
    expect(await readdir(path.join(user, "Documents"))).toEqual([]);
  });
});
