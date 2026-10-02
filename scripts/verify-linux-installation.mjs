import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

const mode = process.argv[2];
if (process.platform !== "linux" || !["installed", "removed"].includes(mode)) {
  throw new Error("Usage on Linux: node scripts/verify-linux-installation.mjs <installed|removed>");
}
const config = JSON.parse(
  await readFile(new URL("../src/main/electron-builder.config.json", import.meta.url), "utf8"),
);
const name = config.linux.executableName;
const directory = path.join("/opt", config.productName);
const binary = path.join(directory, name);
const launcher = path.join("/usr/bin", name);
const desktop = path.join("/usr/share/applications", name + ".desktop");
const sandbox = path.join(directory, "chrome-sandbox");

if (mode === "removed") {
  for (const file of [directory, launcher, desktop]) {
    await assert.rejects(
      lstat(file),
      { code: "ENOENT" },
      "Package file remains after removal: " + file,
    );
  }
  console.log("DEB removal cleaned up the application, launcher and desktop entry");
} else {
  assert.equal(
    execFileSync("dpkg-query", ["-W", "-f=${Status}", name], { encoding: "utf8" }),
    "install ok installed",
  );
  assert.equal(
    await realpath(launcher),
    binary,
    "The system launcher must select the installed binary",
  );
  assert.ok((await stat(binary)).mode & 0o111, "The installed binary must be executable");
  const sandboxStat = await stat(sandbox);
  assert.equal(sandboxStat.uid, 0, "The sandbox helper must be owned by root");
  assert.equal(
    sandboxStat.mode & 0o7777,
    0o4755,
    "The sandbox helper must have its packaged setuid permissions",
  );

  const entry = await readFile(desktop, "utf8");
  assert.ok(entry.includes("Exec=" + binary), "The desktop entry must launch the installed binary");
  assert.match(entry, /^Exec=.*%[uU](?:\s|$)/m, "The desktop entry must forward Nexus links");
  assert.match(
    entry,
    /^MimeType=.*x-scheme-handler\/nxm(?:;|$)/m,
    "The desktop entry must declare Nexus links",
  );
  const owners = execFileSync("dpkg-query", ["-S", binary, sandbox, desktop], { encoding: "utf8" });
  for (const file of [binary, sandbox, desktop]) {
    assert.ok(owners.includes(name + ": " + file), "dpkg must track installed file: " + file);
  }
  console.log("DEB installation registered the launcher, desktop entry and sandbox permissions");
}
