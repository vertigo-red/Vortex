import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, vi } from "vitest";

import { makeMod, makeProfile, registerHarnessGame } from "../../test-utils/builders";
import { test } from "../../test-utils/deploymentTest";
import { makeTempDir } from "../../test-utils/tempDir";
import { ProcessCanceled } from "../../util/CustomErrors";
import deployMods from "../mod_management/modActivation";
import type { IDeployedFile } from "../mod_management/types/IDeploymentMethod";
import BlacklistSet from "../mod_management/util/BlacklistSet";
import GameModeManager from "./GameModeManager";
import { getGame } from "./util/getGame";

describe.skipIf(process.platform !== "linux")("Linux mod directory selection", () => {
  for (const [declared, existing, absolute] of [
    ["Data", "Data", false],
    ["Data", "data", false],
    ["Data", "dAtA", false],
    ["Assets\\Data", "assets/data", false],
    ["Assets/Data", "assets/data", false],
    ["Assets/Data", "assets/data", true],
    ["Assets\\Data", "assets/data", true],
    [".", ".", false],
    ["", ".", false],
  ] as const) {
    test(`activates ${existing} declared as ${declared || "empty"} (absolute: ${absolute})`, async ({
      makeApi,
    }) => {
      const root = await makeTempDir("vortex-mode-linux-");
      const gamePath = path.join(root, "Игра with spaces");
      const modPath = path.join(gamePath, existing);
      await mkdir(modPath, { recursive: true });
      await writeFile(path.join(gamePath, "TESV.exe"), "game");
      await writeFile(path.join(modPath, "Skyrim.esm"), "vanilla");
      registerHarnessGame("skyrim");
      const game = getGame("skyrim");
      game.queryModPath = () => (absolute ? path.join(gamePath, declared) : declared);
      game.executable = () => "TESV.exe";
      game.requiredFiles = ["TESV.exe"];
      const h = makeApi({
        discovered: { skyrim: { path: gamePath } },
        profiles: { profile: makeProfile({ id: "profile", gameId: "skyrim" }) },
        activeProfileId: "profile",
      });
      const activated = vi.fn();
      const manager = new GameModeManager(h.api, [game], [], activated);
      manager.attachToStore(h.api.store);

      await expect(manager.setGameMode(undefined, "skyrim", "profile")).resolves.toBeUndefined();
      expect(activated).toHaveBeenCalledExactlyOnceWith("skyrim");
      expect(game.getModPaths(gamePath)[""]).toBe(modPath);
      expect(await readFile(path.join(modPath, "Skyrim.esm"), "utf8")).toBe("vanilla");
      expect(await readdir(gamePath)).toEqual(
        (existing === "."
          ? ["Skyrim.esm", "TESV.exe"]
          : [existing.split("/")[0], "TESV.exe"]
        ).sort(),
      );
      expect(h.runExecutableCalls).toEqual([]);
    });
  }

  test("deploys and removes a Skyrim LE mod in the same existing lowercase data directory", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ gameId: "skyrim", files: { "textures/armor.dds": "mod" } });
    const root = path.dirname(h.gameDir);
    const data = path.join(root, "data");
    await rename(h.gameDir, data);
    await writeFile(path.join(root, "TESV.exe"), "game");
    await mkdir(path.join(data, "Textures"));
    const vanilla = path.join(data, "Textures", "Armor.dds");
    await writeFile(vanilla, "vanilla");
    const game = getGame("skyrim");
    game.queryModPath = () => "Data";
    game.executable = () => "TESV.exe";
    game.requiredFiles = ["TESV.exe"];
    h.setState((state) => {
      state.settings.gameMode.discovered.skyrim = { path: root };
      state.persistent.profiles.profile = makeProfile({ id: "profile", gameId: "skyrim" });
      state.settings.profiles.activeProfileId = "profile";
    });
    const activated = vi.fn();
    const manager = new GameModeManager(h.api, [game], [], activated);
    manager.attachToStore(h.api.store);
    await manager.setGameMode(undefined, "skyrim", "profile");
    const destination = game.getModPaths(root)[""];
    expect(destination).toBe(data);
    const deploy = (enabled: boolean, previous: IDeployedFile[] = []) =>
      deployMods(
        h.api,
        "skyrim",
        h.stagingDir,
        destination,
        enabled ? [makeMod({ id: "SomeMod", installationPath: "SomeMod" })] : [],
        h.method,
        previous,
        "",
        new BlacklistSet([], game, h.normalize),
        () => "",
      );

    const manifest = await deploy(true);
    expect(manifest).toHaveLength(1);
    expect(await readFile(vanilla, "utf8")).toBe("mod");
    const staged = path.join(h.stagingDir, "SomeMod", "textures", "armor.dds");
    const sourceStats = await lstat(staged);
    const deployedStats = await lstat(vanilla);
    expect([deployedStats.dev, deployedStats.ino]).toEqual([sourceStats.dev, sourceStats.ino]);
    expect(await h.method.externalChanges("skyrim", h.stagingDir, destination, manifest)).toEqual(
      [],
    );
    expect(await deploy(false, manifest)).toEqual([]);
    expect(await readFile(vanilla, "utf8")).toBe("vanilla");
    expect(await readFile(staged, "utf8")).toBe("mod");
    expect(await readdir(root)).toEqual(["TESV.exe", "data"]);
    expect(await readdir(path.dirname(vanilla))).toEqual(["Armor.dds"]);
    expect(h.runExecutableCalls).toEqual([]);
  });

  test("rejects an unresolved case collision before activation and permits retry", async ({
    makeApi,
  }) => {
    const root = await makeTempDir("vortex-mode-linux-");
    await mkdir(path.join(root, "Data"));
    await mkdir(path.join(root, "data"));
    await writeFile(path.join(root, "TESV.exe"), "game");
    registerHarnessGame("skyrim");
    const game = getGame("skyrim");
    game.queryModPath = () => "DATA";
    game.executable = () => "TESV.exe";
    game.requiredFiles = ["TESV.exe"];
    const h = makeApi({
      discovered: { skyrim: { path: root } },
      profiles: { profile: makeProfile({ id: "profile", gameId: "skyrim" }) },
      activeProfileId: "profile",
    });
    const activated = vi.fn();
    const manager = new GameModeManager(h.api, [game], [], activated);
    manager.attachToStore(h.api.store);

    await expect(manager.setGameMode(undefined, "skyrim", "profile")).rejects.toBeInstanceOf(
      ProcessCanceled,
    );
    expect(activated).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["Data", "TESV.exe", "data"]);
    await rm(path.join(root, "data"), { recursive: true });
    await expect(manager.setGameMode(undefined, "skyrim", "profile")).resolves.toBeUndefined();
    expect(activated).toHaveBeenCalledExactlyOnceWith("skyrim");
    expect(game.getModPaths(root)[""]).toBe(path.join(root, "Data"));
  });

  test("keeps a missing data directory as a setup error instead of creating it", async ({
    makeApi,
  }) => {
    const root = await makeTempDir("vortex-mode-linux-");
    await writeFile(path.join(root, "TESV.exe"), "game");
    registerHarnessGame("skyrim");
    const game = getGame("skyrim");
    game.queryModPath = () => "Data";
    game.executable = () => "TESV.exe";
    game.requiredFiles = ["TESV.exe"];
    const h = makeApi({ discovered: { skyrim: { path: root } } });
    const activated = vi.fn();
    const manager = new GameModeManager(h.api, [game], [], activated);
    manager.attachToStore(h.api.store);

    await expect(manager.setGameMode(undefined, "skyrim", "profile")).rejects.toThrow("Missing:");
    expect(activated).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["TESV.exe"]);
  });

  test("preserves directory casing for a native Linux game", async ({ makeApi }) => {
    const root = await makeTempDir("vortex-mode-linux-");
    await mkdir(path.join(root, "data"));
    await writeFile(path.join(root, "native-game"), "game");
    registerHarnessGame("native");
    const game = getGame("native");
    game.queryModPath = () => "Data";
    game.executable = () => "native-game";
    game.requiredFiles = ["native-game"];
    const h = makeApi({ discovered: { native: { path: root } } });
    const activated = vi.fn();
    const manager = new GameModeManager(h.api, [game], [], activated);
    manager.attachToStore(h.api.store);

    expect(game.getModPaths(root)[""]).toBe(path.join(root, "Data"));
    await expect(manager.setGameMode(undefined, "native", "profile")).rejects.toThrow("Missing:");
    expect(activated).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["data", "native-game"]);
  });
});
