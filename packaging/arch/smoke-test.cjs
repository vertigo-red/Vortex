const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const resources = "/opt/vortex/resources";
const unpacked = join(resources, "app.asar.unpacked");
const appRequire = createRequire(join(resources, "app.asar/package.json"));

async function main() {
    assert.ok(process.versions.electron, "Run with the packaged Electron runtime");
    const fomod = appRequire("@nexusmods/fomod-installer-native");
    assert.equal(typeof fomod.NativeModInstaller, "function");
    assert.equal(typeof fomod.allocAliveCount(), "number");
    console.log("FOMOD native addon and companion library: OK");

    const loot = require(join(unpacked, "assets/loot"));
    assert.equal(typeof loot.Loot, "function");
    assert.equal(typeof loot.IsCompatible, "function");
    console.log("LOOT native addon and companion library: OK");

    const font = require(join(unpacked, "bundledPlugins/theme-switcher/fontmanager.node"));
    assert.ok(Array.isArray(font.getAvailableFontsSync()));
    console.log("Font scanner: OK");

    // Linux exports an empty shim here. This tests module resolution, not WinAPI.
    assert.equal(typeof appRequire("winapi-bindings"), "object");
    console.log("winapi-bindings Linux shim: OK");

    const { DuckDBInstance } = appRequire("@duckdb/node-api");
    const instance = await DuckDBInstance.create(":memory:", {
        allow_unsigned_extensions: "true",
        extension_directory: join(unpacked, "duckdb-extensions"),
    });
    const connection = await instance.connect();
    try {
        await connection.run("LOAD level_pivot");
        const result = await connection.runAndReadAll("SELECT 42::INTEGER AS answer");
        assert.deepEqual(result.getRows(), [[42]]);
        console.log("DuckDB query and bundled level_pivot extension: OK");
    } finally {
        connection.closeSync();
        instance.closeSync();
    }

    const directory = mkdtempSync(join(tmpdir(), "vortex-leveldb-"));
    const db = appRequire("leveldown")(directory);
    try {
        await new Promise((resolve, reject) => db.open((err) => (err ? reject(err) : resolve())));
        await new Promise((resolve, reject) =>
            db.put("test", "value", (err) => (err ? reject(err) : resolve())),
        );
        const value = await new Promise((resolve, reject) =>
            db.get("test", (err, data) => (err ? reject(err) : resolve(data))),
        );
        assert.equal(value.toString(), "value");
        console.log("LevelDB read/write: OK");
    } finally {
        await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
        rmSync(directory, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
