import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const archiveTools = {
  arc: {
    url: "https://www.fluffyquack.com/tools/ARCtool.zip",
    version: "0.9.713",
    archiveHash: "b57cee9dc8183b57efe153205e93ab587c5ad7b31cfae96da22fcf2008286836",
    executable: "ARCtool.exe",
    executableHash: "e1423b03432d3b9821afead3bf2f9f8542c102f8981e32e5770c04cc2ed3876c",
    readme: "readme.txt",
    packagedReadme: "ARCtool-readme.txt",
  },
  quickbms: {
    url: "https://mirror.aluigi.org/papers/quickbms.zip",
    version: "0.12.0",
    archiveHash: "b9d4f9efb55692994cd42a491cfea11f86e3375a618b9bd771583ce40ddb3828",
    executable: "quickbms_4gb_files.exe",
    executableHash: "3a248ab5f9f1dae7b999b4098cb623372ae29ebaefbb72f8c359cf3b72d2b5a7",
    readme: "quickbms.txt",
    packagedReadme: "QuickBMS-readme.txt",
  },
};

async function matches(filename, hash) {
  try {
    return (
      createHash("sha256")
        .update(await readFile(filename))
        .digest("hex") === hash
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function buildArchiveLauncher(outputDirectory) {
  const temporary = await mkdtemp(path.join(tmpdir(), "vortex-archive-launcher-"));
  try {
    const output = path.join(temporary, "vortex-archive-launcher.exe");
    execFileSync(
      "x86_64-w64-mingw32-gcc",
      [
        "-municode",
        "-mconsole",
        "-static",
        "-Os",
        "-s",
        "-Wall",
        "-Wextra",
        "-Werror",
        fileURLToPath(new URL("../extensions/archiveToolLauncher.c", import.meta.url)),
        "-o",
        output,
      ],
      { stdio: "inherit" },
    );
    await mkdir(outputDirectory, { recursive: true });
    await copyFile(output, path.join(outputDirectory, path.basename(output)));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Fetch a pinned official release, await extraction, and fail the build on incomplete or changed binaries. */
export async function buildArchiveTool(extensionDirectory, id, extract) {
  const tool = archiveTools[id];
  if (!tool) throw new Error(`Unknown archive tool: ${id}`);
  const output = path.join(extensionDirectory, "dist");
  await mkdir(output, { recursive: true });
  const executable = path.join(output, tool.executable);
  const readme = path.join(output, tool.packagedReadme);
  const hasReadme = await readFile(readme)
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  if (!(await matches(executable, tool.executableHash)) || !hasReadme) {
    const cache = path.join(extensionDirectory, "dl");
    await mkdir(cache, { recursive: true });
    const archive = path.join(cache, `${id}-${tool.version}-${tool.archiveHash.slice(0, 12)}.zip`);
    if (!(await matches(archive, tool.archiveHash))) {
      const response = await fetch(tool.url, { signal: AbortSignal.timeout(90000) });
      if (!response.ok) throw new Error(`${id} download failed: HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(data).digest("hex") !== tool.archiveHash) {
        throw new Error(
          `${id} release checksum changed; review and pin the new release before building`,
        );
      }
      const pending = archive + ".tmp";
      try {
        await writeFile(pending, data);
        await rename(pending, archive);
      } finally {
        await rm(pending, { force: true });
      }
    }
    const temporary = await mkdtemp(path.join(cache, "extract-"));
    try {
      if (extract) await extract(archive, temporary);
      else {
        const SevenZip = createRequire(path.join(extensionDirectory, "package.json"))("node-7z");
        await new SevenZip().extract(archive, temporary, { raw: [tool.executable, tool.readme] });
      }
      const unpacked = path.join(temporary, tool.executable);
      if (!(await matches(unpacked, tool.executableHash)))
        throw new Error(`${id} executable checksum mismatch`);
      await copyFile(unpacked, executable);
      await copyFile(path.join(temporary, tool.readme), readme);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  if (process.platform === "linux") await buildArchiveLauncher(output);
}
