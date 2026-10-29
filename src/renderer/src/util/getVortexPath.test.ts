import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApplicationData } from "../applicationData";
import { iniFiles } from "../extensions/ini_prep/gameSupport";
import type { IGame } from "../types/IGame";
import getVortexPath, { makeGamePathGetter, setGameUserPathContext } from "./getVortexPath";

const games = vi.hoisted(() => new Map<string, IGame>());
vi.mock("../extensions/gamemode_management/util/getGame", () => ({
  getGame: (id: string) => games.get(id),
}));

describe("game-specific Vortex paths", () => {
  let root: string;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    root = mkdtempSync(path.join(tmpdir(), "vortex-game-paths-"));
    vi.stubEnv("WINEPREFIX", "");
    games.clear();
  });
  afterEach(() => {
    setGameUserPathContext(undefined);
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function game(id: string, executable = "Game.exe"): IGame {
    const value: IGame = {
      id,
      name: id,
      executable: () => executable,
      queryModPath: () => "Data",
      requiredFiles: [executable],
    };
    games.set(id, value);
    return value;
  }

  function prefix(name: string) {
    const pfx = path.join(root, name, "pfx");
    const documents = path.join(pfx, "drive_c/users/steamuser/Documents");
    mkdirSync(documents, { recursive: true });
    return { pfx, documents };
  }

  it("resolves Oblivion INI through its own prefix while Vortex keeps host paths", () => {
    const oblivion = game("oblivion", "Oblivion.exe");
    const installed = prefix("oblivion");
    const discovery = {
      path: path.join(root, "Oblivion"),
      environment: { WINEPREFIX: installed.pfx },
    };
    setGameUserPathContext(() => ({ discovery }));
    expect(iniFiles("oblivion", discovery)).toEqual([
      path.join(installed.documents, "My Games/Oblivion/Oblivion.ini"),
    ]);
    expect(getVortexPath("documents", oblivion)).toBe(installed.documents);
    expect(getVortexPath("documents")).toBe(ApplicationData.instance.paths.documents);
    expect(getVortexPath("appData")).toBe(ApplicationData.instance.paths.appData);
    expect(getVortexPath("userData", oblivion)).toBe(ApplicationData.instance.paths.userData);
  });

  it("uses an explicitly supplied discovery during profile activation", () => {
    const oblivion = game("oblivion");
    const old = prefix("old");
    const moved = prefix("new location");
    setGameUserPathContext(() => ({
      discovery: { path: root, environment: { WINEPREFIX: old.pfx } },
    }));
    expect(
      getVortexPath("documents", oblivion, { path: root, environment: { WINEPREFIX: moved.pfx } }),
    ).toBe(moved.documents);
  });

  it("never substitutes the active game's prefix for another game's paths", () => {
    game("oblivion");
    game("skyrimse");
    const oblivion = prefix("oblivion");
    const skyrim = prefix("skyrim");
    const discovery = (id: string) => ({
      path: path.join(root, id),
      environment: { WINEPREFIX: id === "oblivion" ? oblivion.pfx : skyrim.pfx },
    });
    setGameUserPathContext((value) => ({ discovery: discovery(value.id) }));
    expect(iniFiles("oblivion", discovery("oblivion"))[0]).toContain(oblivion.documents);
    expect(iniFiles("skyrimse", discovery("skyrimse"))[0]).toContain(skyrim.documents);
  });

  it("leaves native Linux game directories on the host", () => {
    const native = game("factorio", "bin/x64/factorio");
    setGameUserPathContext(() => ({ discovery: { path: root } }));
    expect(getVortexPath("documents", native)).toBe(ApplicationData.instance.paths.documents);
    expect(getVortexPath("home", native)).toBe(ApplicationData.instance.paths.home);
  });

  it("reports a missing Windows prefix instead of writing into Linux Documents", () => {
    const windows = game("oblivion");
    setGameUserPathContext(() => ({ discovery: { path: root } }));
    expect(() => getVortexPath("documents", windows)).toThrow(/Wine\/Proton/);
  });

  it("leaves native Windows behaviour unchanged", () => {
    const windows = game("oblivion");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(getVortexPath("documents", windows)).toBe(ApplicationData.instance.paths.documents);
  });

  it("routes legacy game-extension calls through their owner without changing host application calls", () => {
    const oblivion = game("oblivion");
    const installed = prefix("oblivion");
    setGameUserPathContext(() => ({
      discovery: { path: root, environment: { WINEPREFIX: installed.pfx } },
    }));
    const owner = vi.fn(() => oblivion);
    const extensionPath = makeGamePathGetter(owner);
    expect(extensionPath("documents")).toBe(installed.documents);
    owner.mockClear();
    expect(extensionPath("userData")).toBe(ApplicationData.instance.paths.userData);
    expect(owner).not.toHaveBeenCalled();
    expect(getVortexPath("documents")).toBe(ApplicationData.instance.paths.documents);
  });

  it("resolves an extension's game at call time and honours an explicit different game", () => {
    const oblivion = game("oblivion");
    const skyrim = game("skyrimse");
    const prefixes = { oblivion: prefix("oblivion"), skyrimse: prefix("skyrim") };
    let owner: IGame | undefined;
    const extensionPath = makeGamePathGetter(() => owner);
    expect(extensionPath("documents")).toBe(ApplicationData.instance.paths.documents);
    setGameUserPathContext((value) => ({
      discovery: { path: root, environment: { WINEPREFIX: prefixes[value.id].pfx } },
    }));
    owner = oblivion;
    expect(extensionPath("documents")).toBe(prefixes.oblivion.documents);
    expect(extensionPath("documents", skyrim)).toBe(prefixes.skyrimse.documents);
  });
});
