import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import PromiseBB from "bluebird";
import { stringify } from "simple-vdf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../fs", () => ({
  statAsync: (p: string) => PromiseBB.resolve(fs.stat(p)),
  readFileAsync: (p: string, encoding: BufferEncoding) =>
    PromiseBB.resolve(fs.readFile(p, encoding)),
  readdirAsync: (p: string) => PromiseBB.resolve(fs.readdir(p)),
}));
vi.mock("../log", () => ({ log: vi.fn() }));

import {
  buildProtonEnvironment,
  detectProtonUsage,
  findLatestProton,
  getConfiguredProtonName,
  getProtonInfo,
  resolveProtonPath,
} from "./proton";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-proton-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function tool(library: string, name: string) {
  const target = path.join(library, "steamapps", "common", name);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "proton"), "#!/usr/bin/env python3\n");
  return target;
}
async function config(mapping: object) {
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(
    path.join(root, "config", "config.vdf"),
    stringify({
      InstallConfigStore: { Software: { valve: { steam: { CompatToolMapping: mapping } } } },
    }),
  );
}
describe("Proton resolution", () => {
  it("requires an initialized prefix rather than an empty compatdata directory", async () => {
    const apps = path.join(root, "steamapps");
    await fs.mkdir(path.join(apps, "compatdata", "10"), { recursive: true });
    expect(await detectProtonUsage(apps, "10")).toBe(false);
    await fs.mkdir(path.join(apps, "compatdata", "10", "pfx", "drive_c"), { recursive: true });
    expect(await detectProtonUsage(apps, "10")).toBe(true);
  });
  it("reads lowercase Steam keys and inherits the global compatibility tool", async () => {
    await config({
      "0": { name: "proton_10" },
      "10": { name: "" },
      "20": { name: "GE-Proton10-28" },
    });
    expect(await getConfiguredProtonName(root, "10")).toBe("proton_10");
    expect(await getConfiguredProtonName(root, "20")).toBe("GE-Proton10-28");
  });
  it("does not match major version 9 to version 19", async () => {
    await tool(root, "Proton 19.0");
    expect(await resolveProtonPath(root, "proton_9")).toBeUndefined();
    const expected = await tool(root, "Proton 9.0");
    expect(await resolveProtonPath(root, "proton_9")).toBe(expected);
  });
  it("finds the configured tool in an external Steam library", async () => {
    const external = path.join(root, "external");
    const expected = await tool(external, "Proton 10.0");
    expect(await resolveProtonPath(root, "proton_10", [external])).toBe(expected);
  });
  it("selects 10 ahead of 9 and ignores incomplete installations", async () => {
    await tool(root, "Proton 9.0");
    const expected = await tool(root, "Proton 10.0");
    await fs.mkdir(path.join(root, "steamapps", "common", "Proton 11.0"));
    expect(await findLatestProton(root)).toBe(expected);
  });
  it("does not silently substitute another tool for an unavailable explicit selection", async () => {
    await config({ "10": { name: "GE-Proton-missing" } });
    await tool(root, "Proton 10.0");
    await fs.mkdir(path.join(root, "steamapps", "compatdata", "10", "pfx", "drive_c"), {
      recursive: true,
    });
    const info = await getProtonInfo(root, path.join(root, "steamapps"), "10");
    expect(info.usesProton).toBe(true);
    expect(info.protonPath).toBeUndefined();
  });
  it("preserves the caller environment without injecting Steam overlays into tools", () => {
    const env = buildProtonEnvironment("/compat/10", "/steam", {
      LD_PRELOAD: "custom.so",
      TEST: "value",
    });
    expect(env.LD_PRELOAD).toBe("custom.so");
    expect(env.TEST).toBe("value");
    expect(env.WINEPREFIX).toBe("/compat/10/pfx");
    expect(buildProtonEnvironment("/compat/10", "/steam")).not.toHaveProperty("LD_PRELOAD");
  });
});
