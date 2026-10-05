import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSupportMap } from "./common";
import { addDoorstopOverride, prepareBepInExLaunch, resolveGamePlatform } from "./gameRuntime";
import type { IBepInExGameConfig } from "./types";

const hostPlatform = process.platform;
let root: string;
let api: types.IExtensionApi;
let conf: IBepInExGameConfig;
let input: types.IRunParameters;
let discovery: { path: string; executable?: string };

beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  vi.stubEnv("WINEDLLOVERRIDES", "");
  root = await mkdtemp(path.join(os.tmpdir(), "vortex-bepinex-"));
  const gamePath = path.join(root, "Game 日本語 'quoted';&!");
  await mkdir(gamePath);
  await writeFile(path.join(gamePath, "game.exe"), Buffer.from("MZfixture"));
  await writeFile(path.join(gamePath, "winhttp.dll"), Buffer.from("MZloader"));
  discovery = { path: gamePath };
  api = {
    getState: () => ({
      settings: { gameMode: { discovered: { target: discovery, unrelated: { path: root } } } },
    }),
  } as unknown as types.IExtensionApi;
  conf = { gameId: "target", autoDownloadBepInEx: true };
  getSupportMap().target = conf;
  vi.mocked(util.getGame).mockImplementation((id) =>
    id === "target"
      ? {
          id: "target",
          name: "Fixture Game",
          requiredFiles: ["game.exe"],
          queryModPath: () => ".",
          executable: () => "game.exe",
        }
      : undefined,
  );
  input = {
    executable: path.join(root, "Proton", "proton"),
    args: ["run", path.join(gamePath, "game.exe"), "literal & 日本語"],
    options: {
      cwd: gamePath,
      env: {
        STEAM_COMPAT_INSTALL_PATH: gamePath,
        WINEPREFIX: path.join(root, "pfx"),
        KEEP: "unchanged",
      },
    },
  };
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: hostPlatform, configurable: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const id of Object.keys(getSupportMap())) delete getSupportMap()[id];
  await rm(root, { recursive: true, force: true });
});

describe("game target platform", () => {
  it("selects Windows for a real MZ file on Linux", async () => {
    expect(await resolveGamePlatform(api, conf)).toBe("win32");
  });
  it("uses the requested game's discovery override and mixed separators", async () => {
    await mkdir(path.join(discovery.path, "bin"));
    await writeFile(
      path.join(discovery.path, "bin", "native"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    );
    discovery.executable = "bin\\native";
    expect(await resolveGamePlatform(api, conf)).toBe("linux");
  });
  it("recognizes native scripts without guessing from an exe suffix", async () => {
    await writeFile(path.join(discovery.path, "game.exe"), "#!/bin/sh\nexit 0\n");
    expect(await resolveGamePlatform(api, conf)).toBe("linux");
  });
  it("recognizes extensionless Windows executables", async () => {
    await writeFile(path.join(discovery.path, "windows"), "MZfixture");
    discovery.executable = "windows";
    expect(await resolveGamePlatform(api, conf)).toBe("win32");
  });
  it("rejects unknown files and missing executables", async () => {
    await writeFile(path.join(discovery.path, "game.exe"), "not an executable");
    await expect(resolveGamePlatform(api, conf)).rejects.toThrow("Cannot determine");
    await rm(path.join(discovery.path, "game.exe"));
    await expect(resolveGamePlatform(api, conf)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("allows an explicit platform for scripts that wrap Windows games", async () => {
    conf.targetPlatform = "win32";
    await rm(path.join(discovery.path, "game.exe"));
    expect(await resolveGamePlatform(api, conf)).toBe("win32");
  });
  it("does not inspect Linux headers on a Windows host", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(await resolveGamePlatform(api, conf)).toBe("win32");
  });
});

describe("Proton Doorstop launch", () => {
  it("normalizes an installRelPath declared with Windows separators", async () => {
    const nested = path.join(discovery.path, "bin", "Game");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "game.exe"), "MZfixture");
    await writeFile(path.join(nested, "winhttp.dll"), "MZloader");
    conf.installRelPath = "bin\\Game";
    discovery.executable = "bin\\Game\\game.exe";
    input.args[1] = path.join(nested, "game.exe");
    expect((await prepareBepInExLaunch(api, input)).options.env?.WINEDLLOVERRIDES).toBe(
      "winhttp=n,b",
    );
  });
  it("adds a literal per-launch override and leaves the caller's inputs unchanged", async () => {
    const result = await prepareBepInExLaunch(api, input);
    expect(result.options.env).toEqual({ ...input.options.env, WINEDLLOVERRIDES: "winhttp=n,b" });
    expect(result.args).toBe(input.args);
    expect(input.options.env?.WINEDLLOVERRIDES).toBeUndefined();
  });
  it("keeps existing DLL overrides from the tool environment", async () => {
    input.options.env!.WINEDLLOVERRIDES = "dinput8=n,b;dxgi=n";
    expect((await prepareBepInExLaunch(api, input)).options.env?.WINEDLLOVERRIDES).toBe(
      "dinput8=n,b;dxgi=n;winhttp=n,b",
    );
  });
  it("inherits existing overrides without changing the host environment", async () => {
    vi.stubEnv("WINEDLLOVERRIDES", "dxgi=n");
    expect((await prepareBepInExLaunch(api, input)).options.env?.WINEDLLOVERRIDES).toBe(
      "dxgi=n;winhttp=n,b",
    );
    expect(process.env.WINEDLLOVERRIDES).toBe("dxgi=n");
  });
  it.each(["winhttp=b", "*WINHTTP.dll=n", "dxgi,winhttp=n,b", "*=b"])(
    "preserves explicit override %s",
    async (override) => {
      input.options.env!.WINEDLLOVERRIDES = override;
      expect(await prepareBepInExLaunch(api, input)).toBe(input);
    },
  );
  it("uses version.dll for unity3 and skips hardpatched games", async () => {
    conf.doorstopConfig = { doorstopType: "unity3" };
    await writeFile(path.join(discovery.path, "version.dll"), "MZloader");
    expect((await prepareBepInExLaunch(api, input)).options.env?.WINEDLLOVERRIDES).toBe(
      "version=n,b",
    );
    conf.doorstopConfig.doorstopType = "none";
    expect(await prepareBepInExLaunch(api, input)).toBe(input);
  });
  it("does not change a tool launch in the game's prefix", async () => {
    const tool = path.join(discovery.path, "mod-tool.exe");
    await writeFile(tool, "MZtool");
    input.args[1] = tool;
    expect(await prepareBepInExLaunch(api, input)).toBe(input);
  });
  it("stops adding the override when the deployed loader is removed", async () => {
    await rm(path.join(discovery.path, "winhttp.dll"));
    expect(await prepareBepInExLaunch(api, input)).toBe(input);
  });
  it("ignores native launches and other Proton game installations", async () => {
    input.executable = input.args[1];
    expect(await prepareBepInExLaunch(api, input)).toBe(input);
    input.executable = path.join(root, "proton");
    input.options.env!.STEAM_COMPAT_INSTALL_PATH = root;
    expect(await prepareBepInExLaunch(api, input)).toBe(input);
  });
  it.skipIf(hostPlatform !== "linux")("matches symlinked discovery roots", async () => {
    const link = path.join(root, "linked game");
    await symlink(discovery.path, link, "dir");
    discovery.path = link;
    expect((await prepareBepInExLaunch(api, input)).options.env?.WINEDLLOVERRIDES).toBe(
      "winhttp=n,b",
    );
  });
});
