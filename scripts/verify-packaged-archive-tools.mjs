import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { archiveTools } from "./build-archive-tools.mjs";

const resources = process.argv[2];
if (!resources)
  throw new Error("Usage: node scripts/verify-packaged-archive-tools.mjs <resources>");
for (const [extension, id] of [
  ["mtframework-arc-support", "arc"],
  ["quickbms-support", "quickbms"],
]) {
  const directory = path.join(resources, "app.asar.unpacked", "bundledPlugins", extension);
  const tool = archiveTools[id];
  const data = await readFile(path.join(directory, tool.executable));
  assert.equal(
    createHash("sha256").update(data).digest("hex"),
    tool.executableHash,
    `${extension} packaged executable hash`,
  );
  const launcher = await readFile(path.join(directory, "vortex-archive-launcher.exe"));
  assert.equal(launcher.toString("ascii", 0, 2), "MZ");
  const pe = launcher.readUInt32LE(0x3c);
  assert.equal(launcher.toString("ascii", pe, pe + 4), "PE\0\0");
  assert.equal(launcher.readUInt16LE(pe + 4), 0x8664, "The Windows launcher must be x64");
  assert.ok((await stat(path.join(directory, tool.packagedReadme))).size > 0);
}
console.log(
  "Packaged ARCtool/QuickBMS hashes, x64 Windows job launchers and author documentation verified",
);
