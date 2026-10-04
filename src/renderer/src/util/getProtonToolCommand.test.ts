import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MissingInterpreter, ProcessCanceled } from "./CustomErrors";
import { getProtonToolCommand } from "./getProtonToolCommand";
import { toWinePath } from "./linux/winePaths";
import type { ISteamEntry } from "./Steam";

const steam = vi.hoisted(() => ({ entries: [] as ISteamEntry[], executable: "" }));
vi.mock("./Steam", () => ({
  default: {
    snapshot: () => ({ entries: steam.entries }),
    getGameStorePath: () => Promise.resolve(steam.executable),
  },
}));

let root: string;
let prefix: string;
let game: ISteamEntry;
let tools: string;
const discovery = () => ({ path: game.gamePath, store: "steam" });

describe.skipIf(process.platform !== "linux")("Proton CLI preparation", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vortex-proton-cli-"));
    game = {
      appid: "1086940",
      name: "BG3",
      gameStoreId: "steam",
      gamePath: path.join(root, "BG3"),
      compatDataPath: path.join(root, "Secondary Library", "compatdata", "1086940"),
      protonPath: path.join(root, "Selected Proton"),
      usesProton: true,
    };
    steam.entries = [game];
    steam.executable = path.join(root, "Steam", "steam.sh");
    prefix = path.join(game.compatDataPath, "pfx");
    tools = path.join(root, "Staging '日本語' $()", "tools");
    await Promise.all(
      [
        game.gamePath,
        game.protonPath,
        tools,
        path.join(prefix, "drive_c"),
        path.join(prefix, "dosdevices"),
      ].map((directory) => mkdir(directory, { recursive: true })),
    );
    await writeFile(path.join(game.protonPath, "proton"), "#!/bin/sh\n");
    await chmod(path.join(game.protonPath, "proton"), 0o755);
    await symlink("../drive_c", path.join(prefix, "dosdevices", "c:"));
    await symlink(root, path.join(prefix, "dosdevices", "z:"));
  });
  afterEach(async () => {
    steam.entries = [];
    await rm(root, { recursive: true, force: true });
  });

  it("selects discovery over a tool located in a different game", async () => {
    const other = { ...game, appid: "42", gamePath: tools, compatDataPath: "/wrong-prefix" };
    steam.entries.unshift(other);
    const command = await getProtonToolCommand(
      path.join(tools, "Divine.exe"),
      [
        "--source",
        { path: path.join(prefix, "drive_c", "Mods 日本語", "a.pak") },
        "--expression",
        "*.lsx",
        "$(); ! & literal",
        "",
      ],
      discovery(),
    );
    expect(command.executable).toBe(path.join(game.protonPath, "proton"));
    expect(command.args).toEqual([
      "run",
      "Z:\\Staging '日本語' $()\\tools\\Divine.exe",
      "--source",
      "C:\\Mods 日本語\\a.pak",
      "--expression",
      "*.lsx",
      "$(); ! & literal",
      "",
    ]);
    expect(command.env).toMatchObject({
      STEAM_COMPAT_DATA_PATH: game.compatDataPath,
      WINEPREFIX: prefix,
      STEAM_COMPAT_CLIENT_INSTALL_PATH: path.join(root, "Steam"),
      STEAM_COMPAT_APP_ID: "1086940",
      STEAM_COMPAT_INSTALL_PATH: game.gamePath,
    });
  });

  it("matches symlinked discovery paths", async () => {
    const alias = path.join(root, "BG3 alias");
    await symlink(game.gamePath, alias);
    const result = await getProtonToolCommand(path.join(tools, "Divine.exe"), [], { path: alias });
    expect(result.env.WINEPREFIX).toBe(prefix);
  });

  it("rejects a different discovered game rather than selecting the tool's prefix", async () => {
    await expect(
      getProtonToolCommand(path.join(game.gamePath, "Divine.exe"), [], {
        path: `${game.gamePath}2`,
      }),
    ).rejects.toBeInstanceOf(MissingInterpreter);
  });

  it.each(["protonPath", "compatDataPath", "usesProton"] as const)(
    "rejects missing %s",
    async (key) => {
      delete game[key];
      await expect(
        getProtonToolCommand(path.join(tools, "Divine.exe"), [], discovery()),
      ).rejects.toBeInstanceOf(MissingInterpreter);
    },
  );

  it("rejects an uninitialized prefix", async () => {
    await rm(path.join(prefix, "drive_c"), { recursive: true });
    await expect(
      getProtonToolCommand(path.join(tools, "Divine.exe"), [], discovery()),
    ).rejects.toThrow(ProcessCanceled);
  });

  it("rejects a missing selected Proton launcher without choosing another build", async () => {
    await rm(path.join(game.protonPath, "proton"));
    await expect(
      getProtonToolCommand(path.join(tools, "Divine.exe"), [], discovery()),
    ).rejects.toThrow(ProcessCanceled);
  });

  it("uses the most specific drive, follows host symlinks and keeps nonexistent destinations", async () => {
    const redirected = path.join(root, "Redirected");
    await mkdir(redirected);
    await symlink(redirected, path.join(prefix, "dosdevices", "d:"));
    const alias = path.join(root, "Redirected alias");
    await symlink(redirected, alias);
    expect(toWinePath(prefix, path.join(alias, "new", "meta.lsx"))).toBe("D:\\new\\meta.lsx");
    expect(toWinePath(prefix, redirected)).toBe("D:\\");
  });

  it("respects a custom Z drive and rejects unmapped host paths", async () => {
    await rm(path.join(prefix, "dosdevices", "z:"));
    await symlink(tools, path.join(prefix, "dosdevices", "z:"));
    expect(toWinePath(prefix, path.join(tools, "Divine.exe"))).toBe("Z:\\Divine.exe");
    expect(() => toWinePath(prefix, path.join(root, "Unmapped", "mod.pak"))).toThrow(
      "No Wine drive maps",
    );
  });

  it.each(["bad\\name.pak", "bad:name.pak", "trailing.\u0020", "NUL.txt"])(
    "rejects Linux-only filenames that would change Windows path identity: %s",
    (name) => {
      expect(() => toWinePath(prefix, path.join(tools, name))).toThrow("Windows filename");
    },
  );
});
