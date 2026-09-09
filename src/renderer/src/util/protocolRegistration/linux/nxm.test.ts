import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "", dataRoot: "", setDefault: vi.fn(), refresh: vi.fn() }));
vi.mock("./common", () => ({
  applicationsDirectory: () => fixture.root,
  getDefaultUrlSchemeHandler: () => "other.desktop",
  setDefaultUrlSchemeHandler: fixture.setDefault,
  refreshDesktopDatabase: fixture.refresh,
}));
vi.mock("../../log", () => ({ log: vi.fn() }));
import { registerLinuxNxmProtocolHandler } from "./nxm";

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-nxm-user-"));
  fixture.dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-nxm-system-"));
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("IS_FLATPAK", "false");
  vi.stubEnv("APPIMAGE", "");
  vi.stubEnv("XDG_DATA_DIRS", fixture.dataRoot);
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(fixture.dataRoot, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux")("Linux nxm registration", () => {
  it("creates an executable portable handler and preserves the URI as one argument", () => {
    const executablePath = path.join(fixture.root, 'Vortex $test "quoted"');
    fs.writeFileSync(executablePath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', {
      mode: 0o755,
    });
    expect(
      registerLinuxNxmProtocolHandler({ executablePath, appPath: "/unused/app.asar", setAsDefault: true }),
    ).toBe(true);
    expect(fixture.setDefault).toHaveBeenCalledWith("nxm", "com.nexusmods.vortex.portable.desktop");
    const desktop = fs.readFileSync(path.join(fixture.root, "com.nexusmods.vortex.portable.desktop"), "utf8");
    expect(desktop).toContain("MimeType=x-scheme-handler/nxm;");
    const wrapper = path.join(fixture.root, "com.nexusmods.vortex.portable.sh");
    const capture = path.join(fixture.root, "args");
    const uri = "nxm://game/mods/1/files/2?key=a&expires=123&user_id=5";
    const result = spawnSync(wrapper, [uri], { env: { ...process.env, CAPTURE: capture } });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(capture, "utf8")).toBe(`--download\n${uri}\n`);
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });

  it("uses the persistent APPIMAGE path instead of the transient executable", () => {
    const appImage = path.join(fixture.root, "Vortex stable.AppImage");
    vi.stubEnv("APPIMAGE", appImage);
    registerLinuxNxmProtocolHandler({
      executablePath: "/tmp/.mount_Vortex/usr/bin/vortex",
      appPath: "/tmp/.mount_Vortex/resources/app.asar",
      setAsDefault: true,
    });
    const wrapper = fs.readFileSync(path.join(fixture.root, "com.nexusmods.vortex.portable.sh"), "utf8");
    expect(wrapper).toContain(`\"${appImage}\"`);
    expect(wrapper).not.toContain(".mount_Vortex");
  });

  it("uses the package-managed vortex.desktop for RPM/DEB without creating portable files", () => {
    const packageApplications = path.join(fixture.dataRoot, "applications");
    fs.mkdirSync(packageApplications, { recursive: true });
    fs.writeFileSync(path.join(packageApplications, "vortex.desktop"), "[Desktop Entry]\nName=Vortex\n");
    registerLinuxNxmProtocolHandler({
      executablePath: "/usr/bin/vortex",
      appPath: "/opt/Vortex/resources/app.asar",
      setAsDefault: true,
    });
    expect(fixture.setDefault).toHaveBeenCalledWith("nxm", "vortex.desktop");
    expect(fs.readdirSync(fixture.root)).toEqual([]);
    expect(fixture.refresh).not.toHaveBeenCalled();
  });

  it("removes only recognized legacy portable handlers when running an RPM/DEB", () => {
    const packageApplications = path.join(fixture.dataRoot, "applications");
    fs.mkdirSync(packageApplications, { recursive: true });
    fs.writeFileSync(path.join(packageApplications, "vortex.desktop"), "[Desktop Entry]\nName=Vortex\n");
    fs.writeFileSync(
      path.join(fixture.root, "com.nexusmods.vortex.portable.desktop"),
      "[Desktop Entry]\nName=Vortex\nExec=/tmp/com.nexusmods.vortex.portable.sh %u\nMimeType=x-scheme-handler/nxm;\n",
    );
    fs.writeFileSync(
      path.join(fixture.root, "com.nexusmods.vortex.portable.sh"),
      '#!/bin/sh\nunset LD_LIBRARY_PATH\nexec "/opt/Vortex/vortex" --download "$@"\n',
    );
    registerLinuxNxmProtocolHandler({ executablePath: "/usr/bin/vortex", appPath: "", setAsDefault: true });
    expect(fs.readdirSync(fixture.root)).toEqual([]);
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });

  it("leaves Flatpak's package-managed desktop file intact", () => {
    vi.stubEnv("IS_FLATPAK", "true");
    registerLinuxNxmProtocolHandler({ executablePath: "/app/vortex", appPath: "/app/app.asar", setAsDefault: true });
    expect(fixture.setDefault).toHaveBeenCalledWith("nxm", "com.nexusmods.vortex.desktop");
    expect(fs.readdirSync(fixture.root)).toEqual([]);
  });
});
