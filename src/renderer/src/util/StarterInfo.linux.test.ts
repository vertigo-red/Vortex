import { mkdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { IDiscoveryResult } from "../extensions/gamemode_management/types/IDiscoveryResult";
import type { IGameStored } from "../extensions/gamemode_management/types/IGameStored";
import { makeTempDir } from "../test-utils/tempDir";
import StarterInfo from "./StarterInfo";

vi.mock("../extensions/analytics/utils/modListSnapshot", () => ({ emitModListSnapshot: vi.fn() }));
vi.mock("./gameLaunchAnalytics", () => ({
  emitGameLaunched: vi.fn(),
  recordLaunchExit: vi.fn(),
}));

describe.skipIf(process.platform !== "linux")("Linux starter game paths", () => {
  it.each([false, true])(
    "resolves a nested executable (discovery override: %s)",
    async (override) => {
      const root = await makeTempDir("vortex-starter-linux-");
      const executable = path.join(root, "Binaries", "Win64", "Game.exe");
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(executable, "game");
      const game: IGameStored = {
        id: "nested-game",
        name: "Nested game",
        executable: override ? "Launcher.exe" : "Binaries\\Win64\\Game.exe",
        requiredFiles: [],
      };
      const discovery: IDiscoveryResult = {
        path: root,
        ...(override ? { executable: "Binaries\\Win64\\Game.exe" } : {}),
      };
      const starter = new StarterInfo(game, discovery);
      expect(starter.exePath).toBe(executable);
      expect(starter.workingDirectory).toBe(path.dirname(executable));
      expect((await stat(starter.exePath)).isFile()).toBe(true);
    },
  );

  it("preserves a user-selected native tool filename containing a literal backslash", async () => {
    const root = await makeTempDir("vortex-native-tool-");
    const executable = path.join(root, "native\\tool.sh");
    await writeFile(executable, "#!/bin/sh\n");
    const starter = new StarterInfo(
      { id: "game", name: "Game", executable: "Game.exe", requiredFiles: [] },
      { path: root },
      undefined,
      {
        id: "native-tool",
        name: "Native tool",
        path: executable,
        executable: () => executable,
        requiredFiles: [],
        hidden: false,
        custom: true,
      },
    );
    expect(starter.exePath).toBe(executable);
    expect((await stat(starter.exePath)).isFile()).toBe(true);
  });
});
