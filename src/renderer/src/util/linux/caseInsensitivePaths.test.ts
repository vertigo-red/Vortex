import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CaseInsensitivePathResolver } from "./caseInsensitivePaths";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-case-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
describe("Windows mod paths on Linux", () => {
  it("uses existing directory and filename casing", async () => {
    await fs.mkdir(path.join(root, "Data", "Textures"), { recursive: true });
    await fs.writeFile(path.join(root, "Data", "Textures", "Armor.dds"), "original");
    expect(await new CaseInsensitivePathResolver(root).resolve("data\\textures\\ARMOR.dds")).toBe(
      path.join("Data", "Textures", "Armor.dds"),
    );
  });
  it("reserves a consistent spelling for concurrently created directories", async () => {
    const resolver = new CaseInsensitivePathResolver(root);
    const results = await Promise.all([
      resolver.resolve("Data/Textures/a.dds"),
      resolver.resolve("data/textures/b.dds"),
    ]);
    expect(path.dirname(results[0])).toBe(path.dirname(results[1]));
  });
  it("keeps the original spelling after unlinking a replaced file", async () => {
    await fs.writeFile(path.join(root, "File.ini"), "original");
    const resolver = new CaseInsensitivePathResolver(root);
    await resolver.resolve("file.ini");
    await fs.unlink(path.join(root, "File.ini"));
    expect(await resolver.resolve("FILE.INI")).toBe("File.ini");
  });
  it.runIf(process.platform === "linux")(
    "rejects ambiguous names before overwriting either file",
    async () => {
      await fs.writeFile(path.join(root, "File.ini"), "one");
      await fs.writeFile(path.join(root, "file.ini"), "two");
      await expect(new CaseInsensitivePathResolver(root).resolve("FILE.INI")).rejects.toThrow(
        "Ambiguous",
      );
    },
  );
  it.each(["../outside", "Data/../../outside", "/absolute", "C:\\outside", "\\\\server\\share"])(
    "rejects escaping path %s",
    async (value) => {
      await expect(new CaseInsensitivePathResolver(root).resolve(value)).rejects.toThrow("escapes");
    },
  );
});
