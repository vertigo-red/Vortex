import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { archiveOutputPath } from "./archivePath";
import { BA2Archive } from "./ba2";

describe("archive extraction paths", () => {
  it("maps Windows archive separators to host directories", () => {
    expect(archiveOutputPath("/game", "textures\\armor\\file.dds")).toBe(
      path.join("/game", "textures", "armor", "file.dds"),
    );
  });
  it.each([
    "../escape",
    "data\\..\\escape",
    "/etc/file",
    "C:\\file",
    "C:file",
    "\\\\server\\file",
    "",
    "nul\0file",
  ])("rejects invalid path %j", (name) => {
    expect(() => archiveOutputPath("/game", name)).toThrow("Invalid archive path");
  });
  it("extracts a BA2 entry into a directory on the host filesystem", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-ba2-path-"));
    try {
      const source = path.join(root, "payload");
      await fs.writeFile(source, "test");
      const archive = new BA2Archive(
        source,
        { type: "general", version: 1 } as any,
        ["meshes\\test.nif"],
        [{ offset: 0, packedLen: 0, unpackedLen: 4 } as any],
      );
      const output = path.join(root, "out");
      await archive.extractAll(output);
      expect(await fs.readFile(path.join(output, "meshes", "test.nif"), "utf8")).toBe("test");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
