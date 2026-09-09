import * as nativeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

let root: string;
let staging: string;
let game: string;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await nativeFs.mkdtemp(path.join(os.tmpdir(), "vortex-external-paths-"));
  staging = path.join(root, "staging");
  game = path.join(root, "game");
  await nativeFs.mkdir(path.join(staging, "mod", "data"), { recursive: true });
  await nativeFs.mkdir(path.join(game, "Data"), { recursive: true });
});

afterEach(async () => {
  await nativeFs.rm(root, { recursive: true, force: true });
});

describe("external changes with case-resolved deployment paths", () => {
  it("drops the actual deployed path instead of a nonexistent source-case path", async () => {
    const actions = [
      { source: "mod", filePath: "data/FILE.ini", action: "drop", type: "refchange" },
    ] as IFileEntry[];
    expect(await applyFileActions(api, undefined, staging, game, manifest, actions)).toEqual([]);
    expect(fs.removeAsync).toHaveBeenCalledWith(path.join(game, "Data/File.ini"));
  });

  it("imports the actual destination into the original staging path", async () => {
    const actions = [
      { source: "mod", filePath: "data/FILE.ini", action: "import", type: "refchange" },
    ] as IFileEntry[];
    await applyFileActions(api, undefined, staging, game, manifest, actions);
    expect(fs.moveAsync).toHaveBeenCalledWith(
      path.join(game, "Data/File.ini"),
      path.join(staging, "mod", "data/FILE.ini"),
      { overwrite: true },
    );
  });

  it.runIf(process.platform === "linux")("blocks a drop through a nested symlink", async () => {
    const outside = path.join(root, "outside");
    await nativeFs.mkdir(outside);
    await nativeFs.symlink(outside, path.join(game, "Escape"));
    const actions = [
      { source: "mod", filePath: "ignored", action: "drop", type: "refchange" },
    ] as IFileEntry[];
    const escapedManifest = [
      { source: "mod", relPath: "ignored", deployedPath: "Escape/sentinel.txt", time: 1 },
    ];
    await expect(
      applyFileActions(api, undefined, staging, game, escapedManifest, actions),
    ).rejects.toMatchObject({ code: "ESECURITY" });
    expect(fs.removeAsync).not.toHaveBeenCalled();
  });
});
