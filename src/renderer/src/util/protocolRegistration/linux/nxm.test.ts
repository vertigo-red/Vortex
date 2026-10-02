import { execFileSync } from "node:child_process";
import type { PathLike } from "node:fs";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type * as FileSystem from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";

const packageState = vi.hoisted(() => ({ installed: false }));
vi.mock("fs-extra", async (importOriginal) => {
  const module = await importOriginal<{ default: typeof FileSystem }>();
  const actual = module.default;
  return {
    ...module,
    ...actual,
    existsSync: (file: PathLike) =>
      (packageState.installed && file === "/usr/share/applications/vortex.desktop") ||
      actual.existsSync(file),
    realpathSync: (file: PathLike) =>
      packageState.installed && ["/usr/bin/vortex", "/opt/Vortex/vortex"].includes(file.toString())
        ? "/opt/Vortex/vortex"
        : actual.realpathSync(file),
  };
});
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

function installedPackage() {
  packageState.installed = true;
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("IS_FLATPAK", "false");
  vi.stubEnv("APPIMAGE", "");
}
afterEach(() => {
  packageState.installed = false;
  for (const entry of temporary.splice(0)) rmSync(entry, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe.skipIf(process.platform !== "linux")("native nxm registration", () => {
  it.each(["/opt/Vortex/vortex", "/usr/bin/vortex"])(
    "uses the package desktop entry for %s without creating user launchers",
    (executablePath) => {
      const root = directory();
      installedPackage();
      vi.mocked(applicationsDirectory).mockReturnValue(root);
      expect(
        registerLinuxNxmProtocolHandler({
          setAsDefault: true,
          executablePath,
          appPath: "/opt/Vortex/resources/app.asar",
        }),
      ).toBe(true);
      expect(setDefaultUrlSchemeHandler).toHaveBeenCalledWith("nxm", "vortex.desktop");
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it("keeps a manual binary separate from an installed package", () => {
    const root = directory();
    const executablePath = path.join(root, "vortex");
    writeFileSync(executablePath, "binary");
    installedPackage();
    vi.mocked(applicationsDirectory).mockReturnValue(root);
    registerLinuxNxmProtocolHandler({
      setAsDefault: true,
      executablePath,
      appPath: path.join(root, "resources", "app.asar"),
    });
    expect(setDefaultUrlSchemeHandler).toHaveBeenCalledWith(
      "nxm",
      "com.nexusmods.vortex.native.desktop",
    );
    expect(readFileSync(path.join(root, "com.nexusmods.vortex.native.sh"), "utf8")).toContain(
      executablePath,
    );
  });

  it("keeps an AppImage separate from the package desktop entry", () => {
    const root = directory();
    installedPackage();
    vi.stubEnv("APPIMAGE", "/Apps/Vortex.AppImage");
    vi.mocked(applicationsDirectory).mockReturnValue(root);
    registerLinuxNxmProtocolHandler({
      setAsDefault: true,
      executablePath: "/opt/Vortex/vortex",
      appPath: "/tmp/app.asar",
    });
    expect(setDefaultUrlSchemeHandler).toHaveBeenCalledWith(
      "nxm",
      "com.nexusmods.vortex.native.desktop",
    );
    expect(readFileSync(path.join(root, "com.nexusmods.vortex.native.sh"), "utf8")).toContain(
      "/Apps/Vortex.AppImage",
    );
  });
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
