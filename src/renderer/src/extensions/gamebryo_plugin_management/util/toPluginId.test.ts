import { describe, expect, it } from "vitest";

import toPluginId from "./toPluginId";

describe("toPluginId", () => {
  it.each([
    "Plugin.ESP",
    "Data/Plugin.ESP",
    "/games/Skyrim/Data/Plugin.ESP",
    "Data\\Plugin.ESP",
    "C:\\Games\\Skyrim\\Data\\Plugin.ESP",
    "C:/Games/Skyrim/Data/Plugin.ESP.GHOST",
    "C:\\Games\\Skyrim\\Data\\Plugin.ESP.ghost",
  ])("normalizes a Bethesda plugin name or path: %s", (fileName) => {
    expect(toPluginId(fileName)).toBe("plugin.esp");
  });
});
