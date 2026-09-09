import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PathContainmentError, SafePathBoundary } from "./safePath";

let temp: string;
let root: string;
let outside: string;

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-safe-path-"));
  root = path.join(temp, "root");
  outside = path.join(temp, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
});

afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

describe("SafePathBoundary", () => {
  it("rejects lexical traversal and foreign absolute paths", async () => {
    const boundary = await SafePathBoundary.create(root);
    expect(() => boundary.resolve("../outside/probe")).toThrow(PathContainmentError);
    expect(() => boundary.resolve("C:\\outside\\probe")).toThrow(PathContainmentError);
    expect(() => boundary.resolve("\\\\server\\share\\probe")).toThrow(PathContainmentError);
    expect(() => boundary.resolve("bad\0name")).toThrow(PathContainmentError);
    await expect(boundary.assertMutation(path.join(outside, "probe"))).rejects.toBeInstanceOf(
      PathContainmentError,
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects a nested symlink escape without touching the external sentinel",
    async () => {
      const sentinel = path.join(outside, "sentinel.txt");
      await fs.writeFile(sentinel, "outside");
      await fs.symlink(outside, path.join(root, "Data"));
      const boundary = await SafePathBoundary.create(root);
      await expect(boundary.assertMutation(path.join(root, "Data", "sentinel.txt"))).rejects.toBeInstanceOf(
        PathContainmentError,
      );
      expect(await fs.readFile(sentinel, "utf8")).toBe("outside");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rechecks a parent replaced by a symlink after initial validation",
    async () => {
      const boundary = await SafePathBoundary.create(root);
      const data = path.join(root, "Data");
      await boundary.ensureDirectory(data);
      await boundary.assertMutation(path.join(data, "probe.txt"));

      await fs.rmdir(data);
      await fs.symlink(outside, data);
      const sentinel = path.join(outside, "probe.txt");
      await fs.writeFile(sentinel, "sentinel");

      await expect(boundary.assertMutation(path.join(data, "probe.txt"))).rejects.toBeInstanceOf(
        PathContainmentError,
      );
      expect(await fs.readFile(sentinel, "utf8")).toBe("sentinel");
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows the configured root itself to be a symlink",
    async () => {
      const linkedRoot = path.join(temp, "root-link");
      await fs.symlink(root, linkedRoot);
      const boundary = await SafePathBoundary.create(linkedRoot);
      const target = boundary.resolve(path.join("Data", "probe.txt"));
      await boundary.ensureDirectory(path.dirname(target));
      await boundary.assertMutation(target);
      await fs.writeFile(target, "ok");
      expect(await fs.readFile(path.join(root, "Data", "probe.txt"), "utf8")).toBe("ok");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a final symlink for writes but permits entry-only unlink checks",
    async () => {
      const external = path.join(outside, "external.txt");
      const link = path.join(root, "link.txt");
      await fs.writeFile(external, "external");
      await fs.symlink(external, link);
      const boundary = await SafePathBoundary.create(root);

      await expect(boundary.assertMutation(link)).rejects.toBeInstanceOf(PathContainmentError);
      await expect(boundary.assertMutation(link, { allowFinalSymlink: true })).resolves.toBeUndefined();
    },
  );
});
