import * as path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "../../../types/IExtensionContext";
import type { IFileEntry } from "../types/IFileEntry";

vi.mock("../../../util/fs", () => ({
  removeAsync: vi.fn(async () => {}),
  moveAsync: vi.fn(async () => {}),
}));
vi.mock("../../../logging", () => ({ log: vi.fn() }));
vi.mock("../modMerging", () => ({ MERGED_PATH: "__merged" }));
vi.mock("../../../util/selectors", () => ({ activeGameId: () => "game" }));

import * as fs from "../../../util/fs";
import { applyFileActions } from "./externalChanges";

const manifest = [
  { source: "mod", relPath: "data/FILE.ini", deployedPath: "Data/File.ini", time: 1 },
];
const api = {
  store: { getState: () => ({}) },
  events: { emit: vi.fn() },
} as unknown as IExtensionApi;
beforeEach(() => vi.clearAllMocks());
describe("external changes with case-resolved deployment paths", () => {
  it("drops the actual deployed path instead of a nonexistent source-case path", async () => {
    const actions = [
      { source: "mod", filePath: "data/FILE.ini", action: "drop", type: "refchange" },
    ] as IFileEntry[];
    expect(await applyFileActions(api, undefined, "/staging", "/game", manifest, actions)).toEqual(
      [],
    );
    expect(fs.removeAsync).toHaveBeenCalledWith(path.join("/game", "Data/File.ini"));
  });
  it("imports the actual destination into the original staging path", async () => {
    const actions = [
      { source: "mod", filePath: "data/FILE.ini", action: "import", type: "refchange" },
    ] as IFileEntry[];
    await applyFileActions(api, undefined, "/staging", "/game", manifest, actions);
    expect(fs.moveAsync).toHaveBeenCalledWith(
      path.join("/game", "Data/File.ini"),
      path.join("/staging", "mod", "data/FILE.ini"),
      { overwrite: true },
    );
  });
});
