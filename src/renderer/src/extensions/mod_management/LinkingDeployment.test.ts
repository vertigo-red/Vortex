import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "../../types/IExtensionContext";
import type { IDeployedFile } from "./types/IDeploymentMethod";

vi.mock("../../util/api", () => ({
  getGame: () => ({ directoryCleaning: "tag", requiresCleanup: false }),
  UserCanceled: class extends Error {},
}));
vi.mock("../../util/fs", () => ({ renameAsync: async () => {} }));
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
  protected async linkFile(destination: string) {
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
    store: { dispatch, getState: () => ({ settings: { mods: { cleanupOnDeploy: false } } }) },
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
