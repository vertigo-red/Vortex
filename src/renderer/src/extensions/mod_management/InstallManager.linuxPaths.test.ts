import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type * as fomodT from "@nexusmods/fomod-installer-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IInstallManagerHarness } from "../../test-utils/harnessTypes";
import { test } from "../../test-utils/installManagerTest";
import type { IExtensionApi } from "../../types/IExtensionContext";
import { ProcessCanceled } from "../../util/CustomErrors";
import * as fs from "../../util/fs";
import InstallContext from "./InstallContext";
import type { IInstruction } from "./types/IInstallResult";
import type { IChoiceType } from "./types/IMod";
import type { IInstallationDetails } from "./types/InstallFunc";
import { normalizeInstallerInstruction } from "./util/installerPaths";

vi.mock("../../util/log", () => ({ log: vi.fn() }));

interface IInstructionProcessor {
  processInstructions(
    api: IExtensionApi,
    context: InstallContext,
    archivePath: string,
    tempPath: string,
    destinationPath: string,
    gameId: string,
    modId: string,
    result: { instructions: IInstruction[]; overrideInstructions?: IInstruction[] },
    choices: IChoiceType,
    unattended: boolean,
    details: IInstallationDetails,
  ): Promise<void>;
}

describe.skipIf(process.platform !== "linux")("Linux installer paths", () => {
  let root: string;
  let extracted: string;
  let staging: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "vortex-installer-paths-"));
    extracted = path.join(root, "extracted");
    staging = path.join(root, "staging");
    await mkdir(path.join(extracted, "Textures"), { recursive: true });
    await mkdir(staging);
    await writeFile(path.join(extracted, "Textures", "Example.dds"), "texture");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const install = (
    h: IInstallManagerHarness,
    instructions: IInstruction[],
    overrideInstructions?: IInstruction[],
  ) => {
    const processor = h.manager as unknown as IInstructionProcessor;
    return processor.processInstructions(
      h.api,
      new InstallContext("skyrimse", h.api, true),
      path.join(root, "fixture.zip"),
      extracted,
      staging,
      "skyrimse",
      "fixture",
      { instructions, overrideInstructions },
      undefined,
      false,
      {},
    );
  };

  test("copies Windows-style paths and preserves the requested destination case", async ({
    makeInstallManager,
  }) => {
    const h = makeInstallManager();
    await install(h, [
      { type: "copy", source: "textures\\EXAMPLE.dds", destination: "Data\\MixedCase.dds" },
    ]);
    expect(await readFile(path.join(staging, "Data", "MixedCase.dds"), "utf8")).toBe("texture");
    expect(await readdir(staging)).toEqual(["Data"]);
    expect(h.errorNotifications).toEqual([]);
  });

  test("matches instruction overrides before comparing their path separators", async ({
    makeInstallManager,
  }) => {
    const h = makeInstallManager();
    await install(
      h,
      [{ type: "copy", source: "Textures/Example.dds", destination: "original.dds" }],
      [{ type: "copy", source: "Textures\\Example.dds", destination: "Data\\Override.dds" }],
    );
    expect(await readdir(staging)).toEqual(["Data"]);
    expect(await readFile(path.join(staging, "Data", "Override.dds"), "utf8")).toBe("texture");
  });

  test("creates directories and generated files using native separators", async ({
    makeInstallManager,
  }) => {
    const h = makeInstallManager();
    await install(h, [
      { type: "mkdir", destination: "Data\\Empty" },
      { type: "generatefile", destination: "Data\\Config\\Example.ini", data: "settings" },
    ]);
    expect(await readdir(path.join(staging, "Data", "Empty"))).toEqual([]);
    expect(await readFile(path.join(staging, "Data", "Config", "Example.ini"), "utf8")).toBe(
      "settings",
    );
    expect(await readdir(staging)).toEqual(["Data"]);
  });

  test("installs the real native XML FOMOD result when source names differ in case", async ({
    makeInstallManager,
  }) => {
    const h = makeInstallManager();
    await mkdir(path.join(extracted, "fomod"));
    await writeFile(
      path.join(extracted, "fomod", "ModuleConfig.xml"),
      '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
        'xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">' +
        "<moduleName>Linux fixture</moduleName><requiredInstallFiles>" +
        '<file source="textures\\example.dds" destination="Textures\\Installed.dds" />' +
        "</requiredInstallFiles></config>",
    );
    const { NativeLogger, NativeModInstaller } =
      require("@nexusmods/fomod-installer-native") as typeof fomodT;
    // Keep the native library's default Windows log path out of the working directory.
    const logger = new NativeLogger(() => undefined);
    logger.setCallbacks();
    const installer = new NativeModInstaller(
      () => [],
      () => "1.0.0",
      () => "1.0.0",
      () => "1.0.0",
      () => undefined,
      () => undefined,
      () => undefined,
    );
    const result = await installer.install(
      ["fomod/ModuleConfig.xml", "Textures/Example.dds"],
      [],
      null,
      extracted,
      null,
      false,
      true,
    );
    expect(result).not.toBeNull();
    await install(
      h,
      result.instructions.map(({ type, data, ...instruction }) => ({
        ...instruction,
        type: type as IInstruction["type"],
        data: data ? Buffer.from(data) : undefined,
      })),
    );
    expect(await readFile(path.join(staging, "Textures", "Installed.dds"), "utf8")).toBe("texture");
    expect(h.errorNotifications).toEqual([]);
  });

  test("prefers exact names when an archive contains files differing only in case", async ({
    makeInstallManager,
  }) => {
    const h = makeInstallManager();
    await writeFile(path.join(extracted, "Textures", "example.dds"), "lowercase");
    await install(h, [
      { type: "copy", source: "Textures/Example.dds", destination: "Upper.dds" },
      { type: "copy", source: "Textures/example.dds", destination: "Lower.dds" },
    ]);
    expect(await readFile(path.join(staging, "Upper.dds"), "utf8")).toBe("texture");
    expect(await readFile(path.join(staging, "Lower.dds"), "utf8")).toBe("lowercase");
  });

  test("rejects an ambiguous filename instead of selecting arbitrary archive contents", async ({
    makeInstallManager,
  }) => {
    const h = makeInstallManager();
    await writeFile(path.join(extracted, "Textures", "example.dds"), "lowercase");
    await expect(
      install(h, [{ type: "copy", source: "Textures/EXAMPLE.dds", destination: "result.dds" }]),
    ).rejects.toThrow("ambiguous filename casing");
    expect(await readdir(staging)).toEqual([]);
  });

  test("rejects an ambiguous directory name", async ({ makeInstallManager }) => {
    const h = makeInstallManager();
    await mkdir(path.join(extracted, "textures"));
    await writeFile(path.join(extracted, "textures", "Example.dds"), "other folder");
    await expect(
      install(h, [{ type: "copy", source: "TEXTURES/Example.dds", destination: "result.dds" }]),
    ).rejects.toThrow("ambiguous filename casing");
    expect(await readdir(staging)).toEqual([]);
  });

  test("still reports files absent from the archive", async ({ makeInstallManager }) => {
    const h = makeInstallManager();
    await install(h, [
      { type: "copy", source: "textures/missing.dds", destination: "missing.dds" },
    ]);
    expect(h.errorNotifications).toHaveLength(1);
    expect(h.errorNotifications[0].message).toEqual(
      expect.stringContaining("Textures/missing.dds"),
    );
    expect(await readdir(staging)).toEqual([]);
  });

  test("does not resolve a source outside the extracted archive", async ({
    makeInstallManager,
  }) => {
    const h = makeInstallManager();
    await writeFile(path.join(root, "outside.dds"), "outside");
    await expect(
      install(h, [{ type: "copy", source: "..\\outside.dds", destination: "result.dds" }]),
    ).rejects.toBeInstanceOf(ProcessCanceled);
    expect(await readdir(staging)).toEqual([]);
  });

  test.for(["..\\outside.dds", "//../../outside.dds"])(
    "rejects a destination escaping staging (%s)",
    async (destination, { makeInstallManager }) => {
      const h = makeInstallManager();
      await expect(
        install(h, [{ type: "copy", source: "Textures/Example.dds", destination }]),
      ).rejects.toThrow("Invalid installer instructions");
      expect(await readdir(staging)).toEqual([]);
    },
  );

  test("falls back to copying when a hardlink crosses filesystems", async ({
    makeInstallManager,
  }) => {
    const h = makeInstallManager();
    vi.spyOn(fs, "linkAsync").mockRejectedValue(
      Object.assign(new Error("cross device"), { code: "EXDEV" }),
    );
    await install(h, [{ type: "copy", source: "textures/example.dds", destination: "copied.dds" }]);
    expect(await readFile(path.join(staging, "copied.dds"), "utf8")).toBe("texture");
    expect(await readFile(path.join(extracted, "Textures", "Example.dds"), "utf8")).toBe("texture");
  });

  test.for(["EACCES", "ENOSPC", "EIO"])(
    "propagates a copy failure (%s)",
    async (code, { makeInstallManager }) => {
      const h = makeInstallManager();
      vi.spyOn(fs, "linkAsync").mockRejectedValue(
        Object.assign(new Error("cross device"), { code: "EXDEV" }),
      );
      const error = Object.assign(new Error("copy failed"), { code });
      vi.spyOn(fs, "copyAsync").mockRejectedValue(error);
      await expect(
        install(h, [{ type: "copy", source: "textures/example.dds", destination: "failed.dds" }]),
      ).rejects.toBe(error);
      expect(await readdir(staging)).toEqual([]);
    },
  );

  test("replaces a stale destination with the resolved archive source", async ({
    makeInstallManager,
  }) => {
    const h = makeInstallManager();
    await writeFile(path.join(staging, "existing.dds"), "stale");
    await install(h, [
      { type: "copy", source: "textures/example.dds", destination: "existing.dds" },
    ]);
    expect(await readFile(path.join(staging, "existing.dds"), "utf8")).toBe("texture");
  });
});

describe("installer path normalization", () => {
  it("leaves error text and attribute values unchanged", () => {
    const error: IInstruction = { type: "error", source: "C:\\example\\failed", value: "fatal" };
    const attribute: IInstruction = { type: "attribute", key: "example", value: "C:\\example" };
    expect(normalizeInstallerInstruction(error, "linux")).toBe(error);
    expect(normalizeInstallerInstruction(attribute, "linux")).toBe(attribute);
  });

  it("keeps Windows instructions unchanged", () => {
    const instruction: IInstruction = {
      type: "copy",
      source: "Textures\\Example.dds",
      destination: "Textures\\Example.dds",
    };
    expect(normalizeInstallerInstruction(instruction, "win32")).toBe(instruction);
  });
});
