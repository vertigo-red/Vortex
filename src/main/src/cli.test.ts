import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0", name: "vortex" },
  BrowserWindow: {},
}));
vi.mock("./getVortexPath", () => ({ getVortexPath: () => "/nonexistent-vortex-test" }));
vi.mock("./logging", () => ({ log: vi.fn() }));
import { filterArgs, parseCommandline } from "./cli";
const url = "nxm://skyrim/mods/1/files/2?key=a&expires=9";
describe("desktop protocol arguments", () => {
  it("accepts a positional nxm link from a packaged Linux desktop launcher", () => {
    expect(parseCommandline(["/opt/Vortex/vortex", url], false).download).toBe(url);
  });
  it("accepts a positional nxm link from development Electron", () => {
    expect(parseCommandline(["/usr/bin/electron", "/Vortex/src/main", url], false).download).toBe(
      url,
    );
  });
  it("accepts a positional nxm link from a second-instance notification", () => {
    expect(parseCommandline(["/opt/Vortex/vortex", url], true).download).toBe(url);
  });
  it("preserves an explicit --download argument", () => {
    expect(parseCommandline(["/opt/Vortex/vortex", "--download", url], false).download).toBe(url);
  });
  it("preserves a wrapper download when Vortex is already running", () => {
    expect(parseCommandline(["/opt/Vortex/vortex", "--download", url], true).download).toBe(url);
  });
  it("reconstructs Chromium-reordered switches and values", () => {
    const args = parseCommandline(
      ["/opt/Vortex/vortex", "--download", "--user-data", url, "/custom/profile"],
      true,
    );
    expect(args.download).toBe(url);
    expect(args.userData).toBe("/custom/profile");
  });
  it("preserves the development app path after reordered switches", () => {
    const executable =
      process.platform === "win32" ? "C:\\Electron\\electron.exe" : "/usr/bin/electron";
    expect(
      parseCommandline([executable, "--download", "/Vortex/src/main", url], true).download,
    ).toBe(url);
  });
  it("keeps a Boolean switch separate from a positional link", () => {
    const args = parseCommandline(["/opt/Vortex/vortex", "--start-minimized", url], true);
    expect(args.download).toBe(url);
    expect(args.startMinimized).toBe(true);
    expect(
      filterArgs(["/opt/Vortex/vortex", "--start-minimized", "--user-data", "/custom"]),
    ).toEqual(["--user-data", "/custom"]);
  });
  it("preserves an explicit --install argument", () => {
    expect(parseCommandline(["/opt/Vortex/vortex", "--install", url], false).install).toBe(url);
  });
  it("does not retain a positional link when restarting Vortex", () => {
    expect(filterArgs(["/opt/Vortex/vortex", url, "--user-data", "/custom"])).toEqual([
      "--user-data",
      "/custom",
    ]);
  });
});
