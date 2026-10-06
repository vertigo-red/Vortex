import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = import.meta.dirname;
const DIST = join(ROOT, "dist");
const SOURCE = join(ROOT, "build", "source");
const UPSTREAM = "https://github.com/Nexus-Mods/fomod-installer.git";
const COMMIT = "af3c8355b2e22f1c7c4272c8eb3cb928ccb5f8c1";
const VERSION = "0.13.4";
const PATCH = join(ROOT, "missing-extender.patch");
const LIBRARY = "ModInstaller.Native.so";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function replaceFile(source, destination) {
  const temporary = `${destination}.vortex-${process.pid}`;
  try {
    await copyFile(source, temporary);
    // Replace pnpm's hardlink rather than modifying the cached package's inode.
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function build(packageRoot, sdkVersion) {
  const patch = await readFile(PATCH);
  const fingerprint = sha256(
    Buffer.concat([
      Buffer.from(`${COMMIT}\n${VERSION}\n${sdkVersion}\n`),
      patch,
      await readFile(join(ROOT, "build.mjs")),
      await readFile(join(ROOT, "global.json")),
    ]),
  );
  try {
    const info = JSON.parse(await readFile(join(DIST, "build-info.json"), "utf8"));
    if (
      info.fingerprint === fingerprint &&
      info.librarySha256 === sha256(await readFile(join(DIST, LIBRARY)))
    ) {
      console.log("Reusing verified native FOMOD build");
      return;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await rm(SOURCE, { recursive: true, force: true });
  await mkdir(SOURCE, { recursive: true });
  await exec("git", ["init", "--quiet"], { cwd: SOURCE });
  await exec("git", ["fetch", "--depth=1", UPSTREAM, COMMIT], { cwd: SOURCE });
  // This directory contains only disposable upstream build sources.
  await exec("git", ["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], { cwd: SOURCE });
  const { stdout: actualCommit } = await exec("git", ["rev-parse", "HEAD"], { cwd: SOURCE });
  if (actualCommit.trim() !== COMMIT) throw new Error("Unexpected FOMOD source commit");
  const upstreamPackage = JSON.parse(
    await readFile(join(SOURCE, "src/ModInstaller.Native.TypeScript/package.json"), "utf8"),
  );
  if (upstreamPackage.version !== VERSION) throw new Error("Unexpected FOMOD source version");
  await exec("git", ["apply", "--check", PATCH], { cwd: SOURCE });
  await exec("git", ["apply", PATCH], { cwd: SOURCE });

  console.log(`Building native FOMOD ${VERSION} from ${COMMIT} with .NET ${sdkVersion}`);
  await mkdir(DIST, { recursive: true });
  const { stdout, stderr } = await exec(
    "dotnet",
    [
      "publish",
      "src/ModInstaller.Native/ModInstaller.Native.csproj",
      "--self-contained",
      "-c",
      "Release",
      "-r",
      "linux-x64",
      "-o",
      DIST,
      "-p:CppCompilerAndLinker=gcc",
      "-p:UseSharedCompilation=false",
      "-m:1",
      "--disable-build-servers",
    ],
    { cwd: SOURCE, maxBuffer: 16 * 1024 * 1024, timeout: 600_000 },
  );
  console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  const normalizeHeader = (text) => text.replaceAll("\r\n", "\n").trim();
  const headers = await Promise.all([
    readFile(join(SOURCE, "src/ModInstaller.Native/ModInstaller.Native.h"), "utf8"),
    readFile(join(packageRoot, "ModInstaller.Native.h"), "utf8"),
  ]);
  if (normalizeHeader(headers[0]) !== normalizeHeader(headers[1])) {
    throw new Error("Rebuilt FOMOD ABI does not match the installed native binding");
  }
  const info = {
    version: VERSION,
    repository: UPSTREAM,
    commit: COMMIT,
    sdkVersion,
    patchSha256: sha256(patch),
    librarySha256: sha256(await readFile(join(DIST, LIBRARY))),
    fingerprint,
  };
  await copyFile(PATCH, join(DIST, "missing-extender.patch"));
  await copyFile(join(SOURCE, "LICENSE.md"), join(DIST, "LICENSE.md"));
  await writeFile(join(DIST, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
}

async function main() {
  if (process.platform !== "linux") return;
  if (process.arch !== "x64") throw new Error("Native Linux FOMOD currently requires x64");
  const require = createRequire(resolve(ROOT, "../../src/renderer/package.json"));
  const packageRoot = dirname(require.resolve("@nexusmods/fomod-installer-native/package.json"));
  const packageInfo = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  if (packageInfo.version !== VERSION)
    throw new Error("Update the native FOMOD patch for this version");
  const { stdout } = await exec("dotnet", ["--version"], { cwd: ROOT });
  const sdkVersion = stdout.trim();
  if (!sdkVersion.startsWith("9."))
    throw new Error("Building native FOMOD requires the .NET 9 SDK");
  await build(packageRoot, sdkVersion);
  for (const directory of [packageRoot, join(packageRoot, "prebuilds/linux-x64")]) {
    await access(directory);
    await replaceFile(join(DIST, LIBRARY), join(directory, LIBRARY));
  }
  console.log("Prepared patched native FOMOD for Linux development and tests");
}

await main();
