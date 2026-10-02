import { lstat, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect } from "vitest";

import { test } from "../../test-utils/deploymentTest";

describe.skipIf(process.platform !== "linux")("Linux symlink deployment", () => {
  test("purges relative deployed links while preserving staged and unrelated files", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ method: "symlink", files: { "mod.txt": "mod" } });
    await h.deploy();
    const source = path.join(h.stagingDir, "SomeMod", "mod.txt");
    await unlink(h.inGame("mod.txt"));
    await symlink(path.relative(h.gameDir, source), h.inGame("mod.txt"));
    const foreign = path.join(path.dirname(h.gameDir), "foreign.txt");
    await writeFile(foreign, "foreign");
    await symlink(path.relative(h.gameDir, foreign), h.inGame("foreign-link.txt"));
    await writeFile(h.inGame("vanilla.txt"), "vanilla");

    await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");

    expect(h.deployedFiles()).toEqual([]);
    expect(await readFile(source, "utf8")).toBe("mod");
    expect(await readFile(h.inGame("vanilla.txt"), "utf8")).toBe("vanilla");
    expect((await lstat(h.inGame("foreign-link.txt"))).isSymbolicLink()).toBe(true);
    expect(await readFile(h.inGame("foreign-link.txt"), "utf8")).toBe("foreign");
  });

  test("recognizes a relative link to its staged source", async ({ makeDeployment }) => {
    const h = makeDeployment({ method: "symlink", files: { "mod.txt": "mod" } });
    const source = path.join(h.stagingDir, "SomeMod", "mod.txt");
    await symlink(path.relative(h.gameDir, source), h.inGame("mod.txt"));
    const method = h.method as unknown as {
      isLink: (link: string, source: string) => PromiseLike<boolean>;
    };
    expect(await method.isLink(h.inGame("mod.txt"), source)).toBe(true);
    expect(
      await method.isLink(h.inGame("mod.txt"), path.join(h.stagingDir, "OtherMod", "mod.txt")),
    ).toBe(false);
  });

  test("purges links for a mod name starting with two dots", async ({ makeDeployment }) => {
    const h = makeDeployment({
      method: "symlink",
      modName: "..SomeMod",
      files: { "mod.txt": "mod" },
    });
    await h.deploy();
    await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
    expect(h.deployedFiles()).toEqual([]);
    expect(await readFile(path.join(h.stagingDir, "..SomeMod", "mod.txt"), "utf8")).toBe("mod");
  });
});
