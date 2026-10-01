import * as path from "node:path";

import { describe, expect, it } from "vitest";

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
  it.skipIf(process.platform !== "linux")("preserves Linux case sensitivity", () => {
    expect(
      findSteamGameForTool([game], path.join(game.gamePath.toUpperCase(), "tool.exe")),
    ).toBeUndefined();
  });
});
