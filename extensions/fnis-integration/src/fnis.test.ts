import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { fs, util } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import runFNIS, { calcChecksum, fnisDataMod } from "./fnis";

vi.mock("winapi-bindings", () => ({ GetProcessWindowList: vi.fn(), SetForegroundWindow: vi.fn() }));

let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "vortex-fnis-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("animation checksums on case-sensitive filesystems", () => {
  it("handles a deployment with no default mod files", async () => {
    expect((await calcChecksum(path.join(root, "Data"), {})).mods).toEqual([]);
  });
  it.each(["/", "\\"])(
    "reads deployed animation files with %s separators from the declared Data directory",
    async (separator) => {
      const data = path.join(root, "Data");
      const relative = ["meshes", "actors", "character", "animations", "Custom.HKX"];
      const animation = path.join(data, ...relative);
      await mkdir(path.dirname(animation), { recursive: true });
      await writeFile(animation, "before");
      const deployment = {
        "": [{ relPath: relative.join(separator), source: "animation-mod" }],
      } as any;
      const before = await calcChecksum(data, deployment);
      await writeFile(animation, "after");
      const after = await calcChecksum(data, deployment);
      expect(after.checksum).not.toBe(before.checksum);
      expect(after.mods).toEqual(["animation-mod"]);
      await rm(animation);
      expect((await calcChecksum(data, deployment)).checksum).not.toBe(after.checksum);
    },
  );

  it("tracks skeletons and FNIS lists while ignoring unrelated files", async () => {
    const data = path.join(root, "Data");
    const paths = [
      "FNIS_Custom_List.txt",
      "FNIS_CustomBehavior.txt",
      "PatchList.txt",
      "skeleton_female.hkx",
      "texture.dds",
    ];
    await mkdir(data);
    for (const filename of paths) await writeFile(path.join(data, filename), "before");
    const deployment = { "": paths.map((relPath) => ({ relPath, source: relPath })) } as any;
    const before = await calcChecksum(data, deployment);
    expect(before.mods).toEqual(paths.slice(0, -1));
    await writeFile(path.join(data, "texture.dds"), "unrelated change");
    expect((await calcChecksum(data, deployment)).checksum).toBe(before.checksum);
    for (const filename of paths.slice(0, -1)) {
      const previous = await calcChecksum(data, deployment);
      await writeFile(path.join(data, filename), "changed");
      expect((await calcChecksum(data, deployment)).checksum).not.toBe(previous.checksum);
    }
  });
});

async function launchFixture() {
  const tool = path.join(
    root,
    "Game",
    "Data",
    "tools",
    "GenerateFNIS_for_Users",
    "GenerateFNISforUsers.exe",
  );
  await mkdir(path.dirname(tool), { recursive: true });
  await writeFile(tool, "fixture");
  await writeFile(path.join(path.dirname(tool), "MyPatches.txt"), "old patch");
  const profile = { id: "profile", name: "日本語 ! %NAME%", gameId: "skyrimse" } as any;
  const modId = fnisDataMod(profile.name);
  const staging = path.join(root, "Staging directory");
  const discovery = {
    path: path.join(root, "Game"),
    store: "steam",
    tools: { fnis: { path: tool } },
  };
  const state = {
    settings: {
      gameMode: { discovered: { skyrimse: discovery } },
      mods: { installPath: { skyrimse: staging } },
      fnis: { patches: { profile: ["Gender"] } },
    },
    persistent: { mods: { skyrimse: { [modId]: { installationPath: modId } } } },
  };
  const api = {
    store: { getState: () => state, dispatch: vi.fn() },
    runExecutable: vi.fn(async (_exe, _args, options) => {
      options.onExit?.(0);
    }),
  } as any;
  const mappedOutput = "D:\\Mods\\FNIS Data (日本語 ! %NAME%)";
  vi.mocked(util.getProtonToolCommand).mockResolvedValue({
    executable: path.join(root, "Chosen Proton", "proton"),
    args: ["run", "C:\\Game\\Data\\tools\\GenerateFNISforUsers.exe", mappedOutput],
    env: {
      STEAM_COMPAT_DATA_PATH: path.join(root, "secondary library", "compatdata", "489830"),
      SteamAppId: "489830",
    },
  });
  return { api, profile, staging, modId, discovery, tool, mappedOutput };
}

describe.skipIf(process.platform !== "linux")("FNIS launches", () => {
  it.each([true, false])(
    "uses the game's prepared Proton launch and a literal redirect path (interactive=%s)",
    async (interactive) => {
      const f = await launchFixture();
      await runFNIS(f.api, f.profile, interactive);
      expect(util.getProtonToolCommand).toHaveBeenCalledWith(
        f.tool,
        [{ path: path.join(f.staging, f.modId) }],
        f.discovery,
      );
      expect(f.api.runExecutable).toHaveBeenCalledWith(
        path.join(root, "Chosen Proton", "proton"),
        [
          "run",
          "C:\\Game\\Data\\tools\\GenerateFNISforUsers.exe",
          `RedirectFiles=${f.mappedOutput}`,
          ...(interactive ? [] : ["InstantExecute=1"]),
        ],
        expect.objectContaining({
          cwd: path.dirname(f.tool),
          shell: false,
          suggestDeploy: false,
          expectSuccess: true,
          env: expect.objectContaining({ SteamAppId: "489830" }),
        }),
      );
    },
  );

  it("keeps patches and mod state intact when the selected Proton or drive mapping is unavailable", async () => {
    const f = await launchFixture();
    const error = new util.ProcessCanceled("No Wine drive maps staging");
    vi.mocked(util.getProtonToolCommand).mockRejectedValue(error);
    await expect(runFNIS(f.api, f.profile, false)).rejects.toBe(error);
    expect(f.api.runExecutable).not.toHaveBeenCalled();
    expect(f.api.store.dispatch).not.toHaveBeenCalled();
    expect(fs.writeFileAsync).not.toHaveBeenCalled();
    expect(fs.removeAsync).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 53])(
    "rejects an unsuccessful/canceled launch with exit code %s",
    async (code) => {
      const f = await launchFixture();
      f.api.runExecutable.mockImplementation(async (_exe, _args, options) => {
        if (code !== undefined) options.onExit(code);
      });
      await expect(runFNIS(f.api, f.profile, false)).rejects.toThrow(
        "FNIS did not complete successfully",
      );
    },
  );

  it("propagates a tool launch failure", async () => {
    const f = await launchFixture();
    const error = new Error("FNIS exited with failure");
    f.api.runExecutable.mockRejectedValue(error);
    await expect(runFNIS(f.api, f.profile, false)).rejects.toBe(error);
  });

  it("retains the existing Windows command and quote handling", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const f = await launchFixture();
    await runFNIS(f.api, f.profile, false);
    expect(util.getProtonToolCommand).not.toHaveBeenCalled();
    expect(f.api.runExecutable).toHaveBeenCalledWith(
      f.tool,
      [`RedirectFiles="${path.join(f.staging, f.modId)}"`, "InstantExecute=1"],
      expect.objectContaining({ suggestDeploy: false }),
    );
  });
});
