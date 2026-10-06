import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import exeVersion, {
  getFileVersionLocalized,
  getProductVersion,
  getProductVersionLocalized,
} from "./index";

/** Minimal PE32 with an RT_VERSION resource; no executable code is needed. */
function versionedPE(): Buffer {
  const fixture = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "../test-fixtures/skse-loader.json"), "utf8"),
  );
  return Buffer.from(fixture.data, "base64");
}

describe("PE versions on all host platforms", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "vortex-pe-version-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads file and product versions without executing the Windows file", () => {
    const executable = path.join(root, "SKSE loader Кириллица.exe");
    writeFileSync(executable, versionedPE());
    expect(exeVersion(executable)).toBe("0.1.7.3");
    expect(getProductVersion(executable)).toBe("1.9.32.0");
    expect(getFileVersionLocalized(executable)).toBe("0.1.7.3");
    expect(getProductVersionLocalized(executable)).toBe("1.9.32.0");
  });

  it("returns no version for a missing or non-PE file", () => {
    const executable = path.join(root, "missing.exe");
    expect(exeVersion(executable)).toBe("");
    writeFileSync(executable, "not a Windows executable");
    expect(exeVersion(executable)).toBe("");
  });
});
