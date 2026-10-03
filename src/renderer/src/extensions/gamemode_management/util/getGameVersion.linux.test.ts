import { mkdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import exeVersion from "exe-version";
import { describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../../test-utils/tempDir";
import type { IGame } from "../../../types/IGame";
import { resolveGameVersion } from "./getGameVersion";

vi.mock("exe-version", () => ({ default: vi.fn(async () => "1.2.3") }));

async function installation(): Promise<string> {
  const root = await makeTempDir("vortex-version-linux-");
  await mkdir(path.join(root, "Binaries", "Win64"), { recursive: true });
  await writeFile(path.join(root, "Binaries", "Win64", "Game.exe"), "game");
  return root;
}

describe.skipIf(process.platform !== "linux")("Linux game version paths", () => {
  it.each([false, true])("reads a nested executable (discovery override: %s)", async (override) => {
    const root = await installation();
    const game = {
      executable: () => (override ? "Launcher.exe" : "Binaries\\Win64\\Game.exe"),
    } as IGame;
    expect(
      await resolveGameVersion(game, {
        path: root,
        ...(override ? { executable: "Binaries\\Win64\\Game.exe" } : {}),
      }),
    ).toBe("1.2.3");
    expect(exeVersion).toHaveBeenCalledWith(path.join(root, "Binaries", "Win64", "Game.exe"));
  });

  it("passes a usable relative path to the extension version callback", async () => {
    const root = await installation();
    const getGameVersion = vi.fn(async (directory: string, executable: string) => {
      expect(executable).toBe(path.join("Binaries", "Win64", "Game.exe"));
      expect((await stat(path.join(directory, executable))).isFile()).toBe(true);
      return "2.0.0";
    });
    const game = {
      executable: () => "Binaries\\Win64\\Game.exe",
      getGameVersion,
    } as unknown as IGame;
    expect(await resolveGameVersion(game, { path: root })).toBe("2.0.0");
    expect(getGameVersion).toHaveBeenCalledOnce();
  });
});
