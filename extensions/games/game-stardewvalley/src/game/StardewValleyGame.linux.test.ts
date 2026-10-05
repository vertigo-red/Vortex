import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  linuxInstallDatEntries,
  smapiInstallerArchiveEntries,
  walkArchiveEntries,
  windowsInstallDatEntries,
} from "../installers/smapi/fixtures/archiveListings";
import {
  extractFullMock,
  fs,
  resetVortexApiMocks,
  walkMock,
} from "../installers/smapi/fixtures/vortexApi.mock";
import { registerInstallers } from "../registration/registerInstallers";
import { registerModTypes } from "../registration/registerModTypes";
import { findSMAPIMod } from "../smapi/selectors";
import { resolveGameExecutable, resolveGamePlatform } from "./runtime";
import StardewValleyGame from "./StardewValleyGame";

vi.mock("../smapi/selectors", () => ({ findSMAPIMod: vi.fn() }));
vi.mock("../smapi/lifecycle", () => ({ deploySMAPI: vi.fn() }));
vi.mock("../smapi/workflow", () => ({ downloadAndInstallSMAPI: vi.fn() }));

describe.skipIf(process.platform !== "linux")("Stardew Valley installations on Linux", () => {
  let root: string;
  let context: types.IExtensionContext;
  let sendNotification: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "vortex-stardew-linux-"));
    resetVortexApiMocks();
    vi.mocked(findSMAPIMod).mockReturnValue(undefined);
    Object.assign(fs, {
      statAsync: stat,
      ensureDirWritableAsync: (directory: string) => mkdir(directory, { recursive: true }),
    });
    sendNotification = vi.fn();
    context = { api: { sendNotification } } as unknown as types.IExtensionContext;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function installDirectory(
    directory: string,
    launcher: "StardewValley" | "Stardew Valley.exe",
  ): Promise<string> {
    const gamePath = path.join(root, directory);
    await mkdir(gamePath, { recursive: true });
    await writeFile(path.join(gamePath, "Stardew Valley.dll"), "game assembly");
    await writeFile(path.join(gamePath, "Stardew Valley.deps.json"), '{"deps":true}');
    await writeFile(path.join(gamePath, launcher), "launcher");
    return gamePath;
  }

  test.each(["123", "stardew-valley"])(
    "accepts the Windows GOG installation in Faugus/%s",
    async (prefix) => {
      const gamePath = await installDirectory(
        `Faugus/${prefix}/drive_c/GOG Games/Stardew Valley`,
        "Stardew Valley.exe",
      );
      const game = new StardewValleyGame(context);

      // These are the files the folder picker, disk search, and rediscovery
      // validate, independent of the host's default launcher metadata.
      for (const requiredFile of game.requiredFiles) {
        expect((await stat(path.join(gamePath, requiredFile))).isFile()).toBe(true);
      }
      expect(game.requiredFiles).not.toContain("StardewValley");
      expect(game.executable(gamePath)).toBe("Stardew Valley.exe");
      expect(resolveGamePlatform(gamePath)).toBe("win32");
      expect(game.executable()).toBe("StardewValley");
    },
  );

  test("accepts a native installation and preserves its launcher", async () => {
    const gamePath = await installDirectory("GOG Games/Stardew Valley/game", "StardewValley");
    const game = new StardewValleyGame(context);
    for (const requiredFile of game.requiredFiles) {
      expect((await stat(path.join(gamePath, requiredFile))).isFile()).toBe(true);
    }
    expect(game.executable(gamePath)).toBe("StardewValley");
    expect(resolveGamePlatform(gamePath)).toBe("linux");
  });

  test("prefers the native launcher when a Windows executable also exists", async () => {
    const gamePath = await installDirectory("native", "StardewValley");
    await writeFile(path.join(gamePath, "Stardew Valley.exe"), "legacy or extra launcher");
    expect(resolveGameExecutable(gamePath)).toBe("StardewValley");
    expect(resolveGamePlatform(gamePath)).toBe("linux");
  });

  test("resolves symlinked installations and does not cache another prefix", async () => {
    const windowsPath = await installDirectory("prefix one/game", "Stardew Valley.exe");
    const nativePath = await installDirectory("native", "StardewValley");
    const linkedPath = path.join(root, "linked game");
    await symlink(windowsPath, linkedPath);
    const game = new StardewValleyGame(context);
    expect(game.executable(linkedPath)).toBe("Stardew Valley.exe");
    expect(game.executable(nativePath)).toBe("StardewValley");
    expect(game.executable(windowsPath)).toBe("Stardew Valley.exe");
  });

  test("rejects a launcher-only directory without the game assembly", async () => {
    await writeFile(path.join(root, "Stardew Valley.exe"), "unrelated launcher");
    const game = new StardewValleyGame(context);
    await expect(stat(path.join(root, game.requiredFiles[0]!))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects a missing launcher instead of guessing the runtime", async () => {
    await writeFile(path.join(root, "Stardew Valley.dll"), "game assembly");
    expect(() => resolveGamePlatform(root)).toThrow("Stardew Valley launcher not found");
  });

  test("does not accept a directory or differently cased name as the launcher", async () => {
    await mkdir(path.join(root, "StardewValley"));
    await writeFile(path.join(root, "stardew valley.exe"), "launcher");
    expect(() => resolveGamePlatform(root)).toThrow("Stardew Valley launcher not found");
  });

  test.each([
    ["Stardew Valley.exe", "StardewModdingAPI.exe"],
    ["StardewValley", "StardewModdingAPI"],
  ] as const)("discovers and checks SMAPI for %s", async (launcher, smapiLauncher) => {
    const gamePath = await installDirectory("game", launcher);
    await writeFile(path.join(gamePath, "StardewModdingAPI.dll"), "SMAPI assembly");
    await writeFile(path.join(gamePath, smapiLauncher), "SMAPI launcher");
    const game = new StardewValleyGame(context);
    const tool = game.supportedTools[0];

    expect(tool.executable(gamePath)).toBe(smapiLauncher);
    await Promise.resolve(game.setup({ path: gamePath }));
    expect(sendNotification).not.toHaveBeenCalled();
    expect((await stat(path.join(gamePath, "Mods"))).isDirectory()).toBe(true);
  });

  test("does not reuse native SMAPI for a Windows installation", async () => {
    const gamePath = await installDirectory("prefix/game", "Stardew Valley.exe");
    await writeFile(path.join(gamePath, "StardewModdingAPI.dll"), "SMAPI assembly");
    await writeFile(path.join(gamePath, "StardewModdingAPI"), "wrong runtime");
    const game = new StardewValleyGame(context);

    expect(() => game.supportedTools[0].executable(gamePath)).toThrow("SMAPI launcher not found");
    await Promise.resolve(game.setup({ path: gamePath }));
    expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ id: "smapi-missing" }));
    expect(findSMAPIMod).toHaveBeenCalledWith(context.api, "windows");
  });

  test.each([
    ["Stardew Valley.exe", "windows", "StardewModdingAPI.exe", windowsInstallDatEntries],
    ["StardewValley", "linux", "StardewModdingAPI", linuxInstallDatEntries],
  ] as const)(
    "registered installer and mod type use the selected %s runtime",
    async (launcher, platformFolder, smapiLauncher, payload) => {
      const gamePath = await installDirectory("selected game", launcher);
      const staging = path.join(root, "staging");
      const registerInstaller = vi.fn();
      const registerModType = vi.fn();
      const registrationContext = {
        registerInstaller,
        registerModType,
      } as unknown as types.IExtensionContext;
      walkMock.mockImplementation(async (_destination, callback) => {
        await walkArchiveEntries(staging, [...smapiInstallerArchiveEntries, ...payload], callback);
      });

      registerInstallers(registrationContext, () => gamePath);
      const install = registerInstaller.mock.calls.find(([id]) => id === "smapi-installer")![3];
      const result = await install(smapiInstallerArchiveEntries, staging);
      expect(extractFullMock).toHaveBeenCalledWith(
        path.join(staging, "internal", platformFolder, "install.dat"),
        staging,
      );
      expect(result.instructions).toContainEqual({
        type: "copy",
        source: smapiLauncher,
        destination: smapiLauncher,
      });
      expect(result.instructions).toContainEqual({
        type: "attribute",
        key: "smapiPlatform",
        value: platformFolder,
      });

      registerModTypes(
        registrationContext,
        () => gamePath,
        () => gamePath,
      );
      const classify = registerModType.mock.calls.find(([id]) => id === "SMAPI")![4];
      await expect(classify(result.instructions)).resolves.toBe(true);
      const otherLauncher =
        platformFolder === "windows" ? "StardewModdingAPI" : "StardewModdingAPI.exe";
      await expect(classify([{ type: "copy", source: otherLauncher }])).resolves.toBe(false);
    },
  );

  test("preserves Windows and macOS defaults outside Linux", () => {
    expect(resolveGameExecutable(root, "win32")).toBe("Stardew Valley.exe");
    expect(resolveGamePlatform(root, "win32")).toBe("win32");
    expect(resolveGameExecutable(root, "darwin")).toBe("StardewValley");
    expect(resolveGamePlatform(root, "darwin")).toBe("darwin");
  });
});
