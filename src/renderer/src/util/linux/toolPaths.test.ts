import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ITool } from "../../types/ITool";
import { resolveToolExecutable, verifyToolRequiredFiles } from "./toolPaths";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-tool-paths-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function tool(executable: string, requiredFiles: string[]): ITool {
  return {
    id: "fixture",
    name: "Fixture",
    executable: () => executable,
    requiredFiles,
  };
}

describe.runIf(process.platform === "linux")("tool filesystem semantics", () => {
  it("accepts a Windows game whose required .exe differs only by case and has no execute bit", async () => {
    await fs.mkdir(path.join(root, "bin_ship"));
    const actual = path.join(root, "bin_ship", "DAOrigins.exe");
    await fs.writeFile(actual, "MZ", { mode: 0o644 });
    const game = tool("bin_ship/daorigins.exe", ["bin_ship/daorigins.exe"]);

    await expect(verifyToolRequiredFiles(game, root)).resolves.toBeUndefined();
    await expect(resolveToolExecutable(game, root)).resolves.toBe(path.join("bin_ship", "DAOrigins.exe"));
    expect((await fs.stat(actual)).mode & 0o111).toBe(0);
  });

  it("returns ENOENT for a genuinely missing Windows required file", async () => {
    await fs.mkdir(path.join(root, "bin_ship"));
    const game = tool("bin_ship/daorigins.exe", ["bin_ship/daorigins.exe"]);
    await expect(verifyToolRequiredFiles(game, root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps native Linux game paths case-sensitive", async () => {
    await fs.mkdir(path.join(root, "data"));
    await fs.writeFile(path.join(root, "data", "game.dat"), "native");
    const game = tool("bin/game", ["Data/game.dat"]);
    await expect(verifyToolRequiredFiles(game, root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
