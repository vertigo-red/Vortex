import { link, lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import walk, { type IEntry, type IWalkOptions } from "turbowalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
async function entries(options?: IWalkOptions): Promise<IEntry[]> {
  const result: IEntry[] = [];
  await walk(root, (batch) => result.push(...batch), options);
  return result;
}

describe.skipIf(process.platform !== "linux")("Linux directory walker", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vortex-walk-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns file identities and link counts for real hardlinks", async () => {
    const source = path.join(root, "source");
    await writeFile(source, "mod data");
    await link(source, path.join(root, "deployed"));
    const stat = await lstat(source, { bigint: true });
    const files = await entries({ details: true });
    expect(files).toHaveLength(2);
    expect(files.map((file) => file.idStr)).toEqual([
      `${stat.dev}:${stat.ino}`,
      `${stat.dev}:${stat.ino}`,
    ]);
    expect(files.every((file) => file.linkCount === 2)).toBe(true);
  });

  it("returns timestamps in seconds and keeps detail fields optional", async () => {
    const source = path.join(root, "source");
    await writeFile(source, "data");
    await utimes(source, 1700000000, 1700000000);
    expect((await entries())[0]).toMatchObject({ mtime: 1700000000, size: 4 });
    expect((await entries())[0]).not.toHaveProperty("idStr");
  });

  it("honors hidden files, recursion and batch size", async () => {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, ".hidden"), "hidden");
    await writeFile(path.join(root, "nested", "child"), "child");
    expect((await entries({ recurse: false })).map((file) => path.basename(file.filePath))).toEqual(
      ["nested"],
    );
    const batches: IEntry[][] = [];
    await walk(root, (batch) => batches.push(batch), { threshold: 1, skipHidden: false });
    expect(batches).toHaveLength(3);
    expect(batches.every((batch) => batch.length === 1)).toBe(true);
  });

  it("does not recurse through directory symlinks by default", async () => {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "child"), "child");
    await symlink(root, path.join(root, "nested", "loop"));
    const files = await entries();
    expect(files.filter((file) => path.basename(file.filePath) === "child")).toHaveLength(1);
    expect(files.find((file) => path.basename(file.filePath) === "loop")?.isReparsePoint).toBe(
      true,
    );
    expect(await entries({ skipLinks: false })).toHaveLength(3);
  });

  it("marks completed directories when terminators are requested", async () => {
    await mkdir(path.join(root, "nested"));
    const files = await entries({ terminators: true });
    expect(files.filter((file) => file.isTerminator).map((file) => file.filePath)).toEqual([
      path.join(root, "nested"),
      root,
    ]);
  });
});
