import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const master = "Base.esm";
const plugin = "Мод 日本語 🎮.esp";

// Minimal Skyrim SE TES4 records, with a MAST/DATA pair declaring the dependency.
function pluginBytes(masters = []) {
  const hedr = Buffer.alloc(18);
  hedr.write("HEDR");
  hedr.writeUInt16LE(12, 4);
  hedr.writeFloatLE(1.7, 6);
  hedr.writeUInt32LE(0x800, 14);
  const subrecords = [hedr];
  for (const name of masters) {
    const encoded = Buffer.from(name + "\0", "latin1");
    const mast = Buffer.alloc(6 + encoded.length);
    mast.write("MAST");
    mast.writeUInt16LE(encoded.length, 4);
    encoded.copy(mast, 6);
    const data = Buffer.alloc(14);
    data.write("DATA");
    data.writeUInt16LE(8, 4);
    subrecords.push(mast, data);
  }
  const body = Buffer.concat(subrecords);
  const header = Buffer.alloc(24);
  header.write("TES4");
  header.writeUInt32LE(body.length, 4);
  header.writeUInt16LE(44, 20);
  return Buffer.concat([header, body]);
}

async function waitForRemoval(endpoint) {
  for (let retry = 0; retry < 100; ++retry) {
    try {
      await access(endpoint);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    await delay(50);
  }
  throw new Error(`LOOT left its Unix socket behind: ${endpoint}`);
}

async function probe(packageRoot, gamePath, localPath) {
  assert.ok(process.versions.electron, "Run the probe with the packaged Electron executable");
  const require = createRequire(import.meta.url);
  const { LootAsync } = require(path.join(packageRoot, "index.js"));
  const workers = [];
  let endpoint;
  const launch = (script, args) => {
    endpoint = args[0];
    const worker = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
    workers.push(worker);
    // Match Vortex's runExecutable contract: settle only when the worker terminates.
    return new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(Object.assign(new Error("LOOT worker failed"), { exitCode: code ?? signal })),
      );
    });
  };
  let loot;
  try {
    loot = await LootAsync.create("skyrimse", gamePath, localPath, "en", () => {}, launch);
    await loot.loadCurrentLoadOrderState();
    await loot.loadPlugins([plugin, master], false);
    assert.deepEqual((await loot.getPlugin(plugin)).masters, [master]);
    assert.deepEqual(await loot.sortPlugins([plugin, master]), [master, plugin]);
    const groups = [
      {
        name: "Группа 🎮",
        afterGroups: ["default"],
        description: "Большой ответ 日本語 🎮 ".repeat(4000),
      },
    ];
    await loot.setUserGroups(groups);
    assert.deepEqual(
      (await loot.getUserGroups()).filter((group) => group.name !== "default"),
      groups,
    );
    const closed = once(workers.at(-1), "exit");
    const activeEndpoint = endpoint;
    loot.close();
    assert.deepEqual(await closed, [0, null]);
    await waitForRemoval(activeEndpoint);

    // Closing the parent connection must release the native callback's worker too.
    loot = await LootAsync.create("skyrimse", gamePath, localPath, "en", () => {}, launch);
    const disconnected = once(workers.at(-1), "exit");
    loot.socket.destroy();
    assert.deepEqual(await disconnected, [1, null]);
    await waitForRemoval(endpoint);

    await assert.rejects(
      LootAsync.create(
        "skyrimse",
        gamePath,
        localPath,
        "en",
        () => {},
        (_script, args) => {
          endpoint = args[0];
          const worker = spawn(process.execPath, ["-e", "process.exit(23)"], { stdio: "inherit" });
          workers.push(worker);
          return worker;
        },
      ),
      { name: "RemoteDied", call: "init", code: "23" },
    );
    await waitForRemoval(endpoint);
    console.log(
      "Relocated LOOT sorted dependent Unicode plugins through Electron IPC; workers and sockets closed",
    );
  } finally {
    loot?.close();
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill();
    }
  }
}

async function verify(binary, resources) {
  const source = path.resolve(resources, "app.asar.unpacked/assets/loot");
  const temporary = await mkdtemp(path.join(tmpdir(), "vortex-loot-"));
  try {
    const relocated = path.join(temporary, "package");
    const release = path.join(relocated, "build/Release");
    const runtime = path.join(temporary, "ipc");
    const game = path.join(temporary, "Игра 🎮 with spaces");
    const data = path.join(game, "Data");
    const local = path.join(
      temporary,
      "compatdata/489830/pfx/drive_c/users/steamuser/AppData/Local/Skyrim Special Edition",
    );
    await Promise.all([
      mkdir(release, { recursive: true }),
      mkdir(data, { recursive: true }),
      mkdir(local, { recursive: true }),
      mkdir(runtime, { mode: 0o700 }),
    ]);
    for (const name of [
      "index.js",
      "async.js",
      "build/Release/node-loot.node",
      "build/Release/libloot.so.0",
    ]) {
      await copyFile(path.join(source, name), path.join(relocated, name));
    }
    await Promise.all([
      writeFile(path.join(data, master), pluginBytes()),
      writeFile(path.join(data, plugin), pluginBytes([master])),
    ]);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", XDG_RUNTIME_DIR: runtime };
    delete env.LD_LIBRARY_PATH;
    delete env.LD_PRELOAD;
    const { stdout } = await exec(
      path.resolve(binary),
      [import.meta.filename, "--probe", relocated, game, local],
      { cwd: temporary, env, timeout: 90_000 },
    );
    console.log(stdout.trim());
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.platform !== "linux") {
  throw new Error("This packaged LOOT probe requires Linux");
} else if (process.argv[2] === "--probe") {
  await probe(...process.argv.slice(3));
} else if (process.argv.length === 4) {
  await verify(process.argv[2], process.argv[3]);
} else {
  throw new Error(
    "Usage: node scripts/verify-linux-loot.mjs <packaged-binary> <packaged-resources>",
  );
}
