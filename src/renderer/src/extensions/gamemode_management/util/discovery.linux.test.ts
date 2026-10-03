import { mkdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { extractIconToFile } from "icon-extract";
import { describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../../test-utils/tempDir";
import type { IGame } from "../../../types/IGame";
import type { ITool } from "../../../types/ITool";
import type { IDiscoveryResult } from "../types/IDiscoveryResult";
import { assertToolDir, discoverRelativeTools, quickDiscovery, searchDiscovery } from "./discovery";

const icon = vi.hoisted(() => ({ path: "" }));
vi.mock("icon-extract", () => ({ extractIconToFile: vi.fn(async () => undefined) }));
vi.mock("../../../util/StarterInfo", () => ({
  default: { toolIconRW: () => icon.path },
}));
vi.mock("./getGame", () => ({
  getGame: vi.fn(),
  getGameStores: () => [],
  getGameStoresSafe: () => [],
}));

async function installation(): Promise<string> {
  const root = await makeTempDir("vortex-discovery-linux-");
  icon.path = path.join(root, "icons", "tool.png");
  await mkdir(path.join(root, "Binaries", "Win64"), { recursive: true });
  await mkdir(path.join(root, "Data"));
  await writeFile(path.join(root, "Binaries", "Win64", "Game.exe"), "game");
  await writeFile(path.join(root, "Data", "marker.txt"), "data");
  return root;
}

function tool(overrides: Partial<ITool> = {}): ITool {
  return {
    id: "nested-tool",
    name: "Nested tool",
    executable: () => "Binaries\\Win64\\Game.exe",
    requiredFiles: ["Binaries\\Win64\\Game.exe", "Data\\marker.txt"],
    ...overrides,
  };
}

function game(overrides: Partial<IGame> = {}): IGame {
  return {
    ...tool(),
    id: "nested-game",
    name: "Nested game",
    queryModPath: () => "Data",
    ...overrides,
  } as IGame;
}

describe.skipIf(process.platform !== "linux")("Linux game extension paths", () => {
  it.each(["Binaries\\Win64\\Game.exe", "Binaries/Win64\\Game.exe"])(
    "accepts existing required files using %s",
    async (required) => {
      const root = await installation();
      expect(
        await assertToolDir(tool({ requiredFiles: [required, "Data\\marker.txt"] }), root),
      ).toBe(root);
    },
  );

  it("still rejects a missing required file", async () => {
    const root = await installation();
    await expect(
      assertToolDir(tool({ requiredFiles: ["Binaries\\Win64\\Absent.exe"] }), root),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves Linux filename casing", async () => {
    const root = await installation();
    await expect(
      assertToolDir(tool({ requiredFiles: ["binaries/Win64/Game.exe"] }), root),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records a queried tool with a usable native executable path", async () => {
    const root = await installation();
    const onTool = vi.fn();
    await quickDiscovery(
      [game({ supportedTools: [tool({ queryPath: () => root, logo: "auto" })] })],
      {},
      vi.fn(),
      onTool,
    );
    expect(onTool).toHaveBeenCalledOnce();
    const discovered = onTool.mock.calls[0][1];
    expect(discovered.path).toBe(path.join(root, "Binaries", "Win64", "Game.exe"));
    expect((await stat(discovered.path)).isFile()).toBe(true);
    expect(extractIconToFile).toHaveBeenCalledWith(discovered.path, icon.path);
  });

  it("records a game executable selected for a discovered installation", async () => {
    const root = await installation();
    const onGame = vi.fn();
    await quickDiscovery(
      [
        game({
          queryPath: () => root,
          executable: (directory) =>
            directory === undefined ? "Launcher.exe" : "Binaries\\Win64\\Game.exe",
        }),
      ],
      {},
      onGame,
      vi.fn(),
    );
    expect(onGame).toHaveBeenCalledWith("nested-game", {
      path: root,
      store: undefined,
      executable: path.join("Binaries", "Win64", "Game.exe"),
    });
  });

  it("finds a relative tool through a real directory walk", async () => {
    const root = await installation();
    const onTool = vi.fn();
    await discoverRelativeTools(
      game({
        supportedTools: [tool({ relative: true, requiredFiles: ["Binaries\\Win64\\Game.exe"] })],
      }),
      root,
      {},
      onTool,
      (input) => input,
    );
    await vi.waitFor(() => expect(onTool).toHaveBeenCalledOnce());
    expect(onTool.mock.calls[0][1].path).toBe(path.join(root, "Binaries", "Win64", "Game.exe"));
  });

  it("finds an undiscovered game through a real directory search", async () => {
    const root = await installation();
    const onGame = vi.fn((_id: string, _result: IDiscoveryResult) => undefined);
    const onError = vi.fn();
    await searchDiscovery(
      [game({ requiredFiles: ["Binaries\\Win64\\Game.exe"] })],
      {},
      [root],
      onGame,
      vi.fn(),
      onError,
      vi.fn(),
    );
    await vi.waitFor(() => expect(onGame).toHaveBeenCalledOnce());
    expect(path.resolve(onGame.mock.calls[0][1].path)).toBe(root);
    expect(onError).not.toHaveBeenCalled();
  });
});
