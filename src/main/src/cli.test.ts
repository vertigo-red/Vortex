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
