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


# Shared boundary reports created components so deployment can preserve directory tags.
p = Path("src/shared/src/safePath.ts")
text = p.read_text()
replace_pairs = [
    (
        '  public async ensureDirectory(directory: string): Promise<void> {\n    const absoluteDirectory = this.assertLexical(directory);',
        '  public async ensureDirectory(directory: string): Promise<string[]> {\n    const created: string[] = [];\n    const absoluteDirectory = this.assertLexical(directory);',
        "safePath signature",
    ),
    (
        '      this.assertCanonical(await fs.realpath(this.root), this.root);\n      return;\n',
        '      this.assertCanonical(await fs.realpath(this.root), this.root);\n      return created;\n',
        "safePath root return",
    ),
    (
        '          await fs.mkdir(current);\n',
        '          await fs.mkdir(current);\n          created.push(current);\n',
        "safePath created tracking",
    ),
]
for old, new, label in replace_pairs:
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{label}: expected 1 match, got {n}")
    text = text.replace(old, new, 1)
marker = '''      if (!stats.isDirectory()) {
        const err = new Error(`Path component is not a directory: "${current}"`) as NodeJS.ErrnoException;
        err.code = "ENOTDIR";
        throw err;
      }
    }
  }

  private assertLexical'''
replacement = '''      if (!stats.isDirectory()) {
        const err = new Error(`Path component is not a directory: "${current}"`) as NodeJS.ErrnoException;
        err.code = "ENOTDIR";
        throw err;
      }
    }
    return created;
  }

  private assertLexical'''
if text.count(marker) != 1:
    raise SystemExit("safePath final return marker mismatch")
p.write_text(text.replace(marker, replacement, 1))

linking = "src/renderer/src/extensions/mod_management/LinkingDeployment.ts"
replace_once(
    linking,
    'import { getErrorCode, getErrorMessageOrDefault } from "@vortex/shared";',
    'import { getErrorCode, getErrorMessageOrDefault, SafePathBoundary } from "@vortex/shared";',
    "LinkingDeployment shared import",
)
replace_once(
    linking,
    '  private mPathResolver?: CaseInsensitivePathResolver;\n',
    '  private mPathResolver?: CaseInsensitivePathResolver;\n  private mDataPath?: string;\n  private mInstallationPath?: string;\n  private mSafeBoundaries = new Map<string, Promise<SafePathBoundary>>();\n',
    "LinkingDeployment boundary fields",
)
replace_once(
    linking,
    '    const context = this.mContext;\n\n    let added: string[];',
    '    const context = this.mContext;\n    this.mDataPath = dataPath;\n    this.mInstallationPath = installationPath;\n\n    let added: string[];',
    "finalize roots",
)
replace_once(
    linking,
    '        .finally(() => {\n          this.mDirCache = undefined;\n        })',
    '        .finally(() => {\n          this.mDirCache = undefined;\n          this.mDataPath = undefined;\n          this.mInstallationPath = undefined;\n        })',
    "finalize root cleanup",
)
replace_once(
    linking,
    '    const game = getGame(gameId);\n    const directoryCleaning = game.directoryCleaning || "tag";\n\n    // stat to ensure the target directory exists\n    return Promise.resolve(',
    '    const game = getGame(gameId);\n    const directoryCleaning = game.directoryCleaning || "tag";\n    this.mDataPath = dataPath;\n    this.mInstallationPath = installPath;\n\n    // stat to ensure the target directory exists\n    return Promise.resolve(',
    "purge roots",
)
replace_once(
    linking,
    '          return Promise.reject(err);\n        }),\n    );\n  }\n\n  public postPurge()',
    '          return Promise.reject(err);\n        }),\n    ).finally(() => {\n      this.mDataPath = undefined;\n      this.mInstallationPath = undefined;\n    });\n  }\n\n  public postPurge()',
    "purge root cleanup",
)
helper_block = '''  protected statLink(filePath: string): PromiseLike<fs.Stats> {
    return fs.lstatAsync(filePath);
  }

  private safeBoundary(root: string): Promise<SafePathBoundary> {
    const key = path.resolve(root);
    let pending = this.mSafeBoundaries.get(key);
    if (pending === undefined) {
      pending = SafePathBoundary.create(key);
      this.mSafeBoundaries.set(key, pending);
    }
    return pending;
  }

  protected async assertPathMutation(
    root: string,
    target: string,
    allowFinalSymlink: boolean = true,
  ): Promise<void> {
    if (process.platform !== "linux") return;
    const boundary = await this.safeBoundary(root);
    await boundary.assertMutation(target, { allowFinalSymlink });
  }

  protected async assertDataMutation(
    target: string,
    allowFinalSymlink: boolean = true,
  ): Promise<void> {
    if (process.platform !== "linux") return;
    if (this.mDataPath === undefined) throw new Error("Deployment data root is not initialized");
    await this.assertPathMutation(this.mDataPath, target, allowFinalSymlink);
  }

  protected async assertInstallMutation(
    target: string,
    allowFinalSymlink: boolean = true,
  ): Promise<void> {
    if (process.platform !== "linux") return;
    if (this.mInstallationPath === undefined) {
      throw new Error("Deployment staging root is not initialized");
    }
    await this.assertPathMutation(this.mInstallationPath, target, allowFinalSymlink);
  }

  protected async assertInstallRead(target: string): Promise<void> {
    if (process.platform !== "linux") return;
    if (this.mInstallationPath === undefined) {
      throw new Error("Deployment staging root is not initialized");
    }
    const boundary = await this.safeBoundary(this.mInstallationPath);
    await boundary.assertRead(target);
  }
'''
replace_once(
    linking,
    '  protected statLink(filePath: string): PromiseLike<fs.Stats> {\n    return fs.lstatAsync(filePath);\n  }\n',
    helper_block,
    "boundary helper methods",
)
sub_once(
    linking,
    r'  protected ensureDir\(dirPath: string, dirTags\?: boolean\): Promise<boolean> \{.*?\n  \}\n\n  private deduplicate',
    '''  protected ensureDir(
    dirPath: string,
    dirTags?: boolean,
    rootPath?: string,
  ): Promise<boolean> {
    if (process.platform === "linux" && rootPath !== undefined) {
      return this.safeBoundary(rootPath).then(async (boundary) => {
        if (this.mDirCache !== undefined && this.mDirCache.has(dirPath)) return false;
        const created = await boundary.ensureDirectory(dirPath);
        if (this.mDirCache === undefined) this.mDirCache = new Set<string>();
        this.mDirCache.add(dirPath);
        if (dirTags !== false) {
          for (const createdPath of created) {
            const tagPath = path.join(createdPath, LinkingActivator.NEW_TAG_NAME);
            await boundary.assertMutation(tagPath);
            await fs.writeFileAsync(
              tagPath,
              "This directory was created by Vortex deployment and will be removed " +
                "during purging if it's empty",
            );
          }
        }
        return created.length > 0;
      });
    }

    let didCreate = false;
    const onDirCreated = (createdPath: string) => {
      didCreate = true;
      if (dirTags !== false) {
        log("debug", "created directory", createdPath);
        return fs.writeFileAsync(
          path.join(createdPath, LinkingActivator.NEW_TAG_NAME),
          "This directory was created by Vortex deployment and will be removed " +
            "during purging if it's empty",
        );
      }
      return Promise.resolve();
    };
    return Promise.resolve(
      this.mDirCache === undefined || !this.mDirCache.has(dirPath)
        ? fs.ensureDirAsync(dirPath, onDirCreated).then(() => {
            if (this.mDirCache === undefined) this.mDirCache = new Set<string>();
            this.mDirCache.add(dirPath);
          })
        : Promise.resolve(),
    ).then(() => didCreate);
  }

  private deduplicate''',
    "safe ensureDir",
    re.S,
)
replace_once(
    linking,
    '    return Promise.resolve(this.unlinkFile(outputPath, sourcePath))',
    '    return this.assertPathMutation(dataPath, outputPath, true)\n      .then(() => this.unlinkFile(outputPath, sourcePath))',
    "remove boundary",
)
replace_once(
    linking,
    '        restoreBackup\n          ? fs.renameAsync(outputPath + BACKUP_TAG, outputPath).catch(() => undefined)\n          : Promise.resolve(),',
    '        restoreBackup\n          ? this.assertPathMutation(dataPath, outputPath + BACKUP_TAG, true)\n              .then(() => this.assertPathMutation(dataPath, outputPath, true))\n              .then(() => fs.renameAsync(outputPath + BACKUP_TAG, outputPath))\n              .catch(() => undefined)\n          : Promise.resolve(),',
    "backup restore boundary",
)
replace_once(
    linking,
    '              : fs.renameAsync(fullOutputPath, fullOutputPath + BACKUP_TAG),',
    '              : this.assertPathMutation(dataPath, fullOutputPath, true)\n                  .then(() => this.assertPathMutation(dataPath, fullOutputPath + BACKUP_TAG, true))\n                  .then(() => fs.renameAsync(fullOutputPath, fullOutputPath + BACKUP_TAG)),',
    "backup creation boundary",
)
replace_once(
    linking,
    '    return backupProm\n      .then(() => this.linkFile(fullOutputPath, fullPath, dirTags))',
    '    return backupProm\n      .then(() => this.ensureDir(path.dirname(fullOutputPath), dirTags, dataPath))\n      .then(() => this.assertPathMutation(dataPath, fullOutputPath, true))\n      .then(() => this.linkFile(fullOutputPath, fullPath, dirTags))',
    "link boundary",
)
replace_once(
    linking,
    '        { recurse: false, skipHidden: false, skipLinks: false },',
    '        { recurse: false, skipHidden: false, skipLinks: process.platform === "linux" },',
    "post purge skip links",
)
# Restore backups are entries under the current recursively-scanned baseDir.
replace_once(
    linking,
    '.map((entry) => this.restoreBackup(entry.filePath)),',
    '.map((entry) => this.restoreBackup(entry.filePath, baseDir)),',
    "restore backup call",
)
replace_once(
    linking,
    '              .then(() => fs.unlinkAsync(path.join(baseDir, LinkingActivator.NEW_TAG_NAME)))\n              .catch(() => fs.unlinkAsync(path.join(baseDir, LinkingActivator.OLD_TAG_NAME)))',
    '              .then(() => {\n                const tag = path.join(baseDir, LinkingActivator.NEW_TAG_NAME);\n                return this.assertPathMutation(baseDir, tag, true).then(() => fs.unlinkAsync(tag));\n              })\n              .catch(() => {\n                const tag = path.join(baseDir, LinkingActivator.OLD_TAG_NAME);\n                return this.assertPathMutation(baseDir, tag, true).then(() => fs.unlinkAsync(tag));\n              })',
    "tag unlink boundary",
)
replace_once(
    linking,
    '              .then(() =>\n                fs.rmdirAsync(baseDir).catch((err) => {',
    '              .then(() =>\n                this.assertPathMutation(path.dirname(baseDir), baseDir, true)\n                  .then(() => fs.rmdirAsync(baseDir))\n                  .catch((err) => {',
    "rmdir boundary",
)
replace_once(
    linking,
    '  private restoreBackup(backupPath: string): Promise<void> {\n    const targetPath = backupPath.substr(0, backupPath.length - BACKUP_TAG.length);\n    return Promise.resolve(\n      fs\n        .renameAsync(backupPath, targetPath)',
    '  private restoreBackup(backupPath: string, rootPath: string): Promise<void> {\n    const targetPath = backupPath.substr(0, backupPath.length - BACKUP_TAG.length);\n    return Promise.resolve(\n      this.assertPathMutation(rootPath, backupPath, true)\n        .then(() => this.assertPathMutation(rootPath, targetPath, true))\n        .then(() => fs.renameAsync(backupPath, targetPath))',
    "restoreBackup boundary",
)
replace_once(
    linking,
    '? fs.removeAsync(targetPath).then(() => this.restoreBackup(backupPath))\n                  : fs.removeAsync(backupPath),',
    '? this.assertPathMutation(rootPath, targetPath, true)\n                      .then(() => fs.removeAsync(targetPath))\n                      .then(() => this.restoreBackup(backupPath, rootPath))\n                  : this.assertPathMutation(rootPath, backupPath, true)\n                      .then(() => fs.removeAsync(backupPath)),',
    "restoreBackup overwrite boundary",
)
replace_once(
    linking,
    ': this.restoreBackup(backupPath),',
    ': this.restoreBackup(backupPath, rootPath),',
    "restoreBackup retry",
)

# Hardlink activator.
hardlink = "src/renderer/src/extensions/hardlink_activator/index.ts"
replace_once(
    hardlink,
    '    return this.ensureDir(path.dirname(linkPath), dirTags)\n      .then(() => fs.linkAsync(sourcePath, linkPath))',
    '    return this.assertDataMutation(linkPath, true)\n      .then(() => fs.linkAsync(sourcePath, linkPath))',
    "hardlink central dir",
)
replace_once(
    hardlink,
    ': fs.removeAsync(linkPath).then(() => fs.linkAsync(sourcePath, linkPath)),',
    ': this.assertDataMutation(linkPath, true)\n              .then(() => fs.removeAsync(linkPath))\n              .then(() => this.assertDataMutation(linkPath, true))\n              .then(() => fs.linkAsync(sourcePath, linkPath)),',
    "hardlink retry boundary",
)
replace_once(
    hardlink,
    '                return fs\n                  .unlinkAsync(entry.filePath)',
    '                return PromiseBB.resolve(this.assertPathMutation(dataPath, entry.filePath, true))\n                  .then(() => fs.unlinkAsync(entry.filePath))',
    "hardlink purge boundary",
)
replace_once(
    hardlink,
    '        { details: true, skipHidden: false },\n      ).then(() => queue);',
    '        { details: true, skipHidden: false, skipLinks: process.platform === "linux" },\n      ).then(() => queue);',
    "hardlink purge skip links",
)

# Regular symlink activator.
symlink = "src/renderer/src/extensions/symlink_activator/index.ts"
sub_once(
    symlink,
    r'  protected linkFile\(linkPath: string, sourcePath: string, dirTags\?: boolean\): Promise<void> \{.*?\n  \}\n\n  protected unlinkFile',
    '''  protected linkFile(linkPath: string, sourcePath: string, dirTags?: boolean): Promise<void> {
    return this.assertDataMutation(linkPath, true)
      .then(() => fs.symlinkAsync(sourcePath, linkPath))
      .catch((err) =>
        err.code !== "EEXIST"
          ? Promise.reject(err)
          : this.assertDataMutation(linkPath, true)
              .then(() => fs.removeAsync(linkPath))
              .then(() => this.assertDataMutation(linkPath, true))
              .then(() => fs.symlinkAsync(sourcePath, linkPath)),
      );
  }

  protected unlinkFile''',
    "symlink link boundary",
    re.S,
)
replace_once(
    symlink,
    '            return fs.unlinkAsync(iterPath, { showDialogCallback });',
    '            return this.assertPathMutation(dataPath, iterPath, true)\n              .then(() => fs.unlinkAsync(iterPath, { showDialogCallback }));',
    "symlink purge boundary",
)

# Elevated symlink activator.
elev = "src/renderer/src/extensions/symlink_activator_elevate/index.ts"
sub_once(
    elev,
    r'  protected linkFile\(linkPath: string, sourcePath: string, dirTags\?: boolean\): Promise<void> \{.*?\n  \}\n\n  protected unlinkFile',
    '''  protected linkFile(linkPath: string, sourcePath: string, dirTags?: boolean): Promise<void> {
    return this.assertDataMutation(linkPath, true)
      .then(() => fs.removeAsync(linkPath))
      .catch((err) =>
        getErrorCode(err) === "ENOENT" ? Promise.resolve() : Promise.reject(unknownToError(err)),
      )
      .then(() => this.assertDataMutation(linkPath, true))
      .then(() =>
        Promise.resolve(
          this.emitOperation("link-file", { source: sourcePath, destination: linkPath }),
        ),
      );
  }

  protected unlinkFile''',
    "elevated link boundary",
    re.S,
)
replace_once(
    elev,
    ': this.emitOperation("remove-link", { destination: iterPath }),',
    ': this.assertPathMutation(dataPath, iterPath, true)\n                    .then(() => this.emitOperation("remove-link", { destination: iterPath })),',
    "elevated purge boundary",
)

# Move activator protects both staging and game roots.
move = "src/renderer/src/extensions/move_activator/index.ts"
replace_once(
    move,
    '    const basePath = path.dirname(linkPath);\n    return this.ensureDir(basePath).then(() => this.createLink(sourcePath, linkPath));',
    '    return this.assertDataMutation(linkPath, true).then(() => this.createLink(sourcePath, linkPath));',
    "move link boundary",
)
replace_once(
    move,
    '      .then(() =>\n        fs.writeFileAsync(sourcePath + LNK_EXT, linkInfo, {\n          encoding: "utf-8",\n        }),\n      )',
    '      .then(() => this.assertInstallMutation(sourcePath + LNK_EXT, false))\n      .then(() =>\n        fs.writeFileAsync(sourcePath + LNK_EXT, linkInfo, {\n          encoding: "utf-8",\n        }),\n      )',
    "move placeholder write boundary",
)
replace_once(
    move,
    '      .then(() => fs.renameAsync(sourcePath, linkPath));',
    '      .then(() => this.assertInstallMutation(sourcePath, true))\n      .then(() => this.assertDataMutation(linkPath, true))\n      .then(() => fs.renameAsync(sourcePath, linkPath));',
    "move rename boundary",
)
replace_once(
    move,
    '  private restoreLink(linkPath: string): PromiseBB<void> {\n    return fs.readFileAsync(linkPath, { encoding: "utf-8" }).then((data) => {',
    '  private restoreLink(linkPath: string): PromiseBB<void> {\n    return PromiseBB.resolve(this.assertInstallRead(linkPath))\n      .then(() => fs.readFileAsync(linkPath, { encoding: "utf-8" }))\n      .then((data) => {',
    "move restore read boundary",
)
replace_once(
    move,
    '        return fs\n          .renameAsync(dat.target, outPath)',
    '        return PromiseBB.resolve(this.assertDataMutation(dat.target, true))\n          .then(() => this.assertInstallMutation(outPath, true))\n          .then(() => fs.renameAsync(dat.target, outPath))',
    "move restore rename boundary",
)
replace_once(
    move,
    '          .then(() => fs.removeAsync(linkPath));',
    '          .then(() => this.assertInstallMutation(linkPath, true))\n          .then(() => fs.removeAsync(linkPath));',
    "move restore cleanup boundary",
)

# Integration regression: nested data symlink must not reach the activator mutation.
test = Path("src/renderer/src/extensions/mod_management/LinkingDeployment.test.ts")
t = test.read_text()
if "blocks deployment removal through a nested symlink escape" in t:
    raise SystemExit("integration test already present")
t += r'''

it.runIf(process.platform === "linux")(
  "blocks deployment removal through a nested symlink escape",
  async () => {
    const root = await nativeFs.mkdtemp(path.join(os.tmpdir(), "vortex-deploy-boundary-"));
    try {
      const data = path.join(root, "game");
      const staging = path.join(root, "staging");
      const outside = path.join(root, "outside");
      await nativeFs.mkdir(data);
      await nativeFs.mkdir(staging);
      await nativeFs.mkdir(outside);
      const sentinel = path.join(outside, "sentinel.txt");
      await nativeFs.writeFile(sentinel, "outside");
      await nativeFs.symlink(outside, path.join(data, "Escape"));

      const { activator } = setup();
      const before = [{ relPath: "Escape/sentinel.txt", source: "mod", time: 1 }];
      await activator.prepare(data, true, before, (value) => value);
      const manifest = await activator.finalize("game", data, staging);

      expect(activator.unlinked).toEqual([]);
      expect(manifest).toEqual(before);
      expect(await nativeFs.readFile(sentinel, "utf8")).toBe("outside");
    } finally {
      await nativeFs.rm(root, { recursive: true, force: true });
    }
  },
);
'''
test.write_text(t)
