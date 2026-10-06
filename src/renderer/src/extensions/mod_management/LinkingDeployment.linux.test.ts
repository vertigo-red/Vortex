import { lstat, mkdir, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, vi } from "vitest";

import { makeMod } from "../../test-utils/builders";
import { test, type IDeploymentHarness } from "../../test-utils/deploymentTest";
import { ProcessCanceled } from "../../util/CustomErrors";
import { getGame } from "../gamemode_management/util/getGame";
import {
  addDeploymentFailures,
  confirmExternalChanges,
  setExternalChanges,
} from "./actions/session";
import deployMods from "./modActivation";
import type { IDeployedFile } from "./types/IDeploymentMethod";
import type { IFileEntry } from "./types/IFileEntry";
import BlacklistSet from "./util/BlacklistSet";
import { getDeploymentNormalize } from "./util/deploymentPaths";
import { dealWithExternalChanges } from "./util/externalChanges";

async function stage(h: IDeploymentHarness, mod: string, file: string, content: string) {
  const destination = path.join(h.stagingDir, mod, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content);
}

async function deploy(
  h: IDeploymentHarness,
  mods: string[],
  previous: IDeployedFile[] = [],
  overrides: Record<string, string[]> = {},
): Promise<IDeployedFile[]> {
  return deployMods(
    h.api,
    "skyrim",
    h.stagingDir,
    h.gameDir,
    mods.map((name) =>
      makeMod({ id: name, installationPath: name, fileOverrides: overrides[name] }),
    ),
    h.method,
    previous,
    "",
    new BlacklistSet(
      [],
      getGame("skyrim"),
      await getDeploymentNormalize(h.api, "skyrim", h.gameDir),
    ),
    () => "",
  );
}

describe.skipIf(process.platform !== "linux")("Windows game deployment on Linux", () => {
  test("uses the later mod for a case-only file conflict in a real Skyrim LE deployment", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ gameId: "skyrim", files: {} });
    await stage(h, "A", "Textures/Armor.dds", "A");
    await stage(h, "B", "textures/armor.dds", "B");

    const manifest = await deploy(h, ["A", "B"]);

    expect(manifest).toHaveLength(1);
    expect(manifest[0].source).toBe("B");
    const output = h.inGame(manifest[0].relPath);
    expect(await readFile(output, "utf8")).toBe("B");
    expect(
      (await readdir(h.gameDir)).filter((name) => name.toLowerCase() === "textures"),
    ).toHaveLength(1);
    const source = await lstat(path.join(h.stagingDir, "B", "textures/armor.dds"));
    const destination = await lstat(output);
    expect([destination.dev, destination.ino]).toEqual([source.dev, source.ino]);
  });

  for (const method of ["hardlink", "symlink", "move"] as const) {
    test(`${method}: restores the vanilla file after A, B, A and purge`, async ({
      makeDeployment,
    }) => {
      const h = makeDeployment({ gameId: "skyrim", method, files: {} });
      await stage(h, "A", "textures/armor.dds", "A");
      await stage(h, "B", "TEXTURES/ARMOR.DDS", "B");
      await mkdir(h.inGame("Textures"));
      const vanilla = h.inGame("Textures/Armor.dds");
      await writeFile(vanilla, "vanilla");

      let manifest = await deploy(h, ["A"]);
      expect(await readFile(vanilla, "utf8")).toBe("A");
      expect(await h.method.externalChanges("skyrim", h.stagingDir, h.gameDir, manifest)).toEqual(
        [],
      );
      manifest = await deploy(h, ["A", "B"], manifest);
      expect(await readFile(vanilla, "utf8")).toBe("B");
      expect(await h.method.externalChanges("skyrim", h.stagingDir, h.gameDir, manifest)).toEqual(
        [],
      );
      manifest = await deploy(h, ["A"], manifest);
      expect(await readFile(vanilla, "utf8")).toBe("A");
      manifest = await deploy(h, [], manifest);

      expect(manifest).toEqual([]);
      expect(await readFile(vanilla, "utf8")).toBe("vanilla");
      expect(await readdir(h.inGame("Textures"))).toEqual(["Armor.dds"]);
      expect(await readFile(path.join(h.stagingDir, "A", "textures/armor.dds"), "utf8")).toBe("A");
      expect(await readFile(path.join(h.stagingDir, "B", "TEXTURES/ARMOR.DDS"), "utf8")).toBe("B");
    });
  }

  test("shares one new directory across differently spelled paths before parallel linking", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ gameId: "skyrim", files: {} });
    await stage(h, "A", "Textures/Armor/boots.dds", "boots");
    await stage(h, "B", "textures/ARMOR/helmet.dds", "helmet");
    const manifest = await deploy(h, ["A", "B"]);
    expect(manifest.map((file) => file.relPath).sort()).toEqual([
      "Textures/Armor/boots.dds",
      "Textures/Armor/helmet.dds",
    ]);
    expect((await readdir(h.gameDir)).filter((name) => name.toLowerCase() === "textures")).toEqual([
      "Textures",
    ]);
    expect(await h.method.externalChanges("skyrim", h.stagingDir, h.gameDir, manifest)).toEqual([]);
    await h.method.purge(h.stagingDir, h.gameDir, "skyrim");
    await h.method.postPurge();
    expect(await readdir(h.gameDir)).toEqual([]);
    expect(await readFile(path.join(h.stagingDir, "B", "textures/ARMOR/helmet.dds"), "utf8")).toBe(
      "helmet",
    );
  });

  test("relinks a mod update whose staging path changes case and modification time", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ gameId: "skyrim", files: {} });
    const oldSource = path.join(h.stagingDir, "A", "textures/armor.dds");
    await stage(h, "A", "textures/armor.dds", "first");
    await utimes(oldSource, 1700000000, 1700000000);
    let manifest = await deploy(h, ["A"]);
    await rename(
      path.join(h.stagingDir, "A", "textures"),
      path.join(h.stagingDir, "A", "TEXTURES"),
    );
    await rename(
      path.join(h.stagingDir, "A", "TEXTURES/armor.dds"),
      path.join(h.stagingDir, "A", "TEXTURES/ARMOR.DDS"),
    );
    await rm(path.join(h.stagingDir, "A", "TEXTURES/ARMOR.DDS"));
    await stage(h, "A", "TEXTURES/ARMOR.DDS", "updated");
    manifest = await deploy(h, ["A"], manifest);
    expect(manifest).toHaveLength(1);
    expect(await readFile(h.inGame("textures/armor.dds"), "utf8")).toBe("updated");
    expect(await h.method.externalChanges("skyrim", h.stagingDir, h.gameDir, manifest)).toEqual([]);
    expect(h.dispatched.filter((action) => action.type === String(addDeploymentFailures))).toEqual(
      [],
    );
    await deploy(h, [], manifest);
    await expect(lstat(h.inGame("textures/armor.dds"))).rejects.toMatchObject({ code: "ENOENT" });
    await h.method.purge(h.stagingDir, h.gameDir, "skyrim");
    await h.method.postPurge();
    expect(await readdir(h.gameDir)).toEqual([]);
  });

  test("preserves case-distinct files for a native Linux executable", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ gameId: "skyrim", files: {} });
    getGame("skyrim").executable = () => "native-game";
    await stage(h, "A", "Textures/Armor.dds", "A");
    await stage(h, "B", "textures/armor.dds", "B");
    const manifest = await deploy(h, ["A", "B"]);
    expect(manifest).toHaveLength(2);
    expect(await readFile(h.inGame("Textures/Armor.dds"), "utf8")).toBe("A");
    expect(await readFile(h.inGame("textures/armor.dds"), "utf8")).toBe("B");
    expect(manifest.every((file) => file.sourceRelPath === undefined)).toBe(true);
  });

  test("keeps backup spelling when an externally deleted file is restored without its old manifest entry", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ gameId: "skyrim", files: {} });
    await stage(h, "A", "textures/armor.dds", "mod");
    await mkdir(h.inGame("Textures"));
    const vanilla = h.inGame("Textures/Armor.dds");
    await writeFile(vanilla, "vanilla");
    await deploy(h, ["A"]);
    await rm(vanilla);
    const restored = await deploy(h, ["A"]);
    expect(restored[0].relPath).toBe("Textures/Armor.dds");
    expect(await readFile(vanilla, "utf8")).toBe("mod");
    await deploy(h, [], restored);
    expect(await readFile(vanilla, "utf8")).toBe("vanilla");
    expect(await readdir(h.inGame("Textures"))).toEqual(["Armor.dds"]);
  });

  test("file overrides exclude the selected source despite different path casing", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ gameId: "skyrim", files: {} });
    await stage(h, "A", "Textures/Armor.dds", "A");
    await stage(h, "B", "textures/armor.dds", "B");
    const manifest = await deploy(h, ["A", "B"], [], { B: [h.inGame("TEXTURES/ARMOR.DDS")] });
    expect(manifest).toHaveLength(1);
    expect(manifest[0].source).toBe("A");
    expect(await readFile(h.inGame(manifest[0].relPath), "utf8")).toBe("A");
  });

  test("rejects an ambiguous game directory before changing files and allows retry", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ gameId: "skyrim", files: {} });
    await mkdir(h.inGame("Textures"));
    await mkdir(h.inGame("textures"));
    await writeFile(h.inGame("Textures/original.dds"), "first");
    await writeFile(h.inGame("textures/original.dds"), "second");
    await stage(h, "A", "TEXTURES/original.dds", "mod");
    await expect(deploy(h, ["A"])).rejects.toBeInstanceOf(ProcessCanceled);
    expect(await readFile(h.inGame("Textures/original.dds"), "utf8")).toBe("first");
    expect(await readFile(h.inGame("textures/original.dds"), "utf8")).toBe("second");
    await rm(h.inGame("textures"), { recursive: true });
    const manifest = await deploy(h, ["A"]);
    expect(manifest).toHaveLength(1);
    expect(await readFile(h.inGame("Textures/original.dds"), "utf8")).toBe("mod");
  });

  for (const action of ["import", "delete", "restore"] as const) {
    test(`external ${action} uses the original staging path and the deployed spelling`, async ({
      makeDeployment,
    }) => {
      const h = makeDeployment({ gameId: "skyrim", files: {} });
      h.setState((state) => {
        state.persistent.profiles.profile = {
          id: "profile",
          gameId: "skyrim",
          name: "Test",
          modState: {},
          lastActivated: 0,
        };
        state.settings.profiles.activeProfileId = "profile";
      });
      await stage(h, "A", "textures/armor.dds", "mod");
      await mkdir(h.inGame("Textures"));
      const vanilla = h.inGame("Textures/Armor.dds");
      await writeFile(vanilla, "vanilla");
      const manifest = await deploy(h, ["A"]);
      await rm(vanilla);
      if (action === "import") await writeFile(vanilla, "external");

      const pending = dealWithExternalChanges(
        h.api,
        h.method,
        "profile",
        h.stagingDir,
        { "": h.gameDir },
        { "": manifest },
      );
      await vi.waitFor(() =>
        expect(h.dispatched.some((entry) => entry.type === String(setExternalChanges))).toBe(true),
      );
      const entries = h.dispatched.find((entry) => entry.type === String(setExternalChanges))
        .payload as IFileEntry[];
      expect(entries[0]).toMatchObject({
        filePath: "Textures/Armor.dds",
        sourceRelPath: "textures/armor.dds",
      });
      h.api.store.dispatch(
        confirmExternalChanges(
          entries.map((entry) => ({ ...entry, action })),
          false,
        ),
      );
      const previous = (await pending)[0];
      expect(previous).toEqual([]);

      const staged = path.join(h.stagingDir, "A", "textures/armor.dds");
      if (action === "delete") {
        await expect(lstat(staged)).rejects.toMatchObject({ code: "ENOENT" });
        await h.method.purge(h.stagingDir, h.gameDir, "skyrim");
        await h.method.postPurge();
      } else {
        expect(await readFile(staged, "utf8")).toBe(action === "import" ? "external" : "mod");
        const restored = await deploy(h, ["A"], previous);
        expect(await h.method.externalChanges("skyrim", h.stagingDir, h.gameDir, restored)).toEqual(
          [],
        );
        await deploy(h, [], restored);
      }
      expect(await readFile(vanilla, "utf8")).toBe("vanilla");
      expect(await readdir(h.inGame("Textures"))).toEqual(["Armor.dds"]);
      expect(await readdir(path.join(h.stagingDir, "A"))).toEqual(["textures"]);
    });
  }

  test("restoring an externally replaced file does not overwrite the original vanilla backup", async ({
    makeDeployment,
  }) => {
    const h = makeDeployment({ gameId: "skyrim", files: {} });
    await stage(h, "A", "textures/armor.dds", "mod");
    await mkdir(h.inGame("Textures"));
    const vanilla = h.inGame("Textures/Armor.dds");
    await writeFile(vanilla, "vanilla");
    const manifest = await deploy(h, ["A"]);
    await rm(vanilla);
    await writeFile(vanilla, "external");
    expect(
      (await h.method.externalChanges("skyrim", h.stagingDir, h.gameDir, manifest))[0].changeType,
    ).toBe("refchange");
    const restored = await deploy(h, ["A"]);
    expect(await readFile(vanilla, "utf8")).toBe("mod");
    expect(await readFile(vanilla + ".vortex_backup", "utf8")).toBe("vanilla");
    await deploy(h, [], restored);
    expect(await readFile(vanilla, "utf8")).toBe("vanilla");
  });
});
