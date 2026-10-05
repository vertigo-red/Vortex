import { writeFile } from "node:fs/promises";
import * as path from "node:path";

import exeVersion from "exe-version";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../../test-utils/tempDir";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import { SharedDelegates } from "./SharedDelegates";

vi.mock("exe-version", () => ({ default: vi.fn(() => "") }));
vi.mock("../../gamemode_management/util/getGame", () => ({
  getGame: () => ({ getInstalledVersion: async () => "1.9.32.0" }),
}));

describe("FOMOD script extender dependencies", () => {
  let root: string;
  const delegates = (gameId = "skyrim") =>
    SharedDelegates.create(
      {
        getState: () => ({ settings: { gameMode: { discovered: { [gameId]: { path: root } } } } }),
      } as unknown as IExtensionApi,
      gameId,
    );

  beforeEach(async () => {
    vi.mocked(exeVersion).mockReset().mockReturnValue("");
    root = await makeTempDir("vortex-fomod-extender-");
  });

  it("reports absent SKSE even when TESV has a game version", async () => {
    const shared = await delegates();
    expect(shared.getCurrentGameVersion()).toBe("1.9.32.0");
    expect(shared.getExtenderVersion("skse")).toBe("");
  });

  it("reads the installed LE loader and removes the leading version zero", async () => {
    const executable = path.join(root, "skse_loader.exe");
    await writeFile(executable, "loader");
    vi.mocked(exeVersion).mockReturnValue("0.1.7.3");
    expect((await delegates()).getExtenderVersion("SKSE")).toBe("1.7.3");
    expect(exeVersion).toHaveBeenCalledExactlyOnceWith(executable);
  });

  it.skipIf(process.platform !== "linux")(
    "finds the loader with different filename casing",
    async () => {
      const executable = path.join(root, "SKSE_LOADER.EXE");
      await writeFile(executable, "loader");
      vi.mocked(exeVersion).mockReturnValue("0.1.7.3");
      expect((await delegates()).getExtenderVersion("skse")).toBe("1.7.3");
      expect(exeVersion).toHaveBeenCalledExactlyOnceWith(executable);
    },
  );

  it("maps the FOMOD skse ID to SKSE64 only for Special Edition", async () => {
    const executable = path.join(root, "skse64_loader.exe");
    await writeFile(executable, "loader");
    vi.mocked(exeVersion).mockReturnValue("0.2.2.6");
    expect((await delegates("skyrimse")).getExtenderVersion("skse")).toBe("2.2.6");
    expect(exeVersion).toHaveBeenCalledExactlyOnceWith(executable);
  });

  it("returns no version for unknown extenders or requests for another Skyrim edition", async () => {
    const shared = await delegates();
    expect(shared.getExtenderVersion("../TESV")).toBe("");
    expect(shared.getExtenderVersion("skse64")).toBe("");
    expect(exeVersion).not.toHaveBeenCalled();
  });

  it("does not substitute the game version when a loader cannot be parsed", async () => {
    const shared = await delegates();
    vi.mocked(exeVersion).mockReturnValue("invalid");
    expect(shared.getExtenderVersion("skse")).toBe("");
    vi.mocked(exeVersion).mockImplementation(() => {
      throw new Error("damaged resource");
    });
    expect(shared.getExtenderVersion("skse")).toBe("");
  });
});
