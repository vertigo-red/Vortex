import { describe, expect, it } from "vitest";

import type { IRunParameters } from "../../types/IExtensionContext";
import { applyCompatibilityRunner, COMPATIBILITY_RUNNER_ENV } from "./compatibilityRunner";

function call(
  executable: string,
  environment: Record<string, string> = {},
  args: string[] = ["--fixture"],
): IRunParameters {
  return {
    executable,
    args,
    options: { env: environment },
  };
}

describe("Linux compatibility runner", () => {
  it("does not change native executables", () => {
    const input = call("/opt/game/bin/game", { WINEPREFIX: "/prefix" });
    expect(applyCompatibilityRunner(input, "linux")).toBe(input);
  });

  it("does not change Windows executables on Windows", () => {
    const input = call("C:\\Games\\Game.exe", { WINEPREFIX: "C:\\prefix" });
    expect(applyCompatibilityRunner(input, "win32")).toBe(input);
  });

  it("uses system wine when WINEPREFIX opts a Windows executable into compatibility mode", () => {
    const result = applyCompatibilityRunner(
      call("/games/Dragon Age Origins/bin_ship/DAOrigins.exe", {
        WINEPREFIX: "/prefixes/dragon-age-origins",
      }),
      "linux",
    );

    expect(result.executable).toBe("wine");
    expect(result.args).toEqual([
      "/games/Dragon Age Origins/bin_ship/DAOrigins.exe",
      "--fixture",
    ]);
    expect(result.options.env?.WINEPREFIX).toBe("/prefixes/dragon-age-origins");
    expect(result.options.shell).toBe(false);
  });

  it("uses an explicit UMU-style runner and preserves its environment", () => {
    const result = applyCompatibilityRunner(
      call("/games/Dragon Age Origins/bin_ship/DAOrigins.exe", {
        [COMPATIBILITY_RUNNER_ENV]: "umu-run",
        WINEPREFIX: "/prefixes/dragon-age-origins",
        PROTONPATH: "/compat/GE-Proton10-28",
        GAMEID: "0",
      }),
      "linux",
    );

    expect(result.executable).toBe("umu-run");
    expect(result.args).toEqual([
      "/games/Dragon Age Origins/bin_ship/DAOrigins.exe",
      "--fixture",
    ]);
    expect(result.options.env).toMatchObject({
      WINEPREFIX: "/prefixes/dragon-age-origins",
      PROTONPATH: "/compat/GE-Proton10-28",
      GAMEID: "0",
    });
  });

  it("adds Proton's run verb for a directly configured Proton script", () => {
    const result = applyCompatibilityRunner(
      call("/games/example.exe", {
        [COMPATIBILITY_RUNNER_ENV]: "/compat/GE-Proton10-28/proton",
        WINEPREFIX: "/prefixes/example",
      }),
      "linux",
    );

    expect(result.executable).toBe("/compat/GE-Proton10-28/proton");
    expect(result.args).toEqual(["run", "/games/example.exe", "--fixture"]);
  });

  it("leaves an unconfigured Windows executable unchanged", () => {
    const input = call("/games/example.exe");
    expect(applyCompatibilityRunner(input, "linux")).toBe(input);
  });
});
