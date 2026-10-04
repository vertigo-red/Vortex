import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { fs, selectors, util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DivineAborted, DivineMissingDotNet } from "./divineCore";
import { abortDivineOperations, extractPak, listPackage } from "./divineWrapper";
import { deserialize } from "./loadOrder";

const fixture = vi.hoisted(() => ({
  mod: {
    id: "lslib",
    installationPath: "lslib",
    type: "bg3-lslib-divine-tool",
    attributes: { version: "1.20.4" },
  },
  getCacheEntry: vi.fn(),
  modsDirectory: "",
}));
vi.mock("./util", () => ({
  getLatestLSLibMod: () => fixture.mod,
  logError: vi.fn(),
  modsPath: () => fixture.modsDirectory,
}));
vi.mock("./cache", () => ({ default: { getInstance: () => fixture } }));
vi.mock("./divineLauncher", () => ({
  ensureDivineLauncher: (directory: string) =>
    Promise.resolve(path.join(directory, "vortex-divine-launcher.exe")),
}));

let root: string;
let api: types.IExtensionApi;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vortex-bg3-wrapper-"));
  const tools = path.join(root, "lslib", "tools");
  fixture.modsDirectory = path.join(root, "Mods");
  await mkdir(tools, { recursive: true });
  await mkdir(fixture.modsDirectory);
  await writeFile(path.join(tools, "Divine.exe"), "fixture executable");
  await writeFile(path.join(fixture.modsDirectory, "mod.pak"), "fixture PAK");
  vi.mocked(selectors.installPathForGame).mockReturnValue(root);
  vi.mocked(selectors.activeProfile).mockReturnValue({
    id: "active",
    gameId: "baldursgate3",
  } as types.IProfile);
  const state = {
    settings: {
      gameMode: { discovered: { baldursgate3: { path: path.join(root, "BG3"), store: "steam" } } },
    },
    persistent: { mods: { baldursgate3: { lslib: fixture.mod } } },
  } as unknown as types.IState;
  api = {
    getState: () => state,
    showErrorNotification: vi.fn(),
    sendNotification: vi.fn(),
    dismissNotification: vi.fn(),
  } as unknown as types.IExtensionApi;
  vi.mocked(util.getProtonToolCommand).mockImplementation(async (_executable, args) => ({
    executable: process.execPath,
    args: [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "--",
      ...args.map((arg) => (typeof arg === "string" ? arg : arg.path)),
    ],
    env: {},
  }));
});
afterEach(async () => {
  abortDivineOperations();
  vi.resetAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("BG3 Proton wrapper", () => {
  it("passes the discovered game and explicit path arguments to the core Proton launcher", async () => {
    const pak = path.join(fixture.modsDirectory, "mod.pak");
    const destination = path.join(root, "extract");
    const result = await extractPak(api, pak, destination, "*.lsx");
    expect(util.getProtonToolCommand).toHaveBeenCalledWith(
      path.join(root, "lslib", "tools", "vortex-divine-launcher.exe"),
      [
        { path: path.join(root, "lslib", "tools", "Divine.exe") },
        "--action",
        "extract-package",
        "--source",
        { path: pak },
        "--game",
        "bg3",
        "--loglevel",
        "error",
        "--destination",
        { path: destination },
        "--expression",
        "*.lsx",
      ],
      api.getState().settings.gameMode.discovered.baldursgate3,
    );
    expect(JSON.parse(result.stdout)).toContain(pak);
  });

  it("settles cancelled queued work without launching a CLI", async () => {
    const operations = Array.from({ length: 20 }, () => extractPak(api, "unused", "unused", "*"));
    abortDivineOperations();
    const settled = await Promise.allSettled(operations);
    for (const item of settled) {
      expect(item.status).toBe("rejected");
      if (item.status === "rejected") expect(item.reason).toBeInstanceOf(DivineAborted);
    }
    expect(util.getProtonToolCommand).not.toHaveBeenCalled();
  });

  it("reports the Windows runtime requirement without returning an empty package list", async () => {
    vi.mocked(util.getProtonToolCommand).mockResolvedValue({
      executable: process.execPath,
      args: [
        "-e",
        "process.stderr.write('You must install .NET to run this application.');process.exit(150)",
      ],
      env: {},
    });
    await expect(
      listPackage(api, path.join(fixture.modsDirectory, "mod.pak")),
    ).rejects.toBeInstanceOf(DivineMissingDotNet);
    expect(api.showErrorNotification).toHaveBeenCalledWith(
      "LSLib requires .NET 8",
      expect.stringContaining("selected Steam/Proton prefix"),
      expect.objectContaining({ id: "bg3-dotnet-error" }),
    );
  });

  it.each([
    "VORTEX_BG3_UNSUPPORTED_TOOL_PATH",
    "Failed to create CoreCLR, HRESULT: 0x80070057",
    "Vortex BG3 launcher: Find output hook failed (Windows error 2)",
  ])("stops scanning when the Windows tool cannot start: %s", async (diagnostic) => {
    vi.mocked(util.getProtonToolCommand).mockResolvedValue({
      executable: process.execPath,
      args: ["-e", "process.stderr.write(process.argv[1]);process.exit(87)", "--", diagnostic],
      env: {},
    });
    await expect(
      listPackage(api, path.join(fixture.modsDirectory, "mod.pak")),
    ).rejects.toBeInstanceOf(util.ProcessCanceled);
  });

  it("treats an interrupted environment lookup as cancellation", async () => {
    let rejectLookup: (error: Error) => void;
    vi.mocked(util.getProtonToolCommand).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLookup = reject;
        }),
    );
    const operation = extractPak(api, "unused", "unused", "*");
    await vi.waitFor(() => expect(util.getProtonToolCommand).toHaveBeenCalled());
    abortDivineOperations();
    rejectLookup(new util.ProcessCanceled("Discovery changed"));
    await expect(operation).rejects.toBeInstanceOf(DivineAborted);
  });

  it("stops deserializing when the installed executable is missing", async () => {
    await rm(path.join(root, "lslib", "tools", "Divine.exe"));
    await expect(deserialize({ api } as types.IExtensionContext)).rejects.toThrow("Divine");
    expect(fs.writeFileAsync).not.toHaveBeenCalled();
    expect(fixture.getCacheEntry).not.toHaveBeenCalled();
  });

  it.each([() => new DivineMissingDotNet(), () => new util.ProcessCanceled("Unmapped path")])(
    "preserves the previous load order when the CLI environment is unavailable",
    async (makeError) => {
      const error = makeError();
      fixture.getCacheEntry.mockRejectedValue(error);
      await expect(deserialize({ api } as types.IExtensionContext)).rejects.toBe(error);
      expect(fs.writeFileAsync).not.toHaveBeenCalled();
      expect(api.dismissNotification).toHaveBeenCalledWith("bg3-reading-paks-activity");
    },
  );
});
