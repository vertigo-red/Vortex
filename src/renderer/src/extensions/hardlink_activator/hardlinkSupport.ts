import { randomUUID } from "node:crypto";
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
