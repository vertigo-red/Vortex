import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../log", () => ({ log: vi.fn() }));
vi.mock("./common", () => ({
  applicationsDirectory: vi.fn(),
  getDefaultUrlSchemeHandler: vi.fn(() => "another.desktop"),
  refreshDesktopDatabase: vi.fn(),
  setDefaultUrlSchemeHandler: vi.fn(() => true),
}));
import { applicationsDirectory, setDefaultUrlSchemeHandler } from "./common";
import { generateWrapperScript, registerLinuxNxmProtocolHandler } from "./nxm";

const temporary: string[] = [];
function directory() {
  const result = mkdtempSync(path.join(tmpdir(), "vortex-nxm-"));
  temporary.push(result);
  return result;
}
afterEach(() => {
  for (const entry of temporary.splice(0)) rmSync(entry, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe.skipIf(process.platform !== "linux")("native nxm registration", () => {
  it("launches a packaged binary without an Electron application argument", () => {
    const root = directory();
    const executable = path.join(root, "Vortex $name 'with spaces'");
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const wrapper = path.join(root, "wrapper.sh");
    writeFileSync(wrapper, generateWrapperScript(executable), { mode: 0o755 });
    const url = "nxm://skyrimspecialedition/mods/1/files/2?key=a&expires=9";
    expect(execFileSync(wrapper, [url], { encoding: "utf8" }).trim().split("\n")).toEqual([
      "--download",
      url,
    ]);
    expect(execFileSync(wrapper, [], { encoding: "utf8" }).trim()).toBe("");
  });
  it("includes the application path only for a development Electron launch", () => {
    const root = directory();
    const executable = path.join(root, "electron");
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const wrapper = path.join(root, "wrapper.sh");
    writeFileSync(wrapper, generateWrapperScript(executable, "/App With Spaces"), { mode: 0o755 });
    expect(execFileSync(wrapper, [], { encoding: "utf8" }).trim()).toBe("/App With Spaces");
  });
  it("persists the AppImage's real location instead of its temporary mount path", () => {
    const root = directory();
    vi.mocked(applicationsDirectory).mockReturnValue(root);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IS_FLATPAK", "false");
    vi.stubEnv("APPIMAGE", "/Apps/Vortex.AppImage");
    expect(
      registerLinuxNxmProtocolHandler({
        setAsDefault: true,
        executablePath: "/tmp/.mount_Vortex/vortex",
        appPath: "/tmp/.mount_Vortex/resources/app.asar",
      }),
    ).toBe(true);
    const wrapper = readFileSync(path.join(root, "com.nexusmods.vortex.native.sh"), "utf8");
    expect(wrapper).toContain('"/Apps/Vortex.AppImage"');
    expect(wrapper).not.toContain(".mount_");
    expect(setDefaultUrlSchemeHandler).toHaveBeenCalledWith(
      "nxm",
      "com.nexusmods.vortex.native.desktop",
    );
  });
  it("does not report success when xdg-settings fails", () => {
    vi.mocked(applicationsDirectory).mockReturnValue(directory());
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IS_FLATPAK", "false");
    vi.mocked(setDefaultUrlSchemeHandler).mockReturnValueOnce(false);
    expect(
      registerLinuxNxmProtocolHandler({
        setAsDefault: true,
        executablePath: "/Apps/vortex",
        appPath: "/Apps/resources/app.asar",
      }),
    ).toBe(false);
  });
  it("retains the package-managed desktop id in Flatpak", () => {
    vi.mocked(applicationsDirectory).mockReturnValue(directory());
    vi.stubEnv("IS_FLATPAK", "true");
    registerLinuxNxmProtocolHandler({
      setAsDefault: true,
      executablePath: "/app/vortex",
      appPath: "/app",
    });
    expect(setDefaultUrlSchemeHandler).toHaveBeenCalledWith("nxm", "com.nexusmods.vortex.desktop");
  });
});
