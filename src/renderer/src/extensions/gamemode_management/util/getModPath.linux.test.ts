import type * as fs from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../../test-utils/tempDir";
import type { IGame } from "../../../types/IGame";
import type * as modPaths from "./getModPath";

const disk: typeof fs = createRequire(path.join(process.cwd(), "package.json"))("node:fs");
const readDirectory = disk.readdirSync;
const listing = vi.spyOn(disk, "readdirSync");
let getModPath: typeof modPaths.getModPath;

beforeAll(async () => {
  syncBuiltinESMExports();
  // Bind the resolver to this one spy; reloading shared errors between cases is unsafe.
  vi.resetModules();
  getModPath = (await import("./getModPath.js")).getModPath;
});

afterEach(() => {
  listing.mockImplementation(readDirectory);
  listing.mockClear();
});

afterAll(() => {
  listing.mockRestore();
  syncBuiltinESMExports();
});

describe.skipIf(process.platform !== "linux")("Selected game directory access", () => {
  it.each([false, true])(
    "resolves a mod path without listing ancestors (absolute: %s)",
    async (absolute) => {
      const root = await makeTempDir("vortex-mod-root-");
      const gamePath = path.join(root, "Игра with spaces");
      const dataPath = path.join(gamePath, "assets", "data");
      await mkdir(dataPath, { recursive: true });
      listing.mockImplementation(((directory: string) => {
        if (directory === path.parse(gamePath).root || gamePath.startsWith(directory + path.sep)) {
          throw Object.assign(new Error("Ancestor is not readable"), { code: "EACCES" });
        }
        return readDirectory(directory);
      }) as typeof fs.readdirSync);
      const game: IGame = {
        id: "skyrim",
        name: "Skyrim",
        requiredFiles: ["TESV.exe"],
        executable: () => "TESV.exe",
        queryModPath: () => (absolute ? path.join(gamePath, "ASSETS", "DATA") : "ASSETS\\DATA"),
      };

      expect(getModPath(game, gamePath)).toBe(dataPath);
      expect(listing).toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps an external mod destination without listing its ancestors (absolute: %s)",
    async (absolute) => {
      const root = await makeTempDir("vortex-mod-external-");
      const gamePath = path.join(root, "game");
      const parent = path.join(root, "Private");
      const mods = path.join(parent, "mods");
      await mkdir(gamePath);
      await mkdir(mods, { recursive: true });
      listing.mockImplementation(((directory: string) => {
        if (directory === path.parse(parent).root || parent.startsWith(directory + path.sep)) {
          throw Object.assign(new Error("Ancestor is not readable"), { code: "EACCES" });
        }
        return readDirectory(directory);
      }) as typeof fs.readdirSync);
      const game: IGame = {
        id: "external-game",
        name: "External game",
        requiredFiles: ["Game.exe"],
        executable: () => "Game.exe",
        queryModPath: () => (absolute ? path.join(parent, "MODS") : "../Private/MODS"),
      };

      expect(getModPath(game, gamePath)).toBe(mods);
      expect(listing).toHaveBeenCalled();
    },
  );
});
