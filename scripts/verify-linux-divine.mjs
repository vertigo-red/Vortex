import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

async function loadSource(relative, replacements = {}) {
  let source = await readFile(new URL(relative, import.meta.url), "utf8");
  for (const [from, to] of Object.entries(replacements)) source = source.replace(from, to);
  const url = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
  return { url, module: await import(url) };
}

const processModule = await loadSource(
  "../extensions/games/game-baldursgate3/src/divineProcess.ts",
);
const { module: core } = await loadSource(
  "../extensions/games/game-baldursgate3/src/divineCore.ts",
  {
    '"./divineProcess"': JSON.stringify(processModule.url),
  },
);
const {
  module: { buildProtonCommand },
} = await loadSource("../src/renderer/src/util/linux/protonCommand.ts");
const {
  module: { toWinePath },
} = await loadSource("../src/renderer/src/util/linux/winePaths.ts");
const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "vortex-divine-wine-"));
const compatData = path.join(root, "Secondary library", "compatdata", "1086940");
const prefix = path.join(compatData, "pfx");
const tools = path.join(root, "Staging 日本語 'quote' $() !", "tools");
const selectedProton = path.join(root, "Selected compatibility tool");
const wine = process.env.VORTEX_TEST_WINE ?? "/usr/lib/wine/wine64";
const server = process.env.VORTEX_TEST_WINESERVER ?? "/usr/lib/wine/wineserver64";
const env = { ...process.env, WINEPREFIX: prefix, WINEARCH: "win64", WINEDEBUG: "-all" };
const runtimeUrl =
  "https://builds.dotnet.microsoft.com/dotnet/Runtime/8.0.31/dotnet-runtime-8.0.31-win-x64.zip";
const runtimeHash =
  "9c55c58694676ee64b0eed2cd6d8cbf58b9aa8288420acc66841e15ca0099c75d4af0182d23a641c2342e5a151a325df4a12fa0bde2e47c0fb7e9a33e7b09896";
const lslibUrl =
  "https://github.com/Norbyte/lslib/releases/download/v1.20.4/ExportTool-v1.20.4.zip";
const lslibHash = "5e02368fb8acafda9b45acba37a3f3bf507fc3d65a083a159abbeab06337190e";

async function download(url, algorithm, digest, filename) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  assert.ok(response.ok, `Download failed: ${response.status} ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash(algorithm).update(data).digest("hex"), digest, "Download checksum");
  await writeFile(filename, data);
}

async function run(executable, args) {
  return execute(executable, args, { env, timeout: 60000, maxBuffer: 1024 * 1024 });
}

function launch(executable, action, options) {
  const args = core
    .buildDivineArgs(action, options)
    .map((arg, index, all) =>
      ["--source", "--destination"].includes(all[index - 1]) ? toWinePath(prefix, arg) : arg,
    );
  return {
    ...buildProtonCommand(selectedProton, toWinePath(prefix, executable), args),
    env: {
      WINEPREFIX: prefix,
      WINEDEBUG: "-all",
      WINEARCH: "win64",
      VORTEX_TEST_WINE: wine,
      STEAM_COMPAT_DATA_PATH: compatData,
      DOTNET_ROOT_X64: "C:\\dotnet",
      DOTNET_ROOT: "C:\\dotnet",
    },
  };
}

async function invoke(executable, action, options, extra = {}) {
  return core.runDivineCore(executable, action, options, {
    command: launch(executable, action, options),
    timeoutMs: 30000,
    ...extra,
  });
}

try {
  await Promise.all(
    [tools, selectedProton, compatData].map((directory) => mkdir(directory, { recursive: true })),
  );
  const runtimeZip = path.join(root, "runtime.zip");
  const lslibZip = path.join(root, "lslib.zip");
  await Promise.all([
    download(runtimeUrl, "sha512", runtimeHash, runtimeZip),
    download(lslibUrl, "sha256", lslibHash, lslibZip),
  ]);
  const version = await run(wine, ["--version"]);
  if (process.env.VORTEX_TEST_WINE_MAJOR) {
    assert.match(version.stdout, new RegExp(`^wine-${process.env.VORTEX_TEST_WINE_MAJOR}\\.`));
  }
  await run(wine, ["cmd.exe", "/c", "ver"]);
  await rm(path.join(prefix, "dosdevices", "z:"));
  // A nonstandard Z mapping catches hardcoded Z:\\host-path conversions.
  await symlink(root, path.join(prefix, "dosdevices", "z:"));
  await run("unzip", ["-q", runtimeZip, "-d", path.join(prefix, "drive_c", "dotnet")]);
  const release = path.join(root, "release");
  await run("unzip", ["-q", lslibZip, "-d", release]);
  await cp(path.join(release, "Packed", "Tools"), tools, { recursive: true });
  const executable = await core.resolveDivineExecutable(tools);
  assert.equal(path.basename(executable), "Divine.exe");
  const driver = path.join(selectedProton, "proton");
  // This receiver exercises the production command shape with real Wine, not a Proton distribution.
  await writeFile(
    driver,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args.shift() !== 'run') process.exit(91);
const child = spawn(process.env.VORTEX_TEST_WINE, args, { stdio: 'inherit', shell: false });
child.on('error', (error) => { console.error(error); process.exit(92); });
child.on('exit', (code) => { process.exitCode = code ?? 93; });
`,
  );
  await chmod(driver, 0o755);
  const source = path.join(root, "Source 日本語 ' $() ! %literal%");
  const destination = path.join(root, "Destination 日本語 & ; !");
  await mkdir(source);
  await cp(
    new URL("../extensions/games/game-baldursgate3/src/__fixtures__/pakSource/", import.meta.url),
    source,
    { recursive: true },
  );
  const specialFile = "Unicode 日本語 ! %literal% $().txt";
  const payload = "Native Vortex through Wine: 日本語\n";
  await writeFile(path.join(source, specialFile), payload);
  const pak = path.join(root, "Mod 日本語 ' ! %literal% $().pak");
  const creation = { source, destination: pak };
  const missingRuntime = launch(executable, "create-package", creation);
  missingRuntime.env.DOTNET_ROOT_X64 = "C:\\NoRuntime";
  missingRuntime.env.DOTNET_ROOT = "C:\\NoRuntime";
  await assert.rejects(
    core.runDivineCore(executable, "create-package", creation, {
      command: missingRuntime,
      timeoutMs: 30000,
    }),
    core.DivineMissingDotNet,
  );
  await invoke(executable, "create-package", creation);
  const listed = await invoke(executable, "list-package", { source: pak });
  assert.match(listed.stdout, /meta\.lsx/);
  assert.ok(listed.stdout.includes(specialFile), listed.stdout);
  await invoke(executable, "extract-package", { source: pak, destination, expression: "*" });
  assert.equal(await readFile(path.join(destination, specialFile), "utf8"), payload);
  assert.deepEqual(
    await readFile(path.join(destination, "meta.lsx")),
    await readFile(path.join(source, "meta.lsx")),
  );
  const filtered = path.join(root, "Filtered extraction");
  await invoke(executable, "extract-package", {
    source: pak,
    destination: filtered,
    expression: "*.lsx",
  });
  assert.deepEqual(
    await readFile(path.join(filtered, "meta.lsx")),
    await readFile(path.join(source, "meta.lsx")),
  );
  await assert.rejects(readFile(path.join(filtered, specialFile)), { code: "ENOENT" });
  const corrupt = path.join(root, "corrupt.pak");
  await writeFile(corrupt, "not an LSPK archive");
  await assert.rejects(
    invoke(executable, "list-package", { source: corrupt }),
    core.DivinePakInvalid,
  );
  await assert.rejects(
    invoke(executable, "list-package", { source: pak }, { timeoutMs: 1 }),
    core.DivineTimedOut,
  );
  const controller = new AbortController();
  const aborted = invoke(
    executable,
    "list-package",
    { source: pak },
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(aborted, core.DivineAborted);
  console.log(
    `Real Divine v1.20.4 with Windows .NET 8.0.31 on ${version.stdout.trim()}: 8 CLI checks passed`,
  );
  console.log(
    "Verified runtime diagnostics, create/list/extract/glob, Unicode and custom Z paths, corrupt PAK, timeout and cancellation.",
  );
} finally {
  await run(server, ["-k"]).catch((error) => {
    if (error.code !== 1 || error.stdout || error.stderr) throw error;
  });
  await run(server, ["-w"]);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
