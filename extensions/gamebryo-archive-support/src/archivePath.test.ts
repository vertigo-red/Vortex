import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { archiveOutputPath, prepareArchiveOutputPath } from "./archivePath";
import { BA2Archive } from "./ba2";

describe("archive extraction paths", () => {
  it("maps Windows separators", () => {
    expect(archiveOutputPath("/game", "textures\\armor\\file.dds"))
      .toBe(path.join("/game", "textures", "armor", "file.dds"));
  });
  it.each(["../escape", "data\\..\\escape", "/etc/file", "C:\\file", "C:file", "\\\\server\\file", "", "nul\0file"])
    ("rejects invalid path %j", (name) => expect(() => archiveOutputPath("/game", name)).toThrow("Invalid archive path"));
  it("extracts a BA2 entry through the production path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-ba2-path-"));
    try {
      const source = path.join(root, "payload"); await fs.writeFile(source, "test");
      const archive = new BA2Archive(source, { type: "general", version: 1 } as any,
        ["meshes\\test.nif"], [{ offset: 0, packedLen: 0, unpackedLen: 4 } as any]);
      const output = path.join(root, "out"); await archive.extractAll(output);
      expect(await fs.readFile(path.join(output, "meshes", "test.nif"), "utf8")).toBe("test");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.runIf(process.platform !== "win32")("rejects a parent symlink escaping root", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-archive-link-"));
    try {
      const root = path.join(base, "root"), outside = path.join(base, "outside");
      await fs.mkdir(root); await fs.mkdir(outside);
      const sentinel = path.join(outside, "sentinel.txt"); await fs.writeFile(sentinel, "unchanged");
      await fs.symlink(outside, path.join(root, "Data"));
      await expect(prepareArchiveOutputPath(root, "Data/probe.txt")).rejects.toThrow("symlink");
      expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged");
      await expect(fs.stat(path.join(outside, "probe.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  it.runIf(process.platform !== "win32")("allows root itself to be a symlink", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-archive-root-link-"));
    try {
      const realRoot = path.join(base, "real"), linkRoot = path.join(base, "link");
      await fs.mkdir(realRoot); await fs.symlink(realRoot, linkRoot);
      expect(await prepareArchiveOutputPath(linkRoot, "Data/file.txt")).toBe(path.join(realRoot, "Data", "file.txt"));
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  it.runIf(process.platform !== "win32")("rejects a final output symlink", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-archive-final-link-"));
    try {
      const root = path.join(base, "root"), outside = path.join(base, "outside.txt");
      await fs.mkdir(root); await fs.writeFile(outside, "sentinel"); await fs.symlink(outside, path.join(root, "file.txt"));
      await expect(prepareArchiveOutputPath(root, "file.txt")).rejects.toThrow("symlink");
      expect(await fs.readFile(outside, "utf8")).toBe("sentinel");
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
});
