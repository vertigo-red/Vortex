from pathlib import Path
import re


def replace_once(path, old, new, label):
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{label}: expected 1 exact match, got {n}")
    p.write_text(text.replace(old, new, 1))


def sub_once(path, pattern, repl, label, flags=0):
    p = Path(path)
    text = p.read_text()
    text2, n = re.subn(pattern, repl, text, count=1, flags=flags)
    if n != 1:
        raise SystemExit(f"{label}: expected 1 regex match, got {n}")
    p.write_text(text2)


# Keep one immutable security root while postLinkPurge recursively descends.
linking = "src/renderer/src/extensions/mod_management/LinkingDeployment.ts"
replace_once(
    linking,
    '''  private postLinkPurge(
    baseDir: string,
    doRemove: boolean,
    restoreBackups: boolean,
    directoryCleaning: DirectoryCleaningMode,
    reportMissing: boolean = true,
  ): Promise<boolean> {''',
    '''  private postLinkPurge(
    baseDir: string,
    doRemove: boolean,
    restoreBackups: boolean,
    directoryCleaning: DirectoryCleaningMode,
    reportMissing: boolean = true,
    securityRoot: string = baseDir,
  ): Promise<boolean> {''',
    "postLinkPurge signature",
)
replace_once(
    linking,
    '''              directoryCleaning,
              false,
            );''',
    '''              directoryCleaning,
              false,
              securityRoot,
            );''',
    "postLinkPurge recursive root",
)
replace_once(
    linking,
    '.map((entry) => this.restoreBackup(entry.filePath, baseDir)),',
    '.map((entry) => this.restoreBackup(entry.filePath, securityRoot)),',
    "restore backup immutable root",
)
text = Path(linking).read_text()
if text.count('this.assertPathMutation(baseDir, tag, true)') != 2:
    raise SystemExit("tag immutable root: expected two matches")
text = text.replace('this.assertPathMutation(baseDir, tag, true)', 'this.assertPathMutation(securityRoot, tag, true)')
if text.count('this.assertPathMutation(path.dirname(baseDir), baseDir, true)') != 1:
    raise SystemExit("rmdir immutable root mismatch")
text = text.replace(
    'this.assertPathMutation(path.dirname(baseDir), baseDir, true)',
    'this.assertPathMutation(securityRoot, baseDir, true)',
)
Path(linking).write_text(text)

# Locked-file unit tests must use real roots on Linux; do not weaken production realpath checks.
test_path = "src/renderer/src/extensions/mod_management/LinkingDeployment.test.ts"
sub_once(
    test_path,
    r'describe\("deployment with locked files", \(\) => \{.*?\n\}\);\n\nit\.runIf\(process\.platform === "linux"\)',
    '''describe("deployment with locked files", () => {
  it.each(["source", "content"])(
    "does not skip queued %s changes after failed unlinks",
    async (kind) => {
      const root = await nativeFs.mkdtemp(path.join(os.tmpdir(), "vortex-deploy-locked-"));
      const data = path.join(root, "data");
      const staging = path.join(root, "staging");
      await nativeFs.mkdir(data);
      await nativeFs.mkdir(staging);
      try {
        const { activator, dispatch } = setup();
        const before: IDeployedFile[] = Array.from({ length: 125 }, (_, i) => ({
          relPath: `${i}.txt`,
          source: "old",
          time: 1,
        }));
        await activator.prepare(data, true, before, (value) => value);
        const context = (activator as any).mContext;
        for (const file of before)
          context.newDeployment[file.relPath] = {
            ...file,
            source: kind === "source" ? "new" : "old",
            time: 2,
          };
        activator.failures = new Set(["0.txt", "7.txt", "49.txt", "60.txt"]);
        const manifest = await activator.finalize("game", data, staging);
        expect(new Set(activator.unlinked)).toEqual(new Set(before.map((file) => file.relPath)));
        expect(activator.unlinked).toHaveLength(125);
        expect(activator.linked).toHaveLength(121);
        expect(activator.linked.some((file) => activator.failures.has(file))).toBe(false);
        expect(manifest).toHaveLength(125);
        for (const file of manifest) {
          expect(file.time).toBe(activator.failures.has(file.relPath) ? 1 : 2);
        }
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        await nativeFs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("retains a failed removal in the manifest and releases the deployment queue", async () => {
    const root = await nativeFs.mkdtemp(path.join(os.tmpdir(), "vortex-deploy-locked-one-"));
    const data = path.join(root, "data");
    const staging = path.join(root, "staging");
    await nativeFs.mkdir(data);
    await nativeFs.mkdir(staging);
    try {
      const { activator } = setup();
      const before = [{ relPath: "locked.txt", source: "old", time: 1 }];
      activator.failures.add("locked.txt");
      await activator.prepare(data, true, before, (value) => value);
      expect(await activator.finalize("game", data, staging)).toEqual(before);
      await activator.prepare(data, true, before, (value) => value);
      await activator.cancel("game", data, staging);
    } finally {
      await nativeFs.rm(root, { recursive: true, force: true });
    }
  });
});

it.runIf(process.platform === "linux")''',
    "LinkingDeployment real-root tests",
    re.S,
)

# External-change actions mutate both game and staging roots. Resolve manifest/dialog paths
# through SafePathBoundary and recheck immediately before each remove/move.
external = "src/renderer/src/extensions/mod_management/util/externalChanges.ts"
replace_once(
    external,
    'import { getErrorCode, unknownToError } from "@vortex/shared";',
    'import { getErrorCode, SafePathBoundary, unknownToError } from "@vortex/shared";',
    "externalChanges shared import",
)
replace_once(
    external,
    '''  const deployedPaths = new Map(
    lastDeployment.map((file) => [JSON.stringify([file.source, file.relPath]), file.deployedPath]),
  );
  const destination = (entry: IFileEntry) =>
    path.join(
      outputPath,
      deployedPaths.get(JSON.stringify([entry.source, entry.filePath])) ?? entry.filePath,
    );''',
    '''  const sourceBoundary =
    process.platform === "linux" ? await SafePathBoundary.create(sourcePath) : undefined;
  const outputBoundary =
    process.platform === "linux" ? await SafePathBoundary.create(outputPath) : undefined;
  const deployedPaths = new Map(
    lastDeployment.map((file) => [JSON.stringify([file.source, file.relPath]), file.deployedPath]),
  );
  const destination = (entry: IFileEntry) => {
    const relative =
      deployedPaths.get(JSON.stringify([entry.source, entry.filePath])) ?? entry.filePath;
    return outputBoundary !== undefined
      ? outputBoundary.resolve(relative)
      : path.join(outputPath, relative);
  };
  const sourceFile = (entry: IFileEntry) => {
    const relative = path.join(entry.source, entry.filePath);
    return sourceBoundary !== undefined
      ? sourceBoundary.resolve(relative)
      : path.join(sourcePath, relative);
  };''',
    "externalChanges boundaries",
)
replace_once(
    external,
    '''    (actionGroups["drop"] || []).map((entry) =>
      truthy(entry.filePath)
        ? fs.removeAsync(destination(entry))
        : Promise.reject(new Error("invalid file path")),
    ),''',
    '''    (actionGroups["drop"] || []).map(async (entry) => {
      if (!truthy(entry.filePath)) throw new Error("invalid file path");
      const target = destination(entry);
      await outputBoundary?.assertMutation(target, { allowFinalSymlink: true });
      await fs.removeAsync(target);
    }),''',
    "external drop boundary",
)
replace_once(
    external,
    '''    (actionGroups["delete"] || []).map((entry) =>
      truthy(entry.filePath)
        ? fs.removeAsync(path.join(sourcePath, entry.source, entry.filePath))
        : Promise.reject(new Error("invalid file path")),
    ),''',
    '''    (actionGroups["delete"] || []).map(async (entry) => {
      if (!truthy(entry.filePath)) throw new Error("invalid file path");
      const target = sourceFile(entry);
      await sourceBoundary?.assertMutation(target, { allowFinalSymlink: true });
      await fs.removeAsync(target);
    }),''',
    "external delete boundary",
)
replace_once(
    external,
    '''      const source = path.join(sourcePath, entry.source, entry.filePath);
      const deployed = destination(entry);''',
    '''      const source = sourceFile(entry);
      const deployed = destination(entry);''',
    "external import paths",
)
replace_once(
    external,
    '''      return fs
        .removeAsync(source)
        .then(() => fs.moveAsync(deployed, source, { overwrite: true }))''',
    '''      return Promise.resolve()
        .then(() => sourceBoundary?.assertMutation(source, { allowFinalSymlink: true }))
        .then(() => fs.removeAsync(source))
        .then(() => outputBoundary?.assertMutation(deployed, { allowFinalSymlink: true }))
        .then(() => sourceBoundary?.assertMutation(source, { allowFinalSymlink: true }))
        .then(() => fs.moveAsync(deployed, source, { overwrite: true }))''',
    "external import mutation boundary",
)

# Rework path-focused externalChanges tests to use real Linux roots and include a nested
# symlink escape regression while retaining mocked destructive calls.
Path("src/renderer/src/extensions/mod_management/util/externalChangesPaths.test.ts").write_text('''import * as nativeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IExtensionApi } from "../../../types/IExtensionContext";
import type { IFileEntry } from "../types/IFileEntry";

vi.mock("../../../util/fs", () => ({
  removeAsync: vi.fn(async () => {}),
  moveAsync: vi.fn(async () => {}),
}));
vi.mock("../../../logging", () => ({ log: vi.fn() }));
vi.mock("../modMerging", () => ({ MERGED_PATH: "__merged" }));
vi.mock("../../../util/selectors", () => ({ activeGameId: () => "game" }));

import * as fs from "../../../util/fs";
import { applyFileActions } from "./externalChanges";

const manifest = [
  { source: "mod", relPath: "data/FILE.ini", deployedPath: "Data/File.ini", time: 1 },
];
const api = {
  store: { getState: () => ({}) },
  events: { emit: vi.fn() },
} as unknown as IExtensionApi;

let root: string;
let staging: string;
let game: string;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await nativeFs.mkdtemp(path.join(os.tmpdir(), "vortex-external-paths-"));
  staging = path.join(root, "staging");
  game = path.join(root, "game");
  await nativeFs.mkdir(path.join(staging, "mod", "data"), { recursive: true });
  await nativeFs.mkdir(path.join(game, "Data"), { recursive: true });
});

afterEach(async () => {
  await nativeFs.rm(root, { recursive: true, force: true });
});

describe("external changes with case-resolved deployment paths", () => {
  it("drops the actual deployed path instead of a nonexistent source-case path", async () => {
    const actions = [
      { source: "mod", filePath: "data/FILE.ini", action: "drop", type: "refchange" },
    ] as IFileEntry[];
    expect(await applyFileActions(api, undefined, staging, game, manifest, actions)).toEqual([]);
    expect(fs.removeAsync).toHaveBeenCalledWith(path.join(game, "Data/File.ini"));
  });

  it("imports the actual destination into the original staging path", async () => {
    const actions = [
      { source: "mod", filePath: "data/FILE.ini", action: "import", type: "refchange" },
    ] as IFileEntry[];
    await applyFileActions(api, undefined, staging, game, manifest, actions);
    expect(fs.moveAsync).toHaveBeenCalledWith(
      path.join(game, "Data/File.ini"),
      path.join(staging, "mod", "data/FILE.ini"),
      { overwrite: true },
    );
  });

  it.runIf(process.platform === "linux")("blocks a drop through a nested symlink", async () => {
    const outside = path.join(root, "outside");
    await nativeFs.mkdir(outside);
    await nativeFs.symlink(outside, path.join(game, "Escape"));
    const actions = [
      { source: "mod", filePath: "ignored", action: "drop", type: "refchange" },
    ] as IFileEntry[];
    const escapedManifest = [
      { source: "mod", relPath: "ignored", deployedPath: "Escape/sentinel.txt", time: 1 },
    ];
    await expect(
      applyFileActions(api, undefined, staging, game, escapedManifest, actions),
    ).rejects.toMatchObject({ code: "ESECURITY" });
    expect(fs.removeAsync).not.toHaveBeenCalled();
  });
});
''')

# Manifest fallback purge must not trust deployedPath/relPath read from disk.
activation = "src/renderer/src/extensions/mod_management/util/activationStore.ts"
replace_once(
    activation,
    'import { getErrorCode, getErrorMessageOrDefault, unknownToError } from "@vortex/shared";',
    'import { getErrorCode, getErrorMessageOrDefault, SafePathBoundary, unknownToError } from "@vortex/shared";',
    "activationStore shared import",
)
sub_once(
    activation,
    r'export function purgeDeployedFiles\(basePath: string, files: IDeployedFile\[\]\): Promise<void> \{.*?\n\}\n\nfunction queryPurgeTextSafe',
    '''export async function purgeDeployedFiles(basePath: string, files: IDeployedFile[]): Promise<void> {
  const boundary =
    process.platform === "linux" ? await SafePathBoundary.create(basePath) : undefined;
  await Promise.all(
    files.map(async (file) => {
      const relative = file.deployedPath ?? file.relPath;
      const fullPath = boundary !== undefined ? boundary.resolve(relative) : path.join(basePath, relative);
      try {
        const stats = await fs.statAsync(fullPath);
        // the timestamp from stat has ms precision but the one from the manifest doesn't
        if (stats.mtime.getTime() - file.time < 1000) {
          await boundary?.assertMutation(fullPath, { allowFinalSymlink: true });
          await fs.unlinkAsync(fullPath);
        }
      } catch (err) {
        if (getErrorCode(err) !== "ENOENT") throw err;
      }
    }),
  );
}

function queryPurgeTextSafe''',
    "fallback purge boundary",
    re.S,
)

Path("src/renderer/src/extensions/mod_management/util/activationStorePaths.test.ts").write_text('''import * as fs from "node:fs/promises";
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
''')
