import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetHarnessRegistries } from "../../../test-utils/builders";
import { makeGamebryoHarness } from "../../../test-utils/gamebryoTest";
import { setGameParameters } from "../../gamemode_management/actions/settings";
import { appDataPath, initGameSupport } from "./gameSupport";
import { applySettingsPrefix, selectSettingsPrefix } from "./settingsPrefix";

vi.mock("../../../util/Steam", () => ({ default: { snapshot: () => ({ entries: [] }) } }));

describe.skipIf(process.platform !== "linux")("Bethesda settings prefix selection", () => {
  let root: string;
  let prefix: string;
  let harness: ReturnType<typeof makeGamebryoHarness>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vortex-select-prefix-"));
    prefix = path.join(root, "New prefix");
    await mkdir(path.join(prefix, "drive_c", "users", "Player", "Documents"), { recursive: true });
    await writeFile(path.join(prefix, "user.reg"), "WINE REGISTRY Version 2\n");
    const game = path.join(root, "Skyrim");
    await mkdir(game);
    harness = makeGamebryoHarness({ gameId: "skyrim", gamePath: game });
    await initGameSupport(harness.api);
    harness.api.selectDir = vi.fn().mockResolvedValue(prefix);
  });

  afterEach(async () => {
    resetHarnessRegistries();
    await rm(root, { recursive: true, force: true });
  });

  it("accepts an initialized custom prefix without launching Wine or the game", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    await selectSettingsPrefix(harness.api, "skyrim", apply);
    expect(apply).toHaveBeenCalledExactlyOnceWith("skyrim", prefix);
    expect(harness.errorNotifications).toEqual([]);
    expect(harness.runExecutableCalls).toEqual([]);
  });

  it("leaves configuration untouched when the folder dialog is cancelled", async () => {
    harness.api.selectDir = vi.fn().mockResolvedValue(undefined);
    const apply = vi.fn();
    await selectSettingsPrefix(harness.api, "skyrim", apply);
    expect(apply).not.toHaveBeenCalled();
    expect(harness.errorNotifications).toEqual([]);
  });

  it("rejects uninitialized folders before changing plugin routing", async () => {
    await rm(path.join(prefix, "user.reg"));
    const apply = vi.fn();
    await selectSettingsPrefix(harness.api, "skyrim", apply);
    expect(apply).not.toHaveBeenCalled();
    expect(harness.errorNotifications).toEqual([
      expect.objectContaining({ title: "Could not set game settings prefix", allowReport: false }),
    ]);
  });

  it("checks Local AppData redirections as well as Documents before accepting a prefix", async () => {
    await writeFile(
      path.join(prefix, "user.reg"),
      String.raw`WINE REGISTRY Version 2

[Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders]
"Local AppData"="Q:\\Unmapped"
`,
    );
    const apply = vi.fn();
    await selectSettingsPrefix(harness.api, "skyrim", apply);
    expect(apply).not.toHaveBeenCalled();
    expect(harness.errorNotifications).toHaveLength(1);
  });

  it("flushes the old prefix before the store changes and then refreshes the new lists", async () => {
    const old = path.join(root, "Old prefix");
    harness.api.store.dispatch(setGameParameters("skyrim", { modSettingsPrefix: old }));
    const order: string[] = [];
    const sync = {
      stop: vi.fn(async () => {
        order.push("flush old");
        expect(harness.getState().settings.gameMode.discovered.skyrim.modSettingsPrefix).toBe(old);
      }),
      start: vi.fn(async () => {
        order.push("load new");
        expect(appDataPath("skyrim")).toBe(
          path.join(prefix, "drive_c", "users", "Player", "AppData", "Local", "Skyrim"),
        );
      }),
      refresh: vi.fn(async () => {
        order.push("refresh");
      }),
    };
    const wait = vi.fn(async () => {
      order.push("wait for sort");
    });
    harness.api.events.on("restart-helpers", () => order.push("restart LOOT"));

    await applySettingsPrefix(harness.api, sync, wait, "skyrim", prefix);

    expect(order).toEqual(["flush old", "wait for sort", "restart LOOT", "load new", "refresh"]);
    expect(harness.getState().settings.gameMode.discovered.skyrim.modSettingsPrefix).toBe(prefix);
    expect(harness.runExecutableCalls).toEqual([]);
  });

  it("does not change the prefix when saving the old plugin lists fails", async () => {
    const sync = {
      stop: vi.fn().mockRejectedValue(new Error("write failed")),
      start: vi.fn(),
      refresh: vi.fn(),
    };
    await expect(applySettingsPrefix(harness.api, sync, vi.fn(), "skyrim", prefix)).rejects.toThrow(
      "write failed",
    );
    expect(
      harness.getState().settings.gameMode.discovered.skyrim.modSettingsPrefix,
    ).toBeUndefined();
    expect(sync.start).not.toHaveBeenCalled();
  });

  it("stores another game's setting without restarting the active game's helpers", async () => {
    harness.setState((state) => {
      state.settings.profiles.activeProfileId = undefined;
    });
    const sync = { stop: vi.fn(), start: vi.fn(), refresh: vi.fn() };
    const wait = vi.fn();
    await applySettingsPrefix(harness.api, sync, wait, "skyrim", prefix);
    expect(harness.getState().settings.gameMode.discovered.skyrim.modSettingsPrefix).toBe(prefix);
    expect(sync.stop).not.toHaveBeenCalled();
    expect(sync.start).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });
});
