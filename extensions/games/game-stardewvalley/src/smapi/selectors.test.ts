import type { types } from "@nexusmods/vortex-api";
import { describe, expect, test, vi } from "vitest";

import { GAME_ID, MOD_TYPE_SMAPI, SMAPI_MOD_ID } from "../common";
import { findSMAPIMod } from "./selectors";

vi.mock(
  import("@nexusmods/vortex-api"),
  () =>
    ({
      selectors: {
        lastActiveProfileForGame: () => "profile",
        profileById: (state) => state.persistent.profiles.profile,
      },
      util: {
        getSafe: (value, keys, fallback) =>
          keys.reduce((current, key) => current?.[key], value) ?? fallback,
      },
    }) as any,
);

function apiWithPackages(
  packages: Array<{ id: string; version: string; platform?: string; enabled?: boolean }>,
): types.IExtensionApi {
  const mods = Object.fromEntries(
    packages.map(({ id, version, platform }) => [
      id,
      {
        id,
        type: MOD_TYPE_SMAPI,
        attributes: { modId: SMAPI_MOD_ID, version, smapiPlatform: platform },
      },
    ]),
  );
  const modState = Object.fromEntries(packages.map(({ id, enabled = true }) => [id, { enabled }]));
  return {
    getState: () => ({
      persistent: { mods: { [GAME_ID]: mods }, profiles: { profile: { modState } } },
    }),
  } as unknown as types.IExtensionApi;
}

describe("SMAPI runtime-aware redeployment", () => {
  const packages = [
    { id: "windows", version: "4.5.1", platform: "windows" },
    { id: "linux-new", version: "4.5.2", platform: "linux" },
    { id: "linux-old", version: "4.5.0", platform: "linux" },
    { id: "untagged", version: "4.6.0" },
  ];

  test("selects Windows SMAPI without reusing a newer native or untagged package", () => {
    expect(findSMAPIMod(apiWithPackages(packages), "windows")?.id).toBe("windows");
  });

  test("selects the newest package for the native runtime", () => {
    expect(findSMAPIMod(apiWithPackages(packages), "linux")?.id).toBe("linux-new");
  });

  test.each([
    [{ id: "native", version: "4.5.1", platform: "linux" }],
    [{ id: "legacy", version: "4.5.1" }],
    [{ id: "disabled", version: "4.5.1", platform: "windows", enabled: false }],
  ])("requires installation when no enabled package has the target runtime", (candidate) => {
    expect(findSMAPIMod(apiWithPackages([candidate]), "windows")).toBeUndefined();
  });

  test("preserves version diagnostics for existing untagged packages", () => {
    expect(findSMAPIMod(apiWithPackages(packages))?.id).toBe("untagged");
  });
});
