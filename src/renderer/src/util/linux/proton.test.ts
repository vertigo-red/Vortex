import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../fs", async () => {
  const fs = await import("node:fs/promises");
  return { statAsync: fs.stat, readFileAsync: fs.readFile, readdirAsync: fs.readdir };
});
vi.mock("../log", () => ({ log: vi.fn() }));

import {
  buildProtonCommand,
  buildProtonEnvironment,
  detectProtonUsage,
  getConfiguredProtonName,
  getProtonInfo,
  resolveProtonPath,
  findLatestProton,
} from "./proton";

let root: string;
let alternate: string;
let apps: string;
const appId = "42";
const vdf = (...lines: string[]) => lines.join("\n");
const config = (mapping: string) =>
  vdf(
    '"InstallConfigStore"',
    "{",
    '"Software"',
    "{",
    '"valve"',
    "{",
    '"Steam"',
    "{",
    '"CompatToolMapping"',
    "{",
    mapping,
    "}",
    "}",
    "}",
    "}",
    "}",
  );
async function setMapping(name: string, key: string = appId) {
  await writeFile(
    path.join(root, "config", "config.vdf"),
    config(vdf(`"${key}"`, "{", `"name" "${name}"`, "}")),
  );
}
async function tool(directory: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "proton"), "#!/bin/sh\n", { mode: 0o755 });
  return directory;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vortex-proton-"));
  alternate = path.join(root, "Other Steam Library");
  apps = path.join(alternate, "steamapps");
  await mkdir(path.join(root, "config"));
  await mkdir(path.join(root, "steamapps"));
  await mkdir(path.join(apps, "compatdata", appId, "pfx", "drive_c"), { recursive: true });
  await writeFile(
    path.join(root, "steamapps", "libraryfolders.vdf"),
    vdf('"libraryfolders"', "{", '"7"', "{", `"path" ${JSON.stringify(alternate)}`, "}", "}"),
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Proton resolution", () => {
  it("uses the default compatibility mapping and case-insensitive VDF keys", async () => {
    await setMapping("proton_10", "0");
    expect(await getConfiguredProtonName(root, appId)).toBe("proton_10");
  });
  it("finds the selected Proton in an external library", async () => {
    const installed = await tool(path.join(apps, "common", "Proton 10.0"));
    await setMapping("proton_10");
    expect(await getProtonInfo(root, apps, appId)).toEqual({
      usesProton: true,
      compatDataPath: path.join(apps, "compatdata", appId),
      protonPath: installed,
    });
  });
  it("resolves a custom tool by its manifest even when the directory name differs", async () => {
    const installed = await tool(
      path.join(root, "compatibilitytools.d", "custom-build", "payload"),
    );
    await writeFile(
      path.join(path.dirname(installed), "compatibilitytool.vdf"),
      vdf(
        '"compatibilitytools"',
        "{",
        '"compat_tools"',
        "{",
        '"GE-Proton10-28"',
        "{",
        '"install_path" "payload"',
        "}",
        "}",
        "}",
      ),
    );
    expect(await resolveProtonPath(root, "GE-Proton10-28")).toBe(installed);
  });
  it("does not confuse Proton 9 with Proton 19", async () => {
    await tool(path.join(apps, "common", "Proton 19.0"));
    expect(await resolveProtonPath(root, "proton_9")).toBeUndefined();
  });
  it("does not replace a missing selected build with another installed version", async () => {
    await tool(path.join(apps, "common", "Proton 11.0"));
    await setMapping("proton_9");
    expect((await getProtonInfo(root, apps, appId)).protonPath).toBeUndefined();
  });
  it("rejects an empty compatdata directory as an initialized Wine prefix", async () => {
    await mkdir(path.join(apps, "compatdata", "99"), { recursive: true });
    expect(await detectProtonUsage(apps, "99")).toBe(false);
  });
  it("ignores a stale prefix when Steam explicitly uses the native runtime", async () => {
    await setMapping("steamlinuxruntime_sniper");
    expect(await getProtonInfo(root, apps, appId)).toEqual({ usesProton: false });
  });
  it("reuses the build recorded by Proton when no mapping exists", async () => {
    const installed = await tool(path.join(apps, "common", "Proton 9.0"));
    await writeFile(
      path.join(apps, "compatdata", appId, "config_info"),
      `9.0-100\n${installed}/files/share/fonts\n${installed}/files/lib\n`,
    );
    expect((await getProtonInfo(root, apps, appId)).protonPath).toBe(installed);
  });
  it("orders numeric versions correctly and skips directories without a launcher", async () => {
    await tool(path.join(apps, "common", "Proton 9.0"));
    const latest = await tool(path.join(apps, "common", "Proton 10.0"));
    await mkdir(path.join(apps, "common", "Proton 99.0"));
    expect(await findLatestProton(root)).toBe(latest);
  });
  it("rejects path components in compatibility tool names", async () => {
    expect(await resolveProtonPath(root, "../elsewhere")).toBeUndefined();
  });
});

describe("Proton invocation", () => {
  it("passes arguments separately, including spaces and shell metacharacters", () => {
    expect(buildProtonCommand("/Proton", "/Games/My Game/tool.exe", ["a b", "$(literal)"])).toEqual(
      {
        executable: "/Proton/proton",
        args: ["run", "/Games/My Game/tool.exe", "a b", "$(literal)"],
      },
    );
  });
  it("runs Windows batch files with cmd.exe", () => {
    expect(buildProtonCommand("/Proton", "/Games/start.CMD", ["one"])).toEqual({
      executable: "/Proton/proton",
      args: ["run", "cmd.exe", "/d", "/v:off", "/c", "@", "/Games/start.CMD", "one"],
    });
  });
  it.each(["bat", "CMD"])("preserves ordinary data for a spaced .%s tool path", (extension) => {
    const script = `/Games/Tools '日本語'/Capture Args.${extension}`;
    const args = ["hello world", "", '{"key":"value with space"}', "tail\\", "bang!literal"];
    expect(buildProtonCommand("/Proton", script, args)).toEqual({
      executable: "/Proton/proton",
      args: ["run", "cmd.exe", "/d", "/v:off", "/c", "@", script, ...args],
    });
  });
  it("sets the game's identity and prefix without injecting overlay libraries", () => {
    const environment = buildProtonEnvironment(
      "/Library/steamapps/compatdata/42",
      "/Steam",
      { CUSTOM: "yes", LD_PRELOAD: "/custom.so", SteamAppId: "wrong" },
      "42",
      "/Library/Game",
    );
    expect(environment).toMatchObject({
      CUSTOM: "yes",
      LD_PRELOAD: "/custom.so",
      SteamAppId: "42",
      SteamGameId: "42",
      STEAM_COMPAT_APP_ID: "42",
      STEAM_COMPAT_INSTALL_PATH: "/Library/Game",
      WINEPREFIX: "/Library/steamapps/compatdata/42/pfx",
    });
    expect(buildProtonEnvironment("/compat/42", "/Steam")).not.toHaveProperty("LD_PRELOAD");
  });
});
