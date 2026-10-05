import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const file = Buffer.alloc(1024);
  file.writeUInt16LE(0x5a4d, 0);
  file.writeUInt32LE(0x80, 0x3c);
  file.writeUInt32LE(0x4550, 0x80);
  file.writeUInt16LE(1, 0x86);
  file.writeUInt16LE(0xe0, 0x94);
  file.writeUInt16LE(0x10b, 0x98);
  file.writeUInt32LE(0x1000, 0x108);
  file.writeUInt32LE(512, 0x10c);
  const section = 0x178;
  file.write(".rsrc", section);
  file.writeUInt32LE(512, section + 8);
  file.writeUInt32LE(0x1000, section + 12);
  file.writeUInt32LE(512, section + 16);
  file.writeUInt32LE(512, section + 20);

  const resource = file.subarray(512);
  resource.writeUInt16LE(1, 14);
  resource.writeUInt32LE(16, 16); // RT_VERSION
  resource.writeUInt32LE(0x80000018, 20);
  resource.writeUInt16LE(1, 24 + 14);
  resource.writeUInt32LE(1, 40);
  resource.writeUInt32LE(0x80000030, 44);
  resource.writeUInt16LE(1, 48 + 14);
  resource.writeUInt32LE(1033, 64);
  resource.writeUInt32LE(72, 68);
  resource.writeUInt32LE(0x1060, 72);
  resource.writeUInt32LE(92, 76);

  const version = resource.subarray(96);
  version.writeUInt16LE(92, 0);
  version.writeUInt16LE(52, 2);
  version.write("VS_VERSION_INFO\0", 6, "utf16le");
  version.writeUInt32LE(0xfeef04bd, 40);
  version.writeUInt32LE(0x10000, 44);
  version.writeUInt32LE(1, 48); // FileVersion 0.1.7.3 (SKSE convention)
  version.writeUInt32LE((7 << 16) | 3, 52);
  version.writeUInt32LE((1 << 16) | 9, 56); // ProductVersion 1.9.32.0
  version.writeUInt32LE(32 << 16, 60);
  return file;
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
