import * as fs from "node:fs/promises";
import * as path from "node:path";

export class PathContainmentError extends Error {
  public readonly code = "ESECURITY";

  constructor(message: string) {
    super(message);
    this.name = "PathContainmentError";
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function validateRelativePath(relativePath: string): void {
  if (
    relativePath.includes("\0") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[a-z]:/i.test(relativePath) ||
    relativePath.split(/[/\\]/).includes("..")
  ) {
    throw new PathContainmentError(`Path escapes the allowed root: "${relativePath}"`);
  }
}

/**
 * Filesystem mutation boundary for a single explicitly allowed root.
 *
 * The configured root itself may be a symlink (for example a Steam library). Nested
 * symlinks are accepted only while their resolved target remains below the canonical root.
 * Call assertMutation immediately before a write/link/rename/unlink operation.
 */
export class SafePathBoundary {
  private constructor(
    public readonly root: string,
    private readonly canonicalRoot: string,
  ) {}

  public static async create(root: string): Promise<SafePathBoundary> {
    const absoluteRoot = path.resolve(root);
    const canonicalRoot = await fs.realpath(absoluteRoot);
    return new SafePathBoundary(absoluteRoot, canonicalRoot);
  }

  /** Resolve an untrusted relative path without allowing lexical traversal. */
  public resolve(relativePath: string): string {
    validateRelativePath(relativePath);
    const candidate = path.resolve(this.root, relativePath);
    if (!isWithin(this.root, candidate)) {
      throw new PathContainmentError(`Path escapes the allowed root: "${relativePath}"`);
    }
    return candidate;
  }

  /** Ensure an existing path resolves below the canonical root, following the final entry. */
  public async assertRead(target: string): Promise<void> {
    const absoluteTarget = this.assertLexical(target);
    const canonicalTarget = await fs.realpath(absoluteTarget);
    this.assertCanonical(canonicalTarget, absoluteTarget);
  }

  /**
   * Recheck the parent immediately before a mutation. Existing final symlinks are rejected
   * for operations that would follow them (writes/copies). Set allowFinalSymlink only for
   * operations such as unlink/rename that act on the directory entry itself.
   */
  public async assertMutation(
    target: string,
    options: { allowFinalSymlink?: boolean } = {},
  ): Promise<void> {
    const absoluteTarget = this.assertLexical(target);
    const parent = path.dirname(absoluteTarget);
    const canonicalParent = await fs.realpath(parent);
    this.assertCanonical(canonicalParent, parent);

    try {
      const stats = await fs.lstat(absoluteTarget);
      if (stats.isSymbolicLink()) {
        if (!options.allowFinalSymlink) {
          throw new PathContainmentError(`Refusing to follow final symlink: "${absoluteTarget}"`);
        }
        return;
      }
      const canonicalTarget = await fs.realpath(absoluteTarget);
      this.assertCanonical(canonicalTarget, absoluteTarget);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  /** Create a directory tree one component at a time while checking every raced entry. */
  public async ensureDirectory(directory: string): Promise<void> {
    const absoluteDirectory = this.assertLexical(directory);
    const relative = path.relative(this.root, absoluteDirectory);
    if (relative === "") {
      this.assertCanonical(await fs.realpath(this.root), this.root);
      return;
    }

    let current = this.root;
    for (const component of relative.split(path.sep).filter((entry) => entry !== "")) {
      current = path.join(current, component);
      try {
        await fs.lstat(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
        try {
          await fs.mkdir(current);
        } catch (mkdirErr) {
          if ((mkdirErr as NodeJS.ErrnoException).code !== "EEXIST") {
            throw mkdirErr;
          }
        }
      }

      const canonicalCurrent = await fs.realpath(current);
      this.assertCanonical(canonicalCurrent, current);
      const stats = await fs.stat(current);
      if (!stats.isDirectory()) {
        const err = new Error(`Path component is not a directory: "${current}"`) as NodeJS.ErrnoException;
        err.code = "ENOTDIR";
        throw err;
      }
    }
  }

  private assertLexical(target: string): string {
    if (target.includes("\0")) {
      throw new PathContainmentError("NUL is not allowed in filesystem paths");
    }
    const absoluteTarget = path.resolve(target);
    if (!isWithin(this.root, absoluteTarget)) {
      throw new PathContainmentError(`Path escapes the allowed root: "${target}"`);
    }
    return absoluteTarget;
  }

  private assertCanonical(candidate: string, original: string): void {
    if (!isWithin(this.canonicalRoot, candidate)) {
      throw new PathContainmentError(
        `Path resolves outside the allowed root: "${original}" -> "${candidate}"`,
      );
    }
  }
}
