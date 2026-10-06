import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { types } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installScriptExtender, testSupported } from "./installer";
import { getScriptExtenderVersion } from "./util";

describe("script extender archives", () => {
  let extracted: string;
  let loader: Buffer;
  const api = {
    getState: () => ({ settings: { gameMode: { discovered: {} } } }),
  } as unknown as types.IExtensionApi;

  beforeEach(async () => {
    extracted = await mkdtemp(path.join(os.tmpdir(), "vortex-skse-archive-"));
    const fixture = JSON.parse(
      await readFile(
        path.resolve(
          import.meta.dirname,
          "../../../packages/exe-version/test-fixtures/skse-loader.json",
        ),
        "utf8",
      ),
    );
    loader = Buffer.from(fixture.data, "base64");
  });

  afterEach(async () => rm(extracted, { recursive: true, force: true }));

  const extractLoader = async (file: string) => {
    const target = path.join(extracted, ...file.replace(/\\/g, "/").split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, loader);
    return target;
  };

  it.each([
    "skse_loader.exe",
    "SKSE_LOADER.EXE",
    "skse_1_7_3/skse_loader.exe",
    "skse_1_7_3\\SKSE_LOADER.EXE",
  ])("recognizes the LE loader at %s", async (file) => {
    expect(await testSupported([file], "skyrim")).toEqual({ supported: true, requiredFiles: [] });
  });

  it.each([
    ["skyrim", "skse64_loader.exe"],
    ["skyrimse", "skse_loader.exe"],
    ["skyrim", "skse_loader.exe/"],
    ["skyrim", "skse_loader.exe\\"],
    ["stardewvalley", "skse_loader.exe"],
  ])("does not recognize %s / %s as a matching extender", async (gameId, file) => {
    expect((await testSupported([file], gameId)).supported).toBe(false);
  });

  it("keeps root DLLs, Data scripts and extensionless files from an unwrapped archive", async () => {
    await extractLoader("skse_loader.exe");
    const files = [
      "skse_loader.exe",
      "skse_1_9_32.dll",
      "Data/Scripts/skseloader.pex",
      "LICENSE",
      "Data/",
    ];
    const { instructions } = await installScriptExtender(api, files, extracted, "skyrim");
    expect(instructions.filter((item) => item.type === "copy")).toEqual(
      files.slice(0, -1).map((file) => ({
        type: "copy",
        source: path.join(...file.split("/")),
        destination: path.join(...file.split("/")),
      })),
    );
    expect(instructions).toContainEqual({ type: "setmodtype", value: "dinput" });
    expect(instructions).toContainEqual({ type: "attribute", key: "version", value: "1.7.3" });
    expect(instructions).toContainEqual({
      type: "rule",
      rule: {
        reference: {
          logicalFileName: "Skyrim Script Extender (SKSE)",
          versionMatch: "<1.7.3 || >1.7.3",
        },
        type: "conflicts",
        comment: "Incompatible Script Extender",
      },
    });
  });

  it.each(["/", "\\"])(
    "strips only the loader's wrapper using %s separators",
    async (separator) => {
      const wrapper = "skse_loader.exe backup/skse_1_7_3";
      const files = [
        `${wrapper}/SKSE_LOADER.EXE`,
        `${wrapper}/skse_1_9_32.dll`,
        `${wrapper}/Data/Scripts/skseloader.pex`,
        `${wrapper}/LICENSE`,
        `${wrapper}/Data/`,
        `${wrapper}0/unrelated.dll`,
        `outside/${wrapper}/unrelated.pex`,
        "README.txt",
      ].map((file) => file.replaceAll("/", separator));
      await extractLoader(files[0]);
      const { instructions } = await installScriptExtender(api, files, extracted, "skyrim");
      expect(
        instructions.filter((item) => item.type === "copy").map((item) => item.destination),
      ).toEqual([
        "SKSE_LOADER.EXE",
        "skse_1_9_32.dll",
        path.join("Data", "Scripts", "skseloader.pex"),
        "LICENSE",
      ]);
    },
  );

  it("rejects archives with multiple loader roots instead of choosing a version by file order", async () => {
    await expect(
      installScriptExtender(
        api,
        ["old/skse_loader.exe", "new/skse_loader.exe"],
        extracted,
        "skyrim",
      ),
    ).rejects.toThrow("found 2");
  });

  it("reports missing loaders and unsupported games", async () => {
    await expect(
      installScriptExtender(api, ["Data/Scripts/test.pex"], extracted, "skyrim"),
    ).rejects.toThrow("found 0");
    await expect(
      installScriptExtender(api, ["skse_loader.exe"], extracted, "stardewvalley"),
    ).rejects.toThrow("not supported");
  });

  it("does not create undefined version metadata or conflict rules for a damaged loader", async () => {
    const target = await extractLoader("skse_loader.exe");
    await writeFile(target, "not a Windows PE");
    expect(await getScriptExtenderVersion(target)).toBeUndefined();
    await expect(
      installScriptExtender(api, ["skse_loader.exe"], extracted, "skyrim"),
    ).rejects.toThrow("Could not read the version");
  });

  it("reports no installed version for a missing loader", async () => {
    expect(await getScriptExtenderVersion(path.join(extracted, "missing.exe"))).toBeUndefined();
  });

  it.each([
    "../skse_loader.exe",
    "/skse_loader.exe",
    "C:\\skse_loader.exe",
    "skse/skse_loader.exe/../skse_loader.exe",
  ])(
    "rejects an invalid archive source %s before reading a loader outside extraction",
    async (file) => {
      await expect(installScriptExtender(api, [file], extracted, "skyrim")).rejects.toThrow(
        "Invalid script extender archive path",
      );
    },
  );
});
