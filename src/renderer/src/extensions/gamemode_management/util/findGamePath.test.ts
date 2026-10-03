import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { makeTempDir } from "../../../test-utils/tempDir";
import { ProcessCanceled } from "../../../util/CustomErrors";
import { findGamePath } from "./findGamePath";

async function installation(): Promise<string> {
  const root = await makeTempDir("vortex-game-root-");
  await mkdir(path.join(root, "Binaries", "Win64"), { recursive: true });
  await writeFile(path.join(root, "Binaries", "Win64", "Game.exe"), "game");
  return root;
}

it("finds a root from a nested directory using native separators", async () => {
  const root = await installation();
  expect(
    await findGamePath(
      { requiredFiles: [path.join("Binaries", "Win64", "Game.exe")] },
      path.join(root, "Binaries", "Win64"),
    ),
  ).toBe(root);
});

describe.skipIf(process.platform !== "linux")("Linux manual game discovery", () => {
  it.each(["Binaries\\Win64\\Game.exe", "Binaries/Win64\\Game.exe"])(
    "selects the root using %s even from Win64",
    async (required) => {
      const root = await installation();
      expect(
        await findGamePath({ requiredFiles: [required] }, path.join(root, "Binaries", "Win64")),
      ).toBe(root);
    },
  );

  it("does not accept a root missing another required file", async () => {
    const root = await installation();
    await expect(
      findGamePath({ requiredFiles: ["Binaries\\Win64\\Game.exe", "Missing.dat"] }, root),
    ).rejects.toBeInstanceOf(ProcessCanceled);
  });

  it("does not ignore Linux filename casing", async () => {
    const root = await installation();
    await expect(
      findGamePath({ requiredFiles: ["binaries/Win64/Game.exe"] }, root),
    ).rejects.toBeInstanceOf(ProcessCanceled);
  });
});
