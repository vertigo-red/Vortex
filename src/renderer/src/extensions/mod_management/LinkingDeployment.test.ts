import * as nativeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "../../types/IExtensionContext";
import type { IDeployedFile } from "./types/IDeploymentMethod";

vi.mock("../../util/api", () => ({
  getGame: () => ({
    directoryCleaning: "tag",
    requiresCleanup: false,
    executable: () => "Game.exe",
  }),
  UserCanceled: class extends Error {},
}));
vi.mock("../../util/fs", () => ({
  renameAsync: (from: string, to: string) => nativeFs.rename(from, to),
}));
vi.mock("../../logging", () => ({ log: vi.fn() }));
vi.mock("turbowalk", () => ({ default: vi.fn() }));

import LinkingActivator from "./LinkingDeployment";

class TestActivator extends LinkingActivator {
  public unlinked: string[] = [];
  public linked: string[] = [];
  public failures = new Set<string>();
  public isSupported() {
    return undefined;
  }
  protected async linkFile(destination: string, _source: string) {
    this.linked.push(path.basename(destination));
  }
  protected async unlinkFile(destination: string) {
    const name = path.basename(destination);
    this.unlinked.push(name);
    await Promise.resolve();
    if (this.failures.has(name)) throw Object.assign(new Error("locked"), { code: "EBUSY" });
  }
  protected async purgeLinks() {}
  protected async isLink() {
    return false;
  }
  protected canRestore() {
    return true;
  }
}

function setup() {
  const dispatch = vi.fn();
  const api = {
    store: {
      dispatch,
      getState: () => ({ settings: { mods: { cleanupOnDeploy: false }, profiles: {} } }),
    },
    translate: (text: string) => text,
  } as unknown as IExtensionApi;
  return { activator: new TestActivator("test", "test", "test", true, api), dispatch };
}

describe("deployment with locked files", () => {
  it.each(["source", "content"])(
    "does not skip queued %s changes after failed unlinks",
    async (kind) => {
      const { activator, dispatch } = setup();
      const before: IDeployedFile[] = Array.from({ length: 125 }, (_, i) => ({
        relPath: `${i}.txt`,
        source: "old",
        time: 1,
      }));
      await activator.prepare("data", true, before, (value) => value);
      // Model the result of activate(), keeping the test independent of directory walking.
      const context = (activator as any).mContext;
      for (const file of before)
        context.newDeployment[file.relPath] = {
          ...file,
          source: kind === "source" ? "new" : "old",
          time: 2,
        };
      activator.failures = new Set(["0.txt", "7.txt", "49.txt", "60.txt"]);
      const manifest = await activator.finalize("game", "data", "staging");
      expect(new Set(activator.unlinked)).toEqual(new Set(before.map((file) => file.relPath)));
      expect(activator.unlinked).toHaveLength(125);
      expect(activator.linked).toHaveLength(121);
      expect(activator.linked.some((file) => activator.failures.has(file))).toBe(false);
      expect(manifest).toHaveLength(125);
      for (const file of manifest) {
        expect(file.time).toBe(activator.failures.has(file.relPath) ? 1 : 2);
      }
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );

  it("retains a failed removal in the manifest and releases the deployment queue", async () => {
    const { activator } = setup();
    const before = [{ relPath: "locked.txt", source: "old", time: 1 }];
    activator.failures.add("locked.txt");
    await activator.prepare("data", true, before, (value) => value);
    expect(await activator.finalize("game", "data", "staging")).toEqual(before);
    await activator.prepare("data", true, before, (value) => value);
    await activator.cancel("game", "data", "staging");
  });
});

it.runIf(process.platform === "linux")(
  "deploys, replaces and restores using existing destination casing",
  async () => {
    const root = await nativeFs.mkdtemp(path.join(os.tmpdir(), "vortex-deploy-case-"));
    try {
      const data = path.join(root, "game");
      const staging = path.join(root, "staging");
      const target = path.join(data, "Data", "Textures", "Armor.dds");
      await nativeFs.mkdir(path.dirname(target), { recursive: true });
      await nativeFs.writeFile(target, "original");
      const api = {
        store: {
          dispatch: vi.fn(),
          getState: () => ({
            settings: {
              mods: { cleanupOnDeploy: false },
              profiles: { activeProfileId: "profile" },
              gameMode: { discovered: {} },
            },
            persistent: { profiles: { profile: { gameId: "game" } } },
          }),
        },
        translate: (text: string) => text,
      } as unknown as IExtensionApi;
      class DiskActivator extends TestActivator {
        protected async linkFile(destination: string, source: string) {
          await nativeFs.mkdir(path.dirname(destination), { recursive: true });
          await nativeFs.link(source, destination);
        }
        protected async unlinkFile(destination: string) {
          await nativeFs.unlink(destination);
        }
        protected async isLink() {
          return false;
        }
      }
      const activator = new DiskActivator("disk", "disk", "disk", true, api);
      let manifest: IDeployedFile[] = [];
      for (const [source, relPath] of [
        ["first", "data/textures/ARMOR.dds"],
        ["second", "DATA/TEXTURES/armor.dds"],
      ]) {
        const staged = path.join(staging, source, relPath);
        await nativeFs.mkdir(path.dirname(staged), { recursive: true });
        await nativeFs.writeFile(staged, source);
        await activator.prepare(data, true, manifest, (value) => value);
        (activator as any).mContext.newDeployment[relPath.toLowerCase()] = {
          source,
          relPath,
          time: 1,
        };
        manifest = await activator.finalize("game", data, staging);
        expect(await nativeFs.readFile(target, "utf8")).toBe(source);
        expect(manifest[0].relPath).toBe(relPath);
        expect(manifest[0].deployedPath).toBe(path.join("Data", "Textures", "Armor.dds"));
        expect(await nativeFs.readFile(target + ".vortex_backup", "utf8")).toBe("original");
        expect(await nativeFs.readdir(data)).toEqual(["Data"]);
      }
      await activator.prepare(data, true, manifest, (value) => value);
      expect(await activator.finalize("game", data, staging)).toEqual([]);
      expect(await nativeFs.readFile(target, "utf8")).toBe("original");
    } finally {
      await nativeFs.rm(root, { recursive: true, force: true });
    }
  },
);
