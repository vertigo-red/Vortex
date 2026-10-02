import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { getLinuxSteamPaths, isValidSteamPath } from "./steamPaths";

afterEach(() => vi.unstubAllEnvs());
describe("Linux Steam locations", () => {
  it("prefers an absolute XDG_DATA_HOME and includes native, Flatpak, Snap and root aliases", () => {
    const data = path.resolve("custom-data");
    vi.stubEnv("XDG_DATA_HOME", data);
    const paths = getLinuxSteamPaths();
    expect(paths[0]).toBe(path.join(data, "Steam"));
    expect(paths).toContain(path.join(homedir(), ".steam", "root"));
    expect(paths.some((entry) => entry.includes("com.valvesoftware.Steam"))).toBe(true);
    expect(paths.some((entry) => entry.includes(path.join("snap", "steam")))).toBe(true);
  });
  it("ignores relative XDG paths", () => {
    vi.stubEnv("XDG_DATA_HOME", "relative");
    expect(getLinuxSteamPaths()[0]).toBe(path.join(homedir(), ".local", "share", "Steam"));
  });
  it("accepts Steam without the legacy config/libraryfolders.vdf", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vortex-steam-path-"));
    try {
      mkdirSync(path.join(root, "steamapps"));
      expect(isValidSteamPath(root)).toBe(true);
      rmSync(path.join(root, "steamapps"), { recursive: true });
      writeFileSync(path.join(root, "steamapps"), "not a directory");
      expect(isValidSteamPath(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
