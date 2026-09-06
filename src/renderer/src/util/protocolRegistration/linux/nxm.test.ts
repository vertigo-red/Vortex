import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "", setDefault: vi.fn(), refresh: vi.fn() }));
vi.mock("./common", () => ({
  applicationsDirectory: () => fixture.root,
  getDefaultUrlSchemeHandler: () => "other.desktop",
  setDefaultUrlSchemeHandler: fixture.setDefault,
  refreshDesktopDatabase: fixture.refresh,
}));
vi.mock("../../log", () => ({ log: vi.fn() }));
import { registerLinuxNxmProtocolHandler } from "./nxm";

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-nxm-"));
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("IS_FLATPAK", "false");
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux")("portable nxm registration", () => {
  it("creates an executable production handler and preserves the URI as one argument", () => {
    const executablePath = path.join(fixture.root, 'Vortex $test "quoted"');
    fs.writeFileSync(executablePath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE"\n', {
      mode: 0o755,
    });
    expect(
      registerLinuxNxmProtocolHandler({
        executablePath,
        appPath: "/unused/app.asar",
        setAsDefault: true,
      }),
    ).toBe(true);
    expect(fixture.setDefault).toHaveBeenCalledWith("nxm", "com.nexusmods.vortex.portable.desktop");
    const desktop = fs.readFileSync(
      path.join(fixture.root, "com.nexusmods.vortex.portable.desktop"),
      "utf8",
    );
    expect(desktop).toContain("MimeType=x-scheme-handler/nxm;");
    const wrapper = path.join(fixture.root, "com.nexusmods.vortex.portable.sh");
    const capture = path.join(fixture.root, "args");
    const uri = "nxm://game/mods/1/files/2?key=a&expires=123&user_id=5";
    const result = spawnSync(wrapper, [uri], { env: { ...process.env, CAPTURE: capture } });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(capture, "utf8")).toBe(`--download\n${uri}\n`);
    expect(fixture.refresh).toHaveBeenCalledOnce();
    registerLinuxNxmProtocolHandler({
      executablePath,
      appPath: "/unused/app.asar",
      setAsDefault: true,
    });
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });
  it("leaves Flatpak's package-managed desktop file intact", () => {
    vi.stubEnv("IS_FLATPAK", "true");
    registerLinuxNxmProtocolHandler({
      executablePath: "/app/vortex",
      appPath: "/app/app.asar",
      setAsDefault: true,
    });
    expect(fixture.setDefault).toHaveBeenCalledWith("nxm", "com.nexusmods.vortex.desktop");
    expect(fs.readdirSync(fixture.root)).toEqual([]);
  });
});
