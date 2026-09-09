from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, got {count}")
    p.write_text(text.replace(old, new, 1))


index = "src/renderer/src/extensions/hardlink_activator/index.ts"
replace_once(
    index,
    'import LinkingDeployment from "../mod_management/LinkingDeployment";\n',
    'import LinkingDeployment from "../mod_management/LinkingDeployment";\nimport { probeHardlinkSupport } from "./hardlinkSupport";\n',
    "hardlink probe import",
)

old = '''    const canary = path.join(installationPath, "__vortex_canary.tmp");

    let res: IUnavailableReason;

    try {
      try {
        fs.removeSync(canary + ".link");
      } catch {
        // nop
      }
      fs.writeFileSync(canary, "Should only exist temporarily, feel free to delete");
      fs.linkSync(canary, canary + ".link");
    } catch (err) {
      // EMFILE shouldn't keep us from using hard linking
      const code = getErrorCode(err);
      if (code !== "EMFILE") {
        // the error code we're actually getting is EISDIR, which makes no sense at all
        res = {
          description: (t) => t("Filesystem doesn't support hard links."),
        };
      }
    }

    try {
      fs.removeSync(canary + ".link");
      fs.removeSync(canary);
    } catch {
      // cleanup failed, this is almost certainly due to an AV jumping in to check these new files,
      // I mean, why would I be able to create the files but not delete it?
      // just try again later - can't do that synchronously though
      PromiseBB.delay(100)
        .then(() => fs.removeAsync(canary + ".link"))
        .then(() => fs.removeAsync(canary))
        .catch((err) => {
          log(
            "error",
            "failed to clean up canary file. This indicates we were able to create " +
              "a file in the target directory but not delete it",
            { installationPath, message: getErrorMessageOrDefault(err) },
          );
        });
    }

    return res;
'''
# Upstream wording currently says "delete it"? Match actual source independently below if needed.
if old not in Path(index).read_text():
    old = old.replace("not delete it?", "not delete it?")

# Use exact block from the current branch.
old = '''    const canary = path.join(installationPath, "__vortex_canary.tmp");

    let res: IUnavailableReason;

    try {
      try {
        fs.removeSync(canary + ".link");
      } catch {
        // nop
      }
      fs.writeFileSync(canary, "Should only exist temporarily, feel free to delete");
      fs.linkSync(canary, canary + ".link");
    } catch (err) {
      // EMFILE shouldn't keep us from using hard linking
      const code = getErrorCode(err);
      if (code !== "EMFILE") {
        // the error code we're actually getting is EISDIR, which makes no sense at all
        res = {
          description: (t) => t("Filesystem doesn't support hard links."),
        };
      }
    }

    try {
      fs.removeSync(canary + ".link");
      fs.removeSync(canary);
    } catch {
      // cleanup failed, this is almost certainly due to an AV jumping in to check these new files,
      // I mean, why would I be able to create the files but not delete it?
      // just try again later - can't do that synchronously though
      PromiseBB.delay(100)
        .then(() => fs.removeAsync(canary + ".link"))
        .then(() => fs.removeAsync(canary))
        .catch((err) => {
          log(
            "error",
            "failed to clean up canary file. This indicates we were able to create " +
              "a file in the target directory but not delete it",
            { installationPath, message: getErrorMessageOrDefault(err) },
          );
        });
    }

    return res;
'''
actual = Path(index).read_text()
if old not in actual:
    # Current source has "not delete it" in the comment? Extract by anchors to avoid a brittle prose match.
    start = actual.index('    const canary = path.join(installationPath, "__vortex_canary.tmp");')
    end = actual.index('    return res;\n', start) + len('    return res;\n')
    old = actual[start:end]

new = '''    const probe = probeHardlinkSupport(installationPath, modPaths[typeId]);
    for (const cleanupPath of probe.cleanupFailures) {
      PromiseBB.delay(100)
        .then(() => fs.removeAsync(cleanupPath))
        .catch((err) => {
          log("warn", "failed to clean up hardlink capability probe", {
            path: cleanupPath,
            message: getErrorMessageOrDefault(err),
          });
        });
    }

    if (!probe.supported) {
      log("info", "hardlink deployment not supported for staging/game path pair", {
        installationPath,
        dataPath: modPaths[typeId],
        errorCode: probe.errorCode,
      });
      return {
        description: (t) =>
          t("Hard links cannot be created between the mod staging folder and game directory."),
        order: 5,
      };
    }

    return undefined;
'''
replace_once(index, old, new, "cross-directory hardlink probe")

Path("src/renderer/src/extensions/hardlink_activator/hardlinkSupport.ts").write_text('''import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as path from "node:path";

interface IProbeFs {
  writeFileSync: typeof nodeFs.writeFileSync;
  linkSync: typeof nodeFs.linkSync;
  unlinkSync: typeof nodeFs.unlinkSync;
}

export interface IHardlinkProbeResult {
  supported: boolean;
  errorCode?: string;
  cleanupFailures: string[];
}

/**
 * Test the operation Vortex actually needs: a hard link whose source is in the
 * staging directory and whose destination is in the game's deployment directory.
 * A same-directory probe is insufficient on filesystems such as Btrfs where two
 * subvolumes can report the same device id while rejecting cross-subvolume links.
 */
export function probeHardlinkSupport(
  sourceDir: string,
  destinationDir: string,
  fsImpl: IProbeFs = nodeFs,
): IHardlinkProbeResult {
  const name = `.__vortex_hardlink_probe-${process.pid}-${randomUUID()}`;
  const source = path.join(sourceDir, name);
  const destination = path.join(destinationDir, name);
  let supported = false;
  let errorCode: string;

  try {
    fsImpl.writeFileSync(source, "Vortex hardlink capability probe", { flag: "wx" });
    fsImpl.linkSync(source, destination);
    supported = true;
  } catch (err) {
    errorCode = (err as NodeJS.ErrnoException)?.code;
    // Preserve the existing activator policy: a transient file-descriptor
    // exhaustion must not permanently hide hardlink deployment.
    supported = errorCode === "EMFILE";
  }

  const cleanupFailures: string[] = [];
  for (const probePath of [destination, source]) {
    try {
      fsImpl.unlinkSync(probePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        cleanupFailures.push(probePath);
      }
    }
  }

  return { supported, errorCode, cleanupFailures };
}
''')

Path("src/renderer/src/extensions/hardlink_activator/hardlinkSupport.test.ts").write_text('''import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { probeHardlinkSupport } from "./hardlinkSupport";

function fakeFs(linkError?: NodeJS.ErrnoException) {
  return {
    writeFileSync: vi.fn(),
    linkSync: vi.fn(() => {
      if (linkError !== undefined) throw linkError;
    }),
    unlinkSync: vi.fn(),
  } as any;
}

describe("hardlink capability probe", () => {
  it("tests a link from staging into the actual deployment directory", () => {
    const ops = fakeFs();
    const result = probeHardlinkSupport("staging-root", "game-data", ops);
    expect(result.supported).toBe(true);
    expect(ops.linkSync).toHaveBeenCalledOnce();
    const [source, destination] = ops.linkSync.mock.calls[0];
    expect(path.dirname(source)).toBe("staging-root");
    expect(path.dirname(destination)).toBe("game-data");
    expect(path.basename(source)).toBe(path.basename(destination));
  });

  it("rejects EXDEV even when a prior device-id heuristic would have passed", () => {
    const err = Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    const result = probeHardlinkSupport("staging-root", "game-data", fakeFs(err));
    expect(result).toMatchObject({ supported: false, errorCode: "EXDEV" });
  });

  it("preserves the existing EMFILE policy", () => {
    const err = Object.assign(new Error("too many open files"), { code: "EMFILE" });
    const result = probeHardlinkSupport("staging-root", "game-data", fakeFs(err));
    expect(result).toMatchObject({ supported: true, errorCode: "EMFILE" });
  });
});
''')
