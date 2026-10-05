import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { util } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ARCWrapper, { parseARCList } from "./ARCWrapper";
import { arcGameId, arcVersion } from "./gameSupport";

const helpers = util as any;
let root: string;
let archive: string;
const discovery = { path: "/Secondary Library/Dragon's Dogma", store: "steam" };
const api = {
  store: {
    getState: () => ({
      settings: {
        gameMode: { discovered: { dragonsdogma: discovery, other: { path: "/Other game" } } },
      },
    }),
  },
} as any;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "vortex-arc-test-"));
  archive = path.join(root, "original & ; =.arc.vortex_backup");
  await writeFile(archive, "original archive");
  helpers.getVortexPath.mockReturnValue(root);
  helpers.getProtonToolCommand.mockImplementation(async (executable, args, selected) => {
    if (!selected) throw new Error("No discovered game");
    return {
      executable: "/Selected Proton/proton",
      args: args.map((arg) => (typeof arg === "string" ? arg : arg.path)),
      env: { SELECTED_PREFIX: "yes" },
    };
  });
  helpers.executeToolProcess.mockResolvedValue({
    stdout: "",
    stderr: "Proton: benign diagnostic\n",
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function expectWorkspaceClean() {
  expect(await readdir(path.join(root, "temp", "archive-tools"))).toEqual([]);
}

describe("ARC operations on Linux", () => {
  it("keeps the last record, equals signs and host separators", () => {
    expect(parseARCList("Path=folder\\one=two.tex\r\nRealSize=9\r\nPath=last.tex")).toEqual([
      "folder/one=two.tex",
      "last.tex",
    ]);
  });
  it("accepts unknown game IDs without throwing during archive registration", () => {
    expect(arcGameId("unknown")).toBeUndefined();
    expect(arcVersion("unknown")).toBeUndefined();
  });
  it("lists a private copy using the requested game's discovery", async () => {
    helpers.executeToolProcess.mockImplementation(async (_exe, args) => {
      await writeFile(args.at(-1) + ".verbose.txt", "Path=first.tex\nPath=last.tex");
      return { stdout: "", stderr: "Proton: harmless" };
    });
    expect(await new ARCWrapper(api, "dragonsdogma").list(archive)).toEqual([
      "first.tex",
      "last.tex",
    ]);
    expect(helpers.getProtonToolCommand.mock.calls[0][2]).toBe(discovery);
    expect(helpers.executeToolProcess.mock.calls[0][2].env.SELECTED_PREFIX).toBe("yes");
    expect(await readFile(archive, "utf8")).toBe("original archive");
    await expectWorkspaceClean();
  });
  it("preserves the original archive and old extraction on a tool failure", async () => {
    const output = path.join(root, "extracted");
    await mkdir(output);
    await writeFile(path.join(output, "old"), "keep");
    helpers.executeToolProcess.mockRejectedValue(
      Object.assign(new Error("Tool failed"), { code: 1 }),
    );
    await expect(new ARCWrapper(api, "dragonsdogma").extract(archive, output)).rejects.toThrow(
      "Tool failed",
    );
    expect(await readFile(archive, "utf8")).toBe("original archive");
    expect(await readFile(path.join(output, "old"), "utf8")).toBe("keep");
    await expectWorkspaceClean();
  });
  it("preserves the archive when the prefix cannot be prepared", async () => {
    await expect(new ARCWrapper(api).extract(archive, path.join(root, "output"))).rejects.toThrow(
      "No discovered game",
    );
    expect(await readFile(archive, "utf8")).toBe("original archive");
    await expectWorkspaceClean();
  });
  it("detects a status-zero ARCtool error", async () => {
    helpers.executeToolProcess.mockResolvedValue({ stdout: "Error: invalid ARC\n", stderr: "" });
    await expect(new ARCWrapper(api, "dragonsdogma").list(archive)).rejects.toThrow("invalid ARC");
    await expectWorkspaceClean();
  });
  it("requires extraction output and its file-order sidecar", async () => {
    await expect(
      new ARCWrapper(api, "dragonsdogma").extract(archive, path.join(root, "output")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(archive, "utf8")).toBe("original archive");
    await expectWorkspaceClean();
  });
  it("retains the file-order sidecar when extracting a backup archive", async () => {
    helpers.executeToolProcess.mockImplementation(async (_exe, args) => {
      const input = args.at(-1);
      const extracted = input.slice(0, -4);
      await mkdir(extracted);
      await writeFile(path.join(extracted, "one.tex"), "one");
      await writeFile(input + ".txt", "one.tex\n");
      return { stdout: "", stderr: "" };
    });
    const output = path.join(root, "output");
    await new ARCWrapper(api, "dragonsdogma").extract(archive, output);
    expect(await readFile(output + ".arc.txt", "utf8")).toBe("one.tex\n");
    expect(await readFile(path.join(output, "one.tex"), "utf8")).toBe("one");
    expect(await readFile(archive, "utf8")).toBe("original archive");
    await expectWorkspaceClean();
  });
  it("does not replace an existing archive if creation produces invalid data", async () => {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(source + ".arc.txt", "order");
    helpers.executeToolProcess.mockImplementation(async (_exe, args) => {
      await writeFile(args.at(-1) + ".arc", "invalid archive");
      return { stdout: "", stderr: "" };
    });
    await expect(new ARCWrapper(api, "dragonsdogma").create(archive, source)).rejects.toThrow(
      "valid archive",
    );
    expect(await readFile(archive, "utf8")).toBe("original archive");
    await expectWorkspaceClean();
  });
  it("publishes only a successful archive and preserves the source directory", async () => {
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "file.tex"), "file");
    await writeFile(source + ".arc.txt", "file.tex\n");
    await writeFile(source + ".arc", "caller-owned archive");
    helpers.executeToolProcess.mockImplementation(async (_exe, args) => {
      expect(args).toContain("-txt");
      expect(await readFile(args.at(-1) + ".arc.txt", "utf8")).toBe("file.tex\n");
      await writeFile(args.at(-1) + ".arc", Buffer.from("ARC\0\x07\0\x01\0payload"));
      return { stdout: "", stderr: "" };
    });
    await new ARCWrapper(api, "dragonsdogma").create(archive, source);
    expect((await readFile(archive)).subarray(0, 4)).toEqual(Buffer.from("ARC\0"));
    expect(await readFile(source + ".arc", "utf8")).toBe("caller-owned archive");
    expect(await readFile(path.join(source, "file.tex"), "utf8")).toBe("file");
    expect((await readdir(root)).filter((name) => name.startsWith(".vortex-arc"))).toEqual([]);
    await expectWorkspaceClean();
  });
});
