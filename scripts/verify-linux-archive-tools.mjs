import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { buildArchiveTool } from "./build-archive-tools.mjs";

async function load(relative, replacements = {}) {
  let source = await readFile(new URL(relative, import.meta.url), "utf8");
  for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
  const url = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
  return { url, module: await import(url) };
}
const {
  module: { executeToolProcess },
} = await load("../src/renderer/src/util/executeToolProcess.ts");
const {
  module: { buildProtonCommand },
} = await load("../src/renderer/src/util/linux/protonCommand.ts");
const {
  module: { toWinePath },
} = await load("../src/renderer/src/util/linux/winePaths.ts");
const execute = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "vortex-archives-wine-"));
const prefix = path.join(root, "Secondary Library", "compatdata", "367500", "pfx");
const tools = path.join(root, "Tools 日本語 'quote' & ; !");
const userData = path.join(root, "userData 日本語");
const proton = path.join(root, "Selected Proton");
const runtime = path.join(root, "runtime");
const wine = process.env.VORTEX_TEST_WINE ?? "/usr/lib/wine/wine64";
const server = process.env.VORTEX_TEST_WINESERVER ?? "/usr/lib/wine/wineserver64";
const env = {
  ...process.env,
  WINEPREFIX: prefix,
  WINEARCH: "win64",
  WINEDEBUG: "-all",
  XDG_RUNTIME_DIR: runtime,
};
const discovery = { path: path.join(root, "Game 日本語"), store: "steam" };
const api = {
  store: {
    getState: () => ({
      settings: {
        gameMode: { discovered: { requested: discovery, wrong: { path: "/Wrong game" } } },
      },
    }),
  },
};
const launcher = path.join(tools, "vortex-archive-launcher.exe");
let checks = 0;
const sourcesOnly = process.argv.includes("--sources-only");
async function run(executable, args) {
  return execute(executable, args, { env, timeout: 90000, maxBuffer: 1024 * 1024 });
}
function command(executable, args) {
  return {
    ...buildProtonCommand(proton, toWinePath(prefix, launcher), [
      toWinePath(prefix, executable),
      ...args,
    ]),
    env,
  };
}

async function verify() {
  try {
    globalThis.__archiveFixtureTools = tools;
    globalThis.__archiveFixtureAPI = {
      types: {},
      log: () => {},
      fs: {
        moveAsync: async (source, destination) => {
          await rm(destination, { recursive: true, force: true });
          await mkdir(path.dirname(destination), { recursive: true });
          await cp(source, destination, { recursive: true });
          await rm(source, { recursive: true });
        },
      },
      selectors: { discoveryByGame: (state, id) => state.settings.gameMode.discovered[id] },
      util: {
        ArgumentInvalid: class extends Error {},
        getVortexPath: (kind) => (kind === "temp" ? root : userData),
        executeToolProcess,
        getProtonToolCommand: async (executable, args, selected) => {
          assert.equal(selected, discovery, "The requested game must control the prefix");
          return {
            ...buildProtonCommand(
              proton,
              toWinePath(prefix, executable),
              args.map((arg) => (typeof arg === "string" ? arg : toWinePath(prefix, arg.path))),
            ),
            env,
          };
        },
      },
    };
    const apiImport =
      "const { fs, log, selectors, types, util } = globalThis.__archiveFixtureAPI;\nconst __dirname = globalThis.__archiveFixtureTools;";
    const {
      module: { default: ARCWrapper },
    } = await load("../extensions/mtframework-arc-support/src/ARCWrapper.ts", {
      'import { fs, log, selectors, types, util } from "@nexusmods/vortex-api";': apiImport,
      'import PromiseBB from "bluebird";': "const PromiseBB = Promise;",
    });
    const typesModule = await load("../extensions/quickbms-support/src/types.ts");
    const { module: qbms } = await load("../extensions/quickbms-support/src/quickbms.ts", {
      'import { selectors, types, util } from "@nexusmods/vortex-api";': apiImport,
      '"./types"': JSON.stringify(typesModule.url),
    });
    if (sourcesOnly) {
      assert.equal(typeof ARCWrapper, "function");
      assert.equal(typeof qbms.list, "function");
      console.log("Production ARC/QuickBMS source imports verified without Wine");
      return;
    }
    await Promise.all(
      [tools, userData, proton, path.dirname(prefix)].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    await mkdir(runtime, { mode: 0o700 });
    const version = await run(wine, ["--version"]);
    assert.match(
      version.stdout,
      new RegExp(`^wine-${process.env.VORTEX_TEST_WINE_MAJOR ?? "[0-9]+"}\\.`),
    );
    await run(wine, ["cmd.exe", "/c", "ver"]);
    await rm(path.join(prefix, "dosdevices", "z:"));
    await symlink(root, path.join(prefix, "dosdevices", "d:"));
    await symlink(tools, path.join(prefix, "dosdevices", "z:"));
    for (const id of ["arc", "quickbms"]) {
      const extension = path.join(root, id);
      await buildArchiveTool(extension, id, (archive, output) =>
        run("unzip", ["-q", archive, "-d", output]),
      );
      await cp(path.join(extension, "dist"), tools, { recursive: true });
    }
    await writeFile(
      path.join(proton, "proton"),
      `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args.shift() !== 'run') process.exit(91);
const child = spawn(process.env.VORTEX_TEST_WINE, args, { stdio: 'inherit', shell: false });
child.on('error', (error) => { console.error(error); process.exit(92); });
child.on('exit', (code) => { process.exitCode = code ?? 93; });
`,
    );
    await chmod(path.join(proton, "proton"), 0o755);
    env.VORTEX_TEST_WINE = wine;
    const arc = new ARCWrapper(api, "requested");
    const source = path.join(root, "ARC source 日本語 & ;");
    const archive = path.join(root, "ARC 日本語 & ; ! =.arc");
    const output = path.join(root, "ARC output 日本語 & ;");
    await mkdir(source);
    const entries = {
      "one.tex": "first ARC payload",
      "folder/file with space=two.tex": "second ARC payload",
    };
    for (const [name, content] of Object.entries(entries)) {
      await mkdir(path.dirname(path.join(source, name)), { recursive: true });
      await writeFile(path.join(source, name), content);
    }
    await arc.create(archive, source, { game: "DD", version: 7 });
    assert.deepEqual((await readFile(archive)).subarray(0, 4), Buffer.from("ARC\0"));
    checks++;
    const listed = await arc.list(archive);
    assert.equal(listed.length, 2, `ARC list lost a record: ${JSON.stringify(listed)}`);
    checks++;
    const original = await readFile(archive);
    await arc.extract(archive, output);
    const extractedFiles = (await readdir(output, { recursive: true })).filter((name) =>
      Object.keys(entries).some((originalName) => name.startsWith(originalName.slice(0, -4))),
    );
    console.log("ARC list/extracted filenames:", JSON.stringify({ listed, extractedFiles }));
    assert.deepEqual(
      [...listed].sort(),
      [...extractedFiles].sort(),
      "ARC listing must match extracted filenames",
    );
    assert.ok(listed.includes("folder/file with space=two.tex"), JSON.stringify(listed));
    for (const [name, content] of Object.entries(entries))
      assert.equal(await readFile(path.join(output, name), "utf8"), content);
    assert.deepEqual(await readFile(archive), original);
    checks++;
    await stat(output + ".arc.txt");
    const repacked = path.join(root, "repacked.arc");
    await arc.create(repacked, output);
    assert.deepEqual(await arc.list(repacked), listed);
    checks++;
    const broken = path.join(root, "corrupt.arc.vortex_backup");
    await writeFile(broken, "invalid ARC data");
    await assert.rejects(arc.extract(broken, path.join(root, "broken-output")));
    assert.equal(await readFile(broken, "utf8"), "invalid ARC data");
    checks++;

    const qbmsArchive = path.join(root, "QuickBMS 日本語 & ; !.bin");
    const script = path.join(root, "Script 日本語 & ;.bms");
    const qbmsOutput = path.join(root, "QBMS output 日本語 & ;");
    await mkdir(qbmsOutput);
    const header = Buffer.alloc(20);
    header.write("VTX0");
    header.writeUInt32LE(20, 4);
    header.writeUInt32LE(4, 8);
    header.writeUInt32LE(24, 12);
    header.writeUInt32LE(4, 16);
    await writeFile(qbmsArchive, Buffer.concat([header, Buffer.from("ABCDWXYZ")]));
    await writeFile(
      script,
      'idstring "VTX0"\nget OFFSET long\nget SIZE long\nlog "folder/file with spaces.txt" OFFSET SIZE\nget OFFSET long\nget SIZE long\nlog "second.bin" OFFSET SIZE\n',
    );
    const props = {
      gameMode: "requested",
      bmsScriptPath: script,
      archivePath: qbmsArchive,
      operationPath: qbmsOutput,
      qbmsOptions: { overwrite: true },
    };
    assert.deepEqual(
      (await qbms.list(api, props)).map((entry) => entry.filePath),
      ["folder/file with spaces.txt", "second.bin"],
    );
    checks++;
    const simultaneous = await Promise.all(
      ["*.txt", "*.bin"].map((pattern) =>
        qbms.list(api, { ...props, qbmsOptions: { wildCards: [pattern] } }),
      ),
    );
    assert.deepEqual(
      simultaneous.map((list) => list.map((entry) => entry.filePath)),
      [["folder/file with spaces.txt"], ["second.bin"]],
    );
    checks++;
    await qbms.extract(api, props);
    assert.equal(
      await readFile(path.join(qbmsOutput, "folder", "file with spaces.txt"), "utf8"),
      "ABCD",
    );
    assert.equal(await readFile(path.join(qbmsOutput, "second.bin"), "utf8"), "WXYZ");
    checks++;
    await writeFile(path.join(qbmsOutput, "folder", "file with spaces.txt"), "REPL");
    await qbms.reImport(api, { ...props, qbmsOptions: { allowResize: false } });
    assert.equal((await readFile(qbmsArchive)).toString("ascii", 20, 24), "REPL");
    checks++;
    await writeFile(path.join(qbmsOutput, "folder", "file with spaces.txt"), "LONGER replacement");
    await qbms.reImport(api, { ...props, qbmsOptions: { allowResize: true } });
    const expanded = await qbms.list(api, props);
    assert.equal(expanded[0].size, String(Buffer.byteLength("LONGER replacement")));
    checks++;
    const writeScript = path.join(root, "write.bms");
    await writeFile(
      writeScript,
      'idstring "VTX0"\ngoto 12\nget OFFSET long\ngoto OFFSET\nput 0x44434241 long\n',
    );
    await qbms.write(api, { ...props, bmsScriptPath: writeScript });
    await qbms.extract(api, props);
    assert.equal(await readFile(path.join(qbmsOutput, "second.bin"), "utf8"), "ABCD");
    checks++;
    const badScript = path.join(root, "bad.bms");
    await writeFile(badScript, "not_a_bms_command\n");
    await assert.rejects(qbms.list(api, { ...props, bmsScriptPath: badScript }));
    checks++;
    assert.deepEqual(await readdir(path.join(userData, "temp", "archive-tools")), []);
    checks++;

    assert.deepEqual(await readdir(path.join(root, "vortex-archive-tools")), []);
    checks++;

    const receiverSource = path.join(root, "receiver.c");
    const receiver = path.join(tools, "receiver.exe");
    await writeFile(
      receiverSource,
      String.raw`
#include <windows.h>
#include <wchar.h>
int wmain(int count, wchar_t **args) {
  if (count < 3) return 81;
  HANDLE file = CreateFileW(args[2], GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return 82;
  DWORD written;
  if (!wcscmp(args[1], L"capture")) {
    WriteFile(file, L"\ufeff", 2, &written, NULL);
    for (int i = 3; i < count; ++i) {
      WriteFile(file, args[i], (DWORD)(wcslen(args[i]) * 2), &written, NULL);
      WriteFile(file, L"\r\n", 4, &written, NULL);
    }
    CloseHandle(file); return 0;
  }
  for (;;) { WriteFile(file, "x", 1, &written, NULL); Sleep(20); }
}
`,
    );
    await run("x86_64-w64-mingw32-gcc", [
      "-municode",
      "-static",
      "-Os",
      "-s",
      receiverSource,
      "-o",
      receiver,
    ]);
    const captured = path.join(root, "argv.txt");
    const literals = ["日本語 & ;", "", "%literal%", 'embedded"quote', "tail\\", "$(literal)!"];
    let plan = command(receiver, ["capture", toWinePath(prefix, captured), ...literals]);
    await executeToolProcess(plan.executable, plan.args, { env: plan.env, timeoutMs: 30000 });
    assert.deepEqual(
      (await readFile(captured))
        .toString("utf16le")
        .replace(/^\uFEFF/, "")
        .split("\r\n")
        .slice(0, -1),
      literals,
    );
    checks++;
    const heartbeat = path.join(root, "heartbeat");
    const otherHeartbeat = path.join(root, "unrelated-heartbeat");
    const otherController = new AbortController();
    const otherPlan = command(receiver, ["wait", toWinePath(prefix, otherHeartbeat)]);
    const unrelated = executeToolProcess(otherPlan.executable, otherPlan.args, {
      env: otherPlan.env,
      signal: otherController.signal,
      timeoutMs: 30000,
    }).catch((error) => error);
    const controller = new AbortController();
    plan = command(receiver, ["wait", toWinePath(prefix, heartbeat)]);
    const active = executeToolProcess(plan.executable, plan.args, {
      env: plan.env,
      signal: controller.signal,
      timeoutMs: 30000,
    }).catch((error) => error);
    let started = false;
    for (let attempt = 0; attempt < 200 && !started; attempt++) {
      started = await Promise.all([stat(heartbeat), stat(otherHeartbeat)])
        .then((files) => files.every((info) => info.size > 0))
        .catch(() => false);
      if (!started) await delay(25);
    }
    controller.abort();
    const cancelled = await active;
    assert.ok(started, `Windows process did not start: ${cancelled.message}`);
    assert.equal(cancelled.code, "ABORT_ERR");
    const before = await readFile(heartbeat);
    const otherBefore = await readFile(otherHeartbeat);
    await delay(150);
    assert.deepEqual(await readFile(heartbeat), before, "Cancelled Windows tool kept writing");
    checks++;
    assert.ok(
      (await stat(otherHeartbeat)).size > otherBefore.length,
      "Cancelling one Windows job stopped an unrelated job in the same prefix",
    );
    otherController.abort();
    assert.equal((await unrelated).code, "ABORT_ERR");
    checks++;
    plan = command(receiver, ["capture", toWinePath(prefix, captured), "prefix still usable"]);
    await executeToolProcess(plan.executable, plan.args, { env: plan.env, timeoutMs: 30000 });
    checks++;
    console.log(
      `Real ARCtool 0.9.713 and QuickBMS 0.12.0 on ${version.stdout.trim()}: ${checks} CLI checks passed`,
    );
    console.log(
      "Verified create/list/extract/file order, original ARC preservation, Unicode host paths, custom DOS mappings, parallel filters, reimport1/reimport2/write, errors, literal argv and Windows job cancellation.",
    );
  } finally {
    // Only this fixture's private prefix is stopped. Production never kills a game's wineserver.
    if (!sourcesOnly) {
      await run(server, ["-k"]).catch((error) => {
        if (error.code !== 1 || error.stdout || error.stderr) throw error;
      });
      await run(server, ["-w"]);
    }
    if (process.env.VORTEX_KEEP_ARCHIVE_FIXTURE === "1") {
      console.error(`Archive fixture files retained at ${root}`);
    } else {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    delete globalThis.__archiveFixtureAPI;
    delete globalThis.__archiveFixtureTools;
  }
}
await verify();
