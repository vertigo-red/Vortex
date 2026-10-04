import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDivineLauncher } from "./divineLauncher";

let root: string;
let tools: string;
let source: string;
let hookSource: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "vortex-divine-launcher-"));
  tools = path.join(root, "Tools 日本語");
  source = path.join(root, "bundled-launcher.exe");
  hookSource = path.join(root, "vortex-divine-utf8.dll");
  await mkdir(tools);
  await writeFile(source, Buffer.from([0, 1, 2, 255]));
  await writeFile(hookSource, Buffer.from([0, 3, 4, 255]));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("bundled Divine launcher staging", () => {
  it("serializes concurrent copies into one complete physical file", async () => {
    const targets = await Promise.all(
      Array.from({ length: 20 }, () => ensureDivineLauncher(tools, source)),
    );
    expect(new Set(targets).size).toBe(1);
    expect(await readFile(targets[0])).toEqual(await readFile(source));
    expect(await readFile(path.join(tools, "vortex-divine-utf8.dll"))).toEqual(
      await readFile(hookSource),
    );
    expect(await readdir(tools)).toEqual(["vortex-divine-launcher.exe", "vortex-divine-utf8.dll"]);
  });

  it("refreshes a launcher left by an older Vortex installation", async () => {
    const target = await ensureDivineLauncher(tools, source);
    await writeFile(source, Buffer.from([0, 8, 9, 255]));
    await writeFile(hookSource, Buffer.from([0, 10, 11, 255]));
    expect(await ensureDivineLauncher(tools, source)).toBe(target);
    expect(await readFile(target)).toEqual(await readFile(source));
    expect(await readFile(path.join(tools, "vortex-divine-utf8.dll"))).toEqual(
      await readFile(hookSource),
    );
  });

  it("restores a removed launcher on the next operation", async () => {
    const target = await ensureDivineLauncher(tools, source);
    await rm(target);
    await rm(path.join(tools, "vortex-divine-utf8.dll"));
    await ensureDivineLauncher(tools, source);
    expect(await readFile(target)).toEqual(await readFile(source));
    expect(await readFile(path.join(tools, "vortex-divine-utf8.dll"))).toEqual(
      await readFile(hookSource),
    );
  });

  it("propagates a missing bundled asset without creating a partial target", async () => {
    await rm(source);
    await expect(ensureDivineLauncher(tools, source)).rejects.toHaveProperty("code", "ENOENT");
    expect(await readdir(tools)).toEqual([]);
    await writeFile(source, "restored");
    const target = await ensureDivineLauncher(tools, source);
    expect(await readFile(target, "utf8")).toBe("restored");
  });

  it("requires the managed output hook before staging either asset", async () => {
    await rm(hookSource);
    await expect(ensureDivineLauncher(tools, source)).rejects.toHaveProperty("code", "ENOENT");
    expect(await readdir(tools)).toEqual([]);
    await writeFile(hookSource, "restored hook");
    await ensureDivineLauncher(tools, source);
    expect(await readFile(path.join(tools, "vortex-divine-utf8.dll"), "utf8")).toBe(
      "restored hook",
    );
  });
});
