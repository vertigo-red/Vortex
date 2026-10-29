import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const readJson = async (file) => JSON.parse(await readFile(resolve(root, file), "utf8"));
const upstream = await readJson("packaging/arch/upstream.json");
assert.match(upstream.version, /^\d+\.\d+\.\d+$/);
assert.equal(upstream.tag, `v${upstream.version}`);
assert.match(upstream.commit, /^[0-9a-f]{40}$/);
// Keep this branch on the stable source tree while allowing local UX commits.
// Never replace the branch checkout with upstream master or a fresh tag checkout.
git("merge-base", "--is-ancestor", upstream.commit, "HEAD");

const release = process.env.GITHUB_RUN_NUMBER || "1";
assert.match(release, /^[1-9]\d*$/);
if (process.argv.includes("--source-hash")) {
  const entries = git("ls-tree", "-r", "-z", "HEAD")
    .split("\0")
    .filter((entry) => {
      const name = entry.slice(entry.indexOf("\t") + 1);
      return (
        name &&
        !name.startsWith("packaging/arch/") &&
        !name.startsWith("docs/") &&
        !/^[^/]+\.md$/.test(name) &&
        name !== "scripts/prepare-arch-package.mjs"
      );
    });
  console.log(createHash("sha256").update(entries.join("\0")).digest("hex"));
  process.exit(0);
}
if (process.argv.includes("--check-source")) {
  if (process.env.GITHUB_ENV) {
    await appendFile(
      process.env.GITHUB_ENV,
      `VORTEX_PACKAGE_VERSION=${upstream.version}\nVORTEX_PACKAGE_RELEASE=${release}\n`,
    );
  }
  console.log(
    `Stable baseline: ${upstream.tag} (${upstream.commit}); build source: ${git("rev-parse", "HEAD")}`,
  );
  process.exit(0);
}

const destination = resolve(root, "dist/arch");
await mkdir(destination, { recursive: true });
const main = await readJson("src/main/package.json");
assert.equal(main.version, upstream.version, "Inject the stable release version before building");
const require = createRequire(resolve(root, "src/main/package.json"));
const electron = require("electron/package.json").version;
const metadata = {
  upstream,
  commit: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"),
  branch: process.env.GITHUB_REF_NAME || git("branch", "--show-current"),
  package: `vortex-1:${upstream.version}-${release}-x86_64`,
  version: main.version,
  pkgrel: release,
  electron,
  node: process.versions.node,
  pnpm: execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["--version"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  }).trim(),
  run: process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null,
};
await writeFile(resolve(destination, "BUILD-INFO.json"), JSON.stringify(metadata, null, 2) + "\n");
const sources = [
  ["dist/vortex-app.tar.zst", "vortex-app.tar.zst"],
  ["packaging/arch/vortex", "vortex"],
  ["packaging/arch/vortex.desktop", "vortex.desktop"],
  ["assets/images/vortex.png", "vortex.png"],
  ["LICENSE.md", "LICENSE.md"],
];
for (const [source, name] of sources)
  await copyFile(resolve(root, source), resolve(destination, name));
const checksums = [];
for (const name of [...sources.map((entry) => entry[1]), "BUILD-INFO.json"]) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolve(destination, name))) hash.update(chunk);
  checksums.push(`'${hash.digest("hex")}'`);
}
const recipe = (await readFile(resolve(root, "packaging/arch/PKGBUILD"), "utf8"))
  .replace(/^pkgver=.*$/m, `pkgver=${upstream.version}`)
  .replace(/^pkgrel=.*$/m, `pkgrel=${release}`)
  .replace(/^sha256sums=.*$/m, `sha256sums=(${checksums.join(" ")})`);
await writeFile(resolve(destination, "PKGBUILD"), recipe);
console.log(
  `Staged vortex ${upstream.version}-${release}, Electron ${electron}, with SHA-256 for all package sources`,
);
