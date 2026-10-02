import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
if (process.platform !== "linux" || process.argv.length !== 3) {
  throw new Error("Usage on Linux: node scripts/verify-linux-fomod.mjs <packaged-resources>");
}
const packageRoot = path.resolve(
  process.argv[2],
  "app.asar.unpacked/node_modules/@nexusmods/fomod-installer-native",
);
const binding = path.join(packageRoot, "build/Release/modinstaller.node");
const library = path.join(packageRoot, "ModInstaller.Native.so");
await Promise.all([access(binding), access(library)]);
const { stdout: runpath } = await exec("patchelf", ["--print-rpath", binding]);
if (runpath.trim() !== "$ORIGIN:$ORIGIN/../..") {
  throw new Error(`FOMOD has a non-portable library search path: ${runpath.trim()}`);
}

const temporary = await mkdtemp(path.join(tmpdir(), "vortex-relocated-fomod-"));
try {
  const relocated = path.join(temporary, "package");
  const relocatedBinding = path.join(relocated, "build/Release/modinstaller.node");
  await mkdir(path.dirname(relocatedBinding), { recursive: true });
  await copyFile(binding, relocatedBinding);
  // Only the package-root library is copied, proving the ../.. lookup also works.
  await copyFile(library, path.join(relocated, "ModInstaller.Native.so"));
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  delete env.ELECTRON_RUN_AS_NODE;
  const probe = `
    const assert = require('node:assert/strict');
    const addon = require(process.argv[1]);
    const raw = addon.ModInstaller.testSupported(
      ['fomod/ModuleConfig.xml', 'Textures/Example.dds'], ['XmlScript']);
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    assert.equal(result.supported, true);
    console.log('Relocated native FOMOD loaded and recognized an XML installer');
  `;
  const { stdout } = await exec(process.execPath, ["-e", probe, relocatedBinding], {
    cwd: temporary,
    env,
    timeout: 30_000,
  });
  console.log(stdout.trim());
} finally {
  await rm(temporary, { recursive: true, force: true });
}
