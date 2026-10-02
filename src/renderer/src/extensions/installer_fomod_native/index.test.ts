import type * as fomodT from "@nexusmods/fomod-installer-native";
import { describe, expect, it, vi } from "vitest";

import type { IExtensionContext } from "../../types/IExtensionContext";
import { log } from "../../util/log";
import main from "./index";

vi.mock("../../util/log", () => ({ log: vi.fn() }));
vi.mock("./installer", () => ({ install: vi.fn() }));
vi.mock("./tester", () => ({ testSupported: vi.fn() }));

describe.skipIf(process.platform !== "linux")("Linux native FOMOD logging", () => {
  it("connects the real native logger to Vortex once and retains the library filesystem", async () => {
    const { NativeLogger, NativeFileSystem, NativeModInstaller } =
      require("@nexusmods/fomod-installer-native") as typeof fomodT;
    const setLogging = vi.spyOn(NativeLogger.prototype, "setCallbacks");
    const setFileSystem = vi.spyOn(NativeFileSystem.prototype, "setCallbacks");
    const onAsync = vi.fn();
    const context = {
      registerInstaller: vi.fn(),
      once: (callback: () => void) => callback(),
      api: { onAsync },
    } as unknown as IExtensionContext;

    expect(main(context)).toBe(true);
    const willInstall = onAsync.mock.calls.find(([event]) => event === "will-install-mod")[1];
    await willInstall("skyrimse", "archive", "first");
    await willInstall("skyrimse", "archive", "second");

    expect(setLogging).toHaveBeenCalledOnce();
    expect(setFileSystem).not.toHaveBeenCalled();
    vi.mocked(log).mockClear();
    const supported = NativeModInstaller.testSupported(["fomod/ModuleConfig.xml"], ["XmlScript"]);
    expect(supported.supported).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^(debug|info|warn|error)$/),
      expect.stringContaining("FOMOD"),
    );
    vi.restoreAllMocks();
  });
});
