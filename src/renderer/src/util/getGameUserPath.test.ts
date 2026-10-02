import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appDataPath,
  initGameSupport,
} from "../extensions/gamebryo_plugin_management/util/gameSupport";
import { iniFiles } from "../extensions/ini_prep/gameSupport";
import { makeGamebryoHarness } from "../test-utils/gamebryoTest";
import { ProcessCanceled } from "./CustomErrors";
import { getGameUserPath } from "./getGameUserPath";
import getVortexPath from "./getVortexPath";
import type { ISteamEntry } from "./Steam";

const steam = vi.hoisted(() => ({ entries: [] as ISteamEntry[] }));
vi.mock("./Steam", () => ({ default: { snapshot: () => ({ entries: steam.entries }) } }));

let root: string;
let user: string;
let gamePath: string;
const discovery = () => ({ path: gamePath, store: "steam" });

describe.skipIf(process.platform !== "linux")("Steam/Proton game user paths", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vortex-game-paths-"));
    gamePath = path.join(
      root,
      "Secondary Library",
      "steamapps",
      "common",
      "Skyrim Special Edition",
    );
    const compatDataPath = path.join(
      root,
      "Secondary Library",
      "steamapps",
      "compatdata",
      "489830",
    );
    user = path.join(compatDataPath, "pfx", "drive_c", "users", "steamuser");
    await mkdir(gamePath, { recursive: true });
    await mkdir(path.join(user, "Documents"), { recursive: true });
    steam.entries = [
      {
        appid: "489830",
        name: "Skyrim",
        gamePath,
        gameStoreId: "steam",
        usesProton: true,
        compatDataPath,
      },
    ];
  });
  afterEach(async () => {
    steam.entries = [];
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("uses the discovered library's prefix rather than the host user directories", () => {
    vi.stubEnv("LOCALAPPDATA", "/host/AppData");
    expect(getGameUserPath("localAppData", discovery())).toBe(path.join(user, "AppData", "Local"));
    expect(getGameUserPath("documents", discovery())).toBe(path.join(user, "Documents"));
  });

  it("keeps documents symlinks and writes to their intended destination", async () => {
    const redirected = path.join(root, "Host Documents");
    await mkdir(redirected);
    await rm(path.join(user, "Documents"), { recursive: true });
    await symlink(redirected, path.join(user, "Documents"));
    const file = path.join(getGameUserPath("documents", discovery()), "test.ini");
    await writeFile(file, "settings");
    expect(await readFile(path.join(redirected, "test.ini"), "utf8")).toBe("settings");
  });

  it("supports the older My Documents directory", async () => {
    await rm(path.join(user, "Documents"), { recursive: true });
    await mkdir(path.join(user, "My Documents"));
    expect(getGameUserPath("documents", discovery())).toBe(path.join(user, "My Documents"));
  });

  it("uses the correct prefix when discovery uses a game directory symlink", async () => {
    const alias = path.join(root, "Game alias");
    await symlink(gamePath, alias);
    expect(getGameUserPath("localAppData", { path: alias, store: "steam" })).toBe(
      path.join(user, "AppData", "Local"),
    );
  });

  it("routes Bethesda plugin and INI paths through the same prefix", async () => {
    const harness = makeGamebryoHarness({ gameId: "skyrimse", gamePath });
    await initGameSupport(harness.api);
    expect(appDataPath("skyrimse")).toBe(
      path.join(user, "AppData", "Local", "Skyrim Special Edition"),
    );
    expect(iniFiles("skyrimse", discovery())).toEqual([
      path.join(user, "Documents", "My Games", "Skyrim Special Edition", "Skyrim.ini"),
      path.join(user, "Documents", "My Games", "Skyrim Special Edition", "SkyrimPrefs.ini"),
      path.join(user, "Documents", "My Games", "Skyrim Special Edition", "SkyrimCustom.ini"),
    ]);
  });

  it("requires the selected game's prefix even when another game has one", () => {
    expect(() => getGameUserPath("documents", { path: gamePath + "2", store: "steam" })).toThrow(
      ProcessCanceled,
    );
  });

  it("reports uninitialized prefixes rather than writing host game settings", async () => {
    await rm(user, { recursive: true });
    expect(() => getGameUserPath("documents", discovery())).toThrow(ProcessCanceled);
  });

  it("does not use a stale prefix when Steam selected a native runtime", () => {
    steam.entries[0].usesProton = false;
    expect(() => getGameUserPath("localAppData", discovery())).toThrow(ProcessCanceled);
  });

  it("does not require a Proton prefix for games without user INI files", () => {
    steam.entries[0].usesProton = false;
    expect(iniFiles("native-linux-game", discovery())).toEqual([]);
    expect(iniFiles("morrowind", discovery())).toEqual([path.join(gamePath, "Morrowind.ini")]);
  });

  it("retains default paths when no Steam discovery applies", () => {
    expect(getGameUserPath("documents")).toBe(getVortexPath("documents"));
    expect(getGameUserPath("documents", { path: path.join(root, "Native Game") })).toBe(
      getVortexPath("documents"),
    );
  });
});
