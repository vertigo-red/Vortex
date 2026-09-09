import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { expect, it } from "vitest";

import { purgeDeployedFiles } from "./activationStore";

it.runIf(process.platform === "linux")(
  "fallback purge refuses manifest paths through a nested symlink",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-fallback-boundary-"));
    try {
      const game = path.join(root, "game");
      const outside = path.join(root, "outside");
      await fs.mkdir(game);
      await fs.mkdir(outside);
      const sentinel = path.join(outside, "sentinel.txt");
      await fs.writeFile(sentinel, "outside");
      const stats = await fs.stat(sentinel);
      await fs.symlink(outside, path.join(game, "Escape"));

      await expect(
        purgeDeployedFiles(game, [
          { source: "mod", relPath: "Escape/sentinel.txt", time: stats.mtime.getTime() } as any,
        ]),
      ).rejects.toMatchObject({ code: "ESECURITY" });
      expect(await fs.readFile(sentinel, "utf8")).toBe("outside");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "fallback purge rejects lexical traversal from a manifest",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vortex-fallback-traversal-"));
    try {
      const game = path.join(root, "game");
      await fs.mkdir(game);
      await expect(
        purgeDeployedFiles(game, [
          { source: "mod", relPath: "../outside.txt", time: Date.now() } as any,
        ]),
      ).rejects.toMatchObject({ code: "ESECURITY" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
