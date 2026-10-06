import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type * as fomodT from "@nexusmods/fomod-installer-native";
import Bluebird from "bluebird";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeDeploymentHarness } from "../../test-utils/deploymentTest";
import type { IInstallManagerHarness } from "../../test-utils/harnessTypes";
import { test } from "../../test-utils/installManagerTest";
import type { IExtensionApi } from "../../types/IExtensionContext";
import { ProcessCanceled } from "../../util/CustomErrors";
import * as fs from "../../util/fs";
import { initGameSupport } from "../gamebryo_plugin_management/util/gameSupport";
import PluginPersistor from "../gamebryo_plugin_management/util/PluginPersistor";
import { getGame } from "../gamemode_management/util/getGame";
import { install as installNativeFomod } from "../installer_fomod_native/installer";
import InstallContext from "./InstallContext";
import type { IInstruction } from "./types/IInstallResult";
import type { IChoiceType } from "./types/IMod";
import type { IInstallationDetails } from "./types/InstallFunc";
import BlacklistSet from "./util/BlacklistSet";
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
    gameId = "skyrimse",
  ) => {
    const processor = h.manager as unknown as IInstructionProcessor;
    return processor.processInstructions(
      h.api,
      new InstallContext(gameId, h.api, true),
      path.join(root, "fixture.zip"),
      extracted,
      staging,
      gameId,
      "fixture",
      { instructions, overrideInstructions },
      undefined,
      false,
      {},
    );
  };

  for (const scriptDirectory of ["Data/Scripts", "data/scripts"]) {
    test(`installs and removes a complete SKSE LE package through the game root using existing ${scriptDirectory}`, async ({
      makeInstallManager,
    }) => {
      const h = makeInstallManager();
      const deployment = makeDeploymentHarness({ gameId: "skyrim", files: {} });
      try {
        const gameRoot = path.dirname(deployment.gameDir);
        if (scriptDirectory.startsWith("data/")) await rm(deployment.gameDir, { recursive: true });
        const scripts = path.join(gameRoot, scriptDirectory);
        await mkdir(scripts, { recursive: true });
        await writeFile(path.join(scripts, "SKSEFixture.pex"), "original script");
        await writeFile(path.join(gameRoot, "TESV.exe"), "game fixture");
        deployment.setState((state) => {
          state.settings.gameMode.discovered.skyrim = { path: gameRoot };
        });

        const fixture = JSON.parse(
          await readFile(
            path.resolve(
              __dirname,
              "../../../../../packages/exe-version/test-fixtures/skse-loader.json",
            ),
            "utf8",
          ),
        );
        const wrapper = path.join(extracted, "skse_1_7_3");
        await mkdir(path.join(wrapper, "Data", "Scripts"), { recursive: true });
        await writeFile(path.join(wrapper, "SKSE_LOADER.EXE"), Buffer.from(fixture.data, "base64"));
        await writeFile(path.join(wrapper, "skse_1_9_32.dll"), "SKSE DLL");
        await writeFile(path.join(wrapper, "Data", "Scripts", "sksefixture.pex"), "SKSE script");
        await writeFile(path.join(wrapper, "LICENSE"), "fixture license");

        // Load the bundled extension's source without expanding the renderer's TS project boundary.
        const { installScriptExtender } = await vi.importActual<{
          installScriptExtender: (
            api: IExtensionApi,
            files: string[],
            extracted: string,
            gameId: string,
          ) => Promise<{ instructions: IInstruction[] }>;
        }>("../../../../../extensions/script-extender-installer/src/installer");
        const result = await installScriptExtender(
          deployment.api,
          [
            "skse_1_7_3\\SKSE_LOADER.EXE",
            "skse_1_7_3\\skse_1_9_32.dll",
            "skse_1_7_3\\Data\\Scripts\\sksefixture.pex",
            "skse_1_7_3\\LICENSE",
            "skse_1_7_3\\Data\\",
            "skse_1_7_30\\unrelated.dll",
          ],
          extracted,
          "skyrim",
        );
        await install(h, result.instructions, undefined, "skyrim");

        const mod = path.join(deployment.stagingDir, "SomeMod");
        const copies = result.instructions.filter((item) => item.type === "copy");
        for (const { destination } of copies) {
          await mkdir(path.dirname(path.join(mod, destination)), { recursive: true });
          await copyFile(path.join(staging, destination), path.join(mod, destination));
        }
        expect(result.instructions).toContainEqual({ type: "setmodtype", value: "dinput" });
        const blacklist = new BlacklistSet([], getGame("skyrim"), deployment.normalize);
        await deployment.method.prepare(gameRoot, false, [], deployment.normalize);
        await deployment.method.activate(mod, "SomeMod", "", blacklist);
        const manifest = await deployment.method.finalize(
          "skyrim",
          gameRoot,
          deployment.stagingDir,
        );
        expect(manifest.map((file) => file.relPath).sort()).toEqual(
          [
            path.join(scriptDirectory, "SKSEFixture.pex"),
            "LICENSE",
            "SKSE_LOADER.EXE",
            "skse_1_9_32.dll",
          ].sort(),
        );
        for (const { destination } of copies) {
          const [source, target] = await Promise.all([
            stat(path.join(mod, destination)),
            stat(path.join(gameRoot, destination)),
          ]);
          expect([target.dev, target.ino]).toEqual([source.dev, source.ino]);
        }
        expect(await readFile(path.join(scripts, "SKSEFixture.pex"), "utf8")).toBe("SKSE script");
        const { getScriptExtenderVersion } = await vi.importActual<{
          getScriptExtenderVersion: (filename: string) => Promise<string | undefined>;
        }>("../../../../../extensions/script-extender-installer/src/util");
        expect(await getScriptExtenderVersion(path.join(gameRoot, "skse_loader.exe"))).toBe(
          "1.7.3",
        );
        expect((await readdir(gameRoot)).filter((name) => name.toLowerCase() === "data")).toEqual([
          scriptDirectory.split("/")[0],
        ]);
        expect(h.errorNotifications).toEqual([]);

        await deployment.method.prepare(gameRoot, true, manifest, deployment.normalize);
        await deployment.method.finalize("skyrim", gameRoot, deployment.stagingDir);
        expect(await readFile(path.join(scripts, "SKSEFixture.pex"), "utf8")).toBe(
          "original script",
        );
        expect(await readFile(path.join(gameRoot, "TESV.exe"), "utf8")).toBe("game fixture");
        await expect(stat(path.join(gameRoot, "SKSE_LOADER.EXE"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(stat(path.join(gameRoot, "skse_1_9_32.dll"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        deployment.cleanup();
      }
    });
  }

  for (const scenario of [
    { name: "missing SKSE", installed: false, minimum: "1.7.3", installedFile: false },
    { name: "SKSE 1.7.3", installed: true, minimum: "1.7.3", installedFile: true },
    { name: "a newer required SKSE", installed: true, minimum: "2.0.0", installedFile: false },
  ]) {
    test(`evaluates a real native FOMOD SKSE condition with ${scenario.name}`, async ({
      makeInstallManager,
    }) => {
      const h = makeInstallManager();
      const deployment = makeDeploymentHarness({ gameId: "skyrim", files: {} });
      try {
        const gameRoot = path.dirname(deployment.gameDir);
        deployment.setState((state) => {
          Object.assign(state.session, {
            fomod: { installer: { dialog: { instances: {}, activeInstanceId: null } } },
          });
          state.settings.gameMode.discovered.skyrim = { path: gameRoot };
        });
        getGame("skyrim").getGameVersion = () => Bluebird.resolve("1.9.32.0");
        if (scenario.installed) {
          const fixture = JSON.parse(
            await readFile(
              path.resolve(
                __dirname,
                "../../../../../packages/exe-version/test-fixtures/skse-loader.json",
              ),
              "utf8",
            ),
          );
          await writeFile(
            path.join(gameRoot, "SKSE_LOADER.EXE"),
            Buffer.from(fixture.data, "base64"),
          );
        }
        await mkdir(path.join(extracted, "fomod"));
        await writeFile(
          path.join(extracted, "fomod", "ModuleConfig.xml"),
          '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
            'xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">' +
            "<moduleName>SKSE fixture</moduleName><conditionalFileInstalls><patterns><pattern>" +
            `<dependencies operator="And"><skseDependency version="${scenario.minimum}" /></dependencies>` +
            '<files><file source="Textures\\Example.dds" destination="Textures\\SKSE.dds" /></files>' +
            "</pattern></patterns></conditionalFileInstalls></config>",
        );
        const { NativeLogger } = require("@nexusmods/fomod-installer-native") as typeof fomodT;
        new NativeLogger(() => undefined).setCallbacks();
        const result = await installNativeFomod(
          deployment.api,
          ["fomod/ModuleConfig.xml", "Textures/Example.dds"],
          extracted,
          "skyrim",
          undefined,
          true,
          { hasXmlConfigXML: true },
        );
        await install(h, result.instructions, undefined, "skyrim");
        if (scenario.installedFile) {
          expect(await readFile(path.join(staging, "Textures", "SKSE.dds"), "utf8")).toBe(
            "texture",
          );
        } else {
          await expect(stat(path.join(staging, "Textures", "SKSE.dds"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        expect(h.errorNotifications).toEqual([]);
      } finally {
        deployment.cleanup();
      }
    });
  }

  for (const scenario of [
    {
      name: "missing SKSE",
      installed: "absent",
      minimum: "1.7.3",
      error: /requires skse v1\.7\.3.*Please download/i,
    },
    {
      name: "an unreadable SKSE loader",
      installed: "unreadable",
      minimum: "1.7.3",
      error: /requires skse v1\.7\.3.*Please download/i,
    },
    { name: "SKSE 1.7.3", installed: "valid", minimum: "1.7.3" },
    {
      name: "an older installed SKSE",
      installed: "valid",
      minimum: "2.0.0",
      error: /requires skse v2\.0\.0.*You have 1\.7\.3/i,
    },
    {
      name: "missing SKSE with a zero minimum",
      installed: "absent",
      minimum: "0.0.0",
      error: /requires skse v0\.0\.0.*Please download/i,
    },
    {
      name: "a satisfied alternative to SKSE",
      installed: "absent",
      minimum: "1.7.3",
      alternative: true,
    },
    {
      name: "missing SKSE with saved unattended choices",
      installed: "absent",
      minimum: "1.7.3",
      preset: true,
      error: /requires skse v1\.7\.3.*Please download/i,
    },
  ]) {
    test(`handles a mandatory native FOMOD dependency with ${scenario.name}`, async ({
      makeInstallManager,
    }) => {
      const h = makeInstallManager();
      const deployment = makeDeploymentHarness({ gameId: "skyrim", files: {} });
      try {
        const gameRoot = path.dirname(deployment.gameDir);
        deployment.setState((state) => {
          Object.assign(state.session, {
            fomod: { installer: { dialog: { instances: {}, activeInstanceId: null } } },
          });
          state.settings.gameMode.discovered.skyrim = { path: gameRoot };
        });
        getGame("skyrim").getGameVersion = () => Bluebird.resolve("1.9.32.0");
        const fixture = JSON.parse(
          await readFile(
            path.resolve(
              __dirname,
              "../../../../../packages/exe-version/test-fixtures/skse-loader.json",
            ),
            "utf8",
          ),
        );
        const loader = path.join(gameRoot, "SKSE_LOADER.EXE");
        if (scenario.installed !== "absent") {
          await writeFile(
            loader,
            scenario.installed === "valid"
              ? Buffer.from(fixture.data, "base64")
              : "unreadable loader",
          );
        }
        await mkdir(path.join(extracted, "fomod"));
        await writeFile(
          path.join(extracted, "fomod", "ModuleConfig.xml"),
          '<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
            'xsi:noNamespaceSchemaLocation="http://qconsulting.ca/fo3/ModConfig5.0.xsd">' +
            "<moduleName>SKSE requirement fixture</moduleName>" +
            `<moduleDependencies operator="${scenario.alternative ? "Or" : "And"}">` +
            `<skseDependency version="${scenario.minimum}" />` +
            (scenario.alternative ? '<gameDependency version="1.9.32.0" />' : "") +
            "</moduleDependencies>" +
            '<requiredInstallFiles><file source="Textures\\Example.dds" destination="Textures\\SKSE.dds" /></requiredInstallFiles>' +
            "</config>",
        );
        const { NativeLogger } = require("@nexusmods/fomod-installer-native") as typeof fomodT;
        new NativeLogger(() => undefined).setCallbacks();
        const invoke = () =>
          installNativeFomod(
            deployment.api,
            ["fomod/ModuleConfig.xml", "Textures/Example.dds"],
            extracted,
            "skyrim",
            scenario.preset ? { type: "fomod", options: [] } : undefined,
            true,
            { hasXmlConfigXML: true },
          );
        const result = await invoke();
        if (scenario.error) {
          expect(result.instructions).toContainEqual(
            expect.objectContaining({
              type: "error",
              value: "fatal",
              source: expect.stringMatching(scenario.error),
            }),
          );
          expect(result.instructions.some((instruction) => instruction.type === "copy")).toBe(
            false,
          );
          await expect(install(h, result.instructions, undefined, "skyrim")).rejects.toThrow(
            scenario.error,
          );
          expect(h.errorNotifications).toEqual([
            expect.objectContaining({
              title: "Installer reported errors",
              allowReport: false,
            }),
          ]);
          expect(await readdir(staging)).toEqual([]);
          expect(await readdir(deployment.gameDir)).toEqual([]);
          expect(deployment.dialogCalls).toEqual([]);
          if (scenario.name === "missing SKSE") {
            await writeFile(loader, Buffer.from(fixture.data, "base64"));
            const retry = await invoke();
            expect(retry.instructions.some((instruction) => instruction.type === "error")).toBe(
              false,
            );
            await install(h, retry.instructions, undefined, "skyrim");
            expect(await readFile(path.join(staging, "Textures", "SKSE.dds"), "utf8")).toBe(
              "texture",
            );
          }
        } else {
          await install(h, result.instructions, undefined, "skyrim");
          expect(await readFile(path.join(staging, "Textures", "SKSE.dds"), "utf8")).toBe(
            "texture",
          );
          expect(h.errorNotifications).toEqual([]);
        }
      } finally {
        deployment.cleanup();
      }
    });
  }

  test("installs and deploys a wrapped Skyrim LE mod, persists original-format plugins and removes its links", async ({
    makeInstallManager,
  }) => {
    const h = makeInstallManager();
    const deployment = makeDeploymentHarness({ gameId: "skyrim", files: {} });
    const errors = vi.fn();
    const persistor = new PluginPersistor(errors, () => true, vi.fn());
    try {
      const prefix = path.join(root, "Wine Prefix");
      const user = path.join(prefix, "drive_c", "users", "Player");
      const pluginDir = path.join(user, "AppData", "Local", "Skyrim");
      await mkdir(pluginDir, { recursive: true });
      await mkdir(path.join(user, "Documents"));
      await writeFile(path.join(prefix, "user.reg"), "WINE REGISTRY Version 2\n");
      deployment.setState((state) => {
        Object.assign(state.session, {
          fomod: { installer: { dialog: { instances: {}, activeInstanceId: null } } },
        });
        state.settings.gameMode.discovered.skyrim = {
          path: path.dirname(deployment.gameDir),
          modSettingsPrefix: prefix,
        };
      });
      getGame("skyrim").queryModPath = () => "Data";
      getGame("skyrim").executable = () => "TESV.exe";
      await initGameSupport(deployment.api);
      const wrapped = path.join(extracted, "LE Mod", "Data");
      await mkdir(path.join(wrapped, "Textures"), { recursive: true });
      const corpus = path.resolve(
        __dirname,
        "../gamebryo_plugin_management/esp/__tests__/corpus/skyrim/skyrim_mod23890_1000127601.esp",
      );
      await copyFile(corpus, path.join(wrapped, "LEFixture.esp"));
      await writeFile(path.join(wrapped, "Textures", "Fixture.dds"), "LE texture");
      const files = ["LE Mod/Data/LEFixture.esp", "LE Mod/Data/Textures/Fixture.dds"];
      const { NativeLogger } = require("@nexusmods/fomod-installer-native") as typeof fomodT;
      new NativeLogger(() => undefined).setCallbacks();
      const result = await installNativeFomod(
        deployment.api,
        files,
        extracted,
        "skyrim",
        undefined,
        true,
        {},
      );
      await install(h, result.instructions, undefined, "skyrim");
      expect(await readFile(path.join(staging, "LEFixture.esp"))).toEqual(await readFile(corpus));
      expect((await readdir(staging)).sort()).toEqual(["LEFixture.esp", "Textures"]);
      const mod = path.join(deployment.stagingDir, "SomeMod");
      await copyFile(path.join(staging, "LEFixture.esp"), path.join(mod, "LEFixture.esp"));
      await mkdir(path.join(mod, "Textures"));
      await copyFile(
        path.join(staging, "Textures", "Fixture.dds"),
        path.join(mod, "Textures", "Fixture.dds"),
      );
      const manifest = await deployment.deploy();
      expect(manifest.map((file) => file.relPath).sort()).toEqual([
        "LEFixture.esp",
        "Textures/Fixture.dds",
      ]);
      const [source, target] = await Promise.all([
        stat(path.join(mod, "LEFixture.esp")),
        stat(deployment.inGame("LEFixture.esp")),
      ]);
      expect([target.dev, target.ino]).toEqual([source.dev, source.ino]);
      await writeFile(deployment.inGame("Disabled.esp"), "TES4");
      await writeFile(deployment.inGame("Skyrim.esm"), "TES4");
      await writeFile(deployment.inGame("Update.esm"), "TES4");
      await writeFile(
        path.join(pluginDir, "plugins.txt"),
        "# Existing profile\r\nDisabled.esp\r\n",
      );
      persistor.setResetCallback(() => Promise.resolve());
      persistor.setKnownPlugins({
        "lefixture.esp": "LEFixture.esp",
        "disabled.esp": "Disabled.esp",
        "skyrim.esm": "Skyrim.esm",
        "update.esm": "Update.esm",
      });
      await persistor.loadFiles("skyrim");
      await persistor.syncFromState("skyrim", {
        "lefixture.esp": { enabled: true, loadOrder: 2 },
        "disabled.esp": { enabled: false, loadOrder: 3 },
      });
      const enabled = (await readFile(path.join(pluginDir, "plugins.txt"), "latin1"))
        .split(/\r?\n/)
        .filter((line) => line !== "" && !line.startsWith("#"));
      expect(enabled).toEqual(["Skyrim.esm", "Update.esm", "LEFixture.esp"]);
      expect(await readFile(path.join(pluginDir, "loadorder.txt"), "utf8")).toContain(
        "LEFixture.esp\r\nDisabled.esp",
      );
      expect(errors).not.toHaveBeenCalled();
      expect(h.errorNotifications).toEqual([]);
      await deployment.method.prepare(deployment.gameDir, true, manifest, deployment.normalize);
      await deployment.method.finalize("skyrim", deployment.gameDir, deployment.stagingDir);
      await expect(stat(deployment.inGame("LEFixture.esp"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(deployment.inGame("Disabled.esp"), "utf8")).toBe("TES4");
    } finally {
      await persistor.disable();
      deployment.cleanup();
    }
  });

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
