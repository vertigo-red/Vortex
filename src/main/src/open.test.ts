import { beforeEach, describe, expect, it, vi } from "vitest";

const { openExternalMock } = vi.hoisted(() => {
  const openExternalMock = vi.fn();
  return { openExternalMock };
});

vi.mock("electron", () => ({
  shell: {
    openExternal: openExternalMock,
  },
}));

vi.mock("./logging", () => ({ log: vi.fn() }));

import { openUrl } from "./open";

describe("openUrl", () => {
  beforeEach(() => openExternalMock.mockReset());

  it("opens http and https URLs", () => {
    openExternalMock.mockResolvedValue(undefined);

    openUrl(new URL("https://www.nexusmods.com/mods"));
    openUrl(new URL("http://example.com/readme"));

    expect(openExternalMock).toHaveBeenCalledTimes(2);
    expect(openExternalMock).toHaveBeenCalledWith("https://www.nexusmods.com/mods");
    expect(openExternalMock).toHaveBeenCalledWith("http://example.com/readme");
  });

  it("refuses file:// URLs", () => {
    openUrl(new URL("file:///C:/Windows/system32/calc.exe"));
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it("refuses smb:// URLs", () => {
    openUrl(new URL("smb://server/share/file"));
    expect(openExternalMock).not.toHaveBeenCalled();
  });

  it("refuses custom protocol URLs", () => {
    openUrl(new URL("ms-settings:display"));
    openUrl(new URL("vortex://some-path"));
    expect(openExternalMock).not.toHaveBeenCalled();
  });
});