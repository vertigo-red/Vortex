import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findSteamGameForTool } from "./gameEntry";

const game = { gamePath: path.resolve("Game"), appid: "42" };
const other = { gamePath: path.resolve("Game2"), appid: "99" };

describe("Steam game selection for Windows tools", () => {
  it("does not match a sibling by a partial directory prefix", () => {
    expect(findSteamGameForTool([game, other], path.join(other.gamePath, "bin", "tool.exe"))).toBe(
      other,
    );
    expect(findSteamGameForTool([game], path.join(other.gamePath, "tool.exe"))).toBeUndefined();
  });
  it("uses the discovered game for tools outside its installation directory", () => {
    expect(
      findSteamGameForTool(
        [game, other],
        path.resolve("External Tools", "xedit.exe"),
        undefined,
        game.gamePath,
      ),
    ).toBe(game);
  });
  it("resolves a tool by its working directory", () => {
    expect(findSteamGameForTool([game], path.resolve("Tools", "tool.exe"), game.gamePath)).toBe(
      game,
    );
  });
  it("does not fall back to another game's executable when discovery is unmatched", () => {
    expect(
      findSteamGameForTool(
        [game, other],
        path.join(other.gamePath, "tool.exe"),
        undefined,
        path.resolve("MissingGame"),
      ),
    ).toBeUndefined();
  });
  it.skipIf(process.platform !== "linux")("preserves Linux case sensitivity", () => {
    expect(
      findSteamGameForTool([game], path.join(game.gamePath.toUpperCase(), "tool.exe")),
    ).toBeUndefined();
  });
});

describe.skipIf(process.platform !== "linux")("Steam library aliases", () => {
  let root: string;
  let library: string;
  let alias: string;
  let entries: Array<{ gamePath: string; appid: string }>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vortex-steam-alias-"));
    library = path.join(root, "Library");
    alias = path.join(root, "Library alias");
    await mkdir(path.join(library, "Game", "bin"), { recursive: true });
    await mkdir(path.join(library, "Game2"));
    await symlink(library, alias);
    entries = [
      { gamePath: path.join(library, "Game"), appid: "42" },
      { gamePath: path.join(library, "Game2"), appid: "99" },
    ];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("matches discovery through a symlink before considering a tool in another game", () => {
    expect(
      findSteamGameForTool(
        entries,
        path.join(library, "Game2", "tool.exe"),
        undefined,
        path.join(alias, "Game"),
      ),
    ).toBe(entries[0]);
  });

  it("matches a not-yet-existing executable below a library symlink", () => {
    expect(findSteamGameForTool(entries, path.join(alias, "Game", "bin", "tool.exe"))).toBe(
      entries[0],
    );
  });

  it("matches an external tool by its aliased working directory", () => {
    expect(
      findSteamGameForTool(entries, path.join(root, "external.exe"), path.join(alias, "Game")),
    ).toBe(entries[0]);
  });

  it("uses the deepest game directory after resolving aliases", () => {
    const nested = { gamePath: path.join(library, "Game", "bin"), appid: "77" };
    const parent = { gamePath: path.join(alias, "Game"), appid: "42" };
    expect(
      findSteamGameForTool([parent, nested], path.join(alias, "Game", "bin", "tool.exe")),
    ).toBe(nested);
  });
});
