import * as path from "node:path";

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
