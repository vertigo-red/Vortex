import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findGamePrefix, resolveGameUserPath } from "./gameUserPaths";

describe("Wine/Proton game user directories", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "vortex-prefix-paths-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function prefix(name: string, user = "steamuser") {
    const pfx = path.join(root, name, "pfx");
    const profile = path.join(pfx, "drive_c", "users", user);
    for (const folder of ["Documents", "Desktop", "AppData/Roaming", "AppData/Local"]) {
      mkdirSync(path.join(profile, ...folder.split("/")), { recursive: true });
    }
    return { pfx, profile };
  }

  function registry(pfx: string, entries: Record<string, string>, section = "User Shell Folders") {
    const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const lines = Object.entries(entries).map(([key, value]) => `"${key}"="${escape(value)}"`);
    writeFileSync(
      path.join(pfx, "user.reg"),
      `WINE REGISTRY Version 2\n[Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\${section}]\n${lines.join("\n")}\n`,
    );
  }

  it("uses the actual Steam store entry, including an external compatdata location", () => {
    const { pfx, profile } = prefix("another disk/compatdata/900883");
    const gamePath = path.join(root, "library/steamapps/common/Oblivion GOTY Deluxe");
    const options = { gamePath, steamEntries: [{ gamePath, compatDataPath: path.dirname(pfx) }] };
    expect(resolveGameUserPath("documents", options)).toBe(path.join(profile, "Documents"));
    expect(resolveGameUserPath("appData", options)).toBe(path.join(profile, "AppData/Roaming"));
    expect(resolveGameUserPath("localAppData", options)).toBe(path.join(profile, "AppData/Local"));
  });

  it("reads the matching manifest instead of a hard-coded/default Steam appid", () => {
    const steamapps = path.join(root, "library with spaces", "steamapps");
    const gamePath = path.join(steamapps, "common", "Oblivion GOTY Deluxe");
    mkdirSync(gamePath, { recursive: true });
    writeFileSync(path.join(steamapps, "appmanifest_0000.acf"), '"AppState" { broken');
    writeFileSync(
      path.join(steamapps, "appmanifest_900883.acf"),
      '"AppState" { "appid" "900883" "installdir" "Oblivion GOTY Deluxe" }',
    );
    const { pfx, profile } = prefix("library with spaces/steamapps/compatdata/900883");
    expect(findGamePrefix({ gamePath })).toBe(pfx);
    const ini = path.join(profile, "Documents/My Games/Oblivion/Oblivion.ini");
    mkdirSync(path.dirname(ini), { recursive: true });
    writeFileSync(ini, "[General]\nbUseThreadedAI=1\n");
    const found = path.join(
      resolveGameUserPath("documents", { gamePath })!,
      "My Games/Oblivion/Oblivion.ini",
    );
    expect(readFileSync(found, "utf8")).toContain("bUseThreadedAI=1");
  });

  it("keeps different games and Steam libraries in different prefixes", () => {
    const oblivion = prefix("disk one/compatdata/22330");
    const skyrim = prefix("disk two/compatdata/489830");
    for (const game of [oblivion, skyrim, oblivion]) {
      const documents = resolveGameUserPath("documents", { environment: { WINEPREFIX: game.pfx } });
      expect(documents).toBe(path.join(game.profile, "Documents"));
    }
  });

  it("honours per-game WINEPREFIX ahead of Steam metadata and a global fallback", () => {
    const selected = prefix("custom prefix", "alice");
    const steam = prefix("steam prefix");
    const gamePath = path.join(root, "games/My Game");
    expect(
      resolveGameUserPath("documents", {
        gamePath,
        environment: { WINEPREFIX: selected.pfx },
        steamEntries: [{ gamePath, compatDataPath: path.dirname(steam.pfx) }],
        defaultWinePrefix: steam.pfx,
      }),
    ).toBe(path.join(selected.profile, "Documents"));
  });

  it("supports STEAM_COMPAT_DATA_PATH overrides", () => {
    const selected = prefix("custom compatdata");
    expect(
      resolveGameUserPath("documents", {
        environment: { STEAM_COMPAT_DATA_PATH: path.dirname(selected.pfx) },
      }),
    ).toBe(path.join(selected.profile, "Documents"));
  });

  it("keeps external compatdata metadata when a game is discovered below its install root", () => {
    const selected = prefix("external compatdata");
    const install = path.join(root, "library/steamapps/common/Game");
    expect(
      resolveGameUserPath("documents", {
        gamePath: path.join(install, "bin"),
        steamEntries: [{ gamePath: install, compatDataPath: path.dirname(selected.pfx) }],
      }),
    ).toBe(path.join(selected.profile, "Documents"));
  });

  it("does not borrow a Steam prefix for a different launcher's installation", () => {
    const selected = prefix("steam compatdata");
    const gamePath = path.join(root, "games/Oblivion");
    expect(
      resolveGameUserPath("documents", {
        gamePath,
        store: "gog",
        steamEntries: [{ gamePath, compatDataPath: path.dirname(selected.pfx) }],
      }),
    ).toBeUndefined();
  });

  it("finds a standalone Wine prefix from a game under drive_c", () => {
    const selected = prefix("standalone", "alice");
    expect(
      resolveGameUserPath("documents", {
        gamePath: path.join(selected.pfx, "drive_c/GOG Games/Oblivion"),
      }),
    ).toBe(path.join(selected.profile, "Documents"));
  });

  it("honours Wine's configured Documents and AppData known folders", () => {
    const selected = prefix("wine", "alice");
    registry(selected.pfx, {
      Personal: "%USERPROFILE%\\My Documents",
      AppData: "%USERPROFILE%\\Custom Roaming",
      "Local AppData": "%USERPROFILE%\\Custom Local",
    });
    const options = { environment: { WINEPREFIX: selected.pfx } };
    expect(resolveGameUserPath("documents", options)).toBe(
      path.join(selected.profile, "My Documents"),
    );
    expect(resolveGameUserPath("appData", options)).toBe(
      path.join(selected.profile, "Custom Roaming"),
    );
    expect(resolveGameUserPath("localAppData", options)).toBe(
      path.join(selected.profile, "Custom Local"),
    );
  });

  it("supports legacy Shell Folders and case-insensitive Windows paths", () => {
    const selected = prefix("wine");
    registry(selected.pfx, { Personal: "C:\\USERS\\STEAMUSER\\documents" }, "Shell Folders");
    expect(resolveGameUserPath("documents", { environment: { WINEPREFIX: selected.pfx } })).toBe(
      path.join(selected.profile, "Documents"),
    );
  });

  it("respects a redirected known folder on another Wine drive", () => {
    const selected = prefix("wine");
    const drive = path.join(root, "data drive");
    mkdirSync(path.join(drive, "Game Documents"), { recursive: true });
    mkdirSync(path.join(selected.pfx, "dosdevices"));
    symlinkSync(drive, path.join(selected.pfx, "dosdevices/d:"), "dir");
    registry(selected.pfx, { Personal: "D:\\Game Documents" });
    const documents = resolveGameUserPath("documents", {
      environment: { WINEPREFIX: selected.pfx },
    });
    expect(documents).toBe(path.join(selected.pfx, "dosdevices/d:/Game Documents"));
  });

  it("does not cache missing prefixes before the game's first launch", () => {
    const pfx = path.join(root, "new game/pfx");
    const options = { environment: { WINEPREFIX: pfx } };
    expect(resolveGameUserPath("documents", options)).toBeUndefined();
    const launched = prefix("new game");
    expect(resolveGameUserPath("documents", options)).toBe(
      path.join(launched.profile, "Documents"),
    );
  });

  it("reloads Wine registry mappings when the user changes a known folder", () => {
    const selected = prefix("wine");
    registry(selected.pfx, { Personal: "%USERPROFILE%\\First" });
    const options = { environment: { WINEPREFIX: selected.pfx } };
    expect(resolveGameUserPath("documents", options)).toBe(path.join(selected.profile, "First"));
    registry(selected.pfx, { Personal: "%USERPROFILE%\\Another Location" });
    expect(resolveGameUserPath("documents", options)).toBe(
      path.join(selected.profile, "Another Location"),
    );
  });

  it("does not guess between multiple Wine users", () => {
    const selected = prefix("wine", "alice");
    mkdirSync(path.join(selected.pfx, "drive_c/users/bob"));
    expect(
      resolveGameUserPath("documents", { environment: { WINEPREFIX: selected.pfx } }),
    ).toBeUndefined();
  });
});
