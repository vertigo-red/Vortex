import { lstat, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect } from "vitest";

import { test } from "../../test-utils/deploymentTest";
import type * as fs from "../../util/fs";

describe.skipIf(process.platform !== "linux")("Linux hardlink deployment", () => {
  test("purges deployed links and preserves staged, vanilla and unrelated files", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ files: { "SkyUI_SE.esp": "plugin", ".hidden.ini": "settings" } });
    await h.deploy();
    const vanilla = h.inGame("Skyrim.esm");
    const foreign = h.inGame("OtherMod.esp");
    await writeFile(vanilla, "vanilla");
    await writeFile(foreign, "foreign");
    const staged = path.join(h.stagingDir, "SomeMod", "SkyUI_SE.esp");
    expect((await lstat(h.inGame("SkyUI_SE.esp"))).nlink).toBe(2);

    await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
    await h.method.postPurge();

    expect(h.deployedFiles()).toEqual([]);
    expect(await readFile(staged, "utf8")).toBe("plugin");
    expect(await readFile(vanilla, "utf8")).toBe("vanilla");
    expect(await readFile(foreign, "utf8")).toBe("foreign");
    expect((await lstat(staged)).nlink).toBe(1);
  });

  test("records real modification times in the deployment manifest", async ({ makeDeployment }) => {
    const h = makeDeployment({ files: { "SkyUI_SE.esp": "plugin" } });
    await utimes(path.join(h.stagingDir, "SomeMod", "SkyUI_SE.esp"), 1700000000, 1700000000);
    const manifest = await h.deploy();
    expect(manifest[0].time).toBe(1700000000000);
  });

  test("does not purge unrelated files reached through a directory symlink", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ files: { "SkyUI_SE.esp": "plugin" } });
    await h.deploy();
    await symlink(h.stagingDir, h.inGame("outside"));
    await h.method.purge(h.stagingDir, h.gameDir, "skyrimse");
    await h.method.postPurge();
    expect(await readFile(path.join(h.stagingDir, "SomeMod", "SkyUI_SE.esp"), "utf8")).toBe(
      "plugin",
    );
  });

  test("requires both device and inode when identifying an existing hardlink", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ files: {} });
    const method = h.method as unknown as {
      isLink: (link: string, source: string, a: fs.Stats, b: fs.Stats) => PromiseLike<boolean>;
    };
    const linkStats = { nlink: 2, ino: 42, dev: 1 } as fs.Stats;
    const sourceStats = { nlink: 2, ino: 42, dev: 2 } as fs.Stats;
    expect(await method.isLink("link", "source", linkStats, sourceStats)).toBe(false);
    expect(
      await method.isLink("link", "source", linkStats, { ...sourceStats, dev: 1 } as fs.Stats),
    ).toBe(true);
  });
});
