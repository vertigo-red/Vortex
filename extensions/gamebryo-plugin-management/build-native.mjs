#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(here, "dist");
const lootDir = path.join(here, "node_modules", "loot");
const liblootCommit = "7104c92bef8990316482dc79a9f42ecddf58953e";
const expectedLootVersion = "6.2.3";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? here,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: { ...process.env, ...options.env },
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout?.trim() ?? "";
}

function copyNative(source, targetName = path.basename(source)) {
  const target = path.join(distDir, targetName);
  fs.mkdirSync(distDir, { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

function writePatchedAsync() {
  const source = path.join(lootDir, "async.js");
  const target = path.join(distDir, "async.js");
  const original = fs.readFileSync(source, "utf8");
  const patched = original.replace("./build/Release/node-loot", "./node-loot");
  if (patched === original) {
    throw new Error("node-loot async.js require target was not found");
  }
  fs.writeFileSync(target, patched);
}

function verifyPinnedNodeLoot() {
  const pkg = JSON.parse(fs.readFileSync(path.join(lootDir, "package.json"), "utf8"));
  if (pkg.name !== "loot" || pkg.version !== expectedLootVersion) {
    throw new Error(
      `Unsupported node-loot dependency: ${pkg.name}@${pkg.version}; expected loot@${expectedLootVersion}`,
    );
  }
}

function buildWindows() {
  verifyPinnedNodeLoot();
  copyNative(path.join(lootDir, "build", "Release", "node-loot.node"));
  copyNative(path.join(lootDir, "loot_api", "libloot.dll"));
  writePatchedAsync();
}

function buildLinux() {
  verifyPinnedNodeLoot();

  for (const tool of ["git", "cmake", "rustc", "patchelf"]) {
    run(tool, ["--version"], { capture: true });
  }

  const bindingPath = path.join(lootDir, "binding.gyp");
  const napiPath = path.join(lootDir, "src", "napi_helpers.h");
  const originalBinding = fs.readFileSync(bindingPath, "utf8");
  const originalNapi = fs.readFileSync(napiPath, "utf8");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-libloot-"));
  const liblootDir = path.join(tempDir, "libloot");
  const lootApiDir = path.join(lootDir, "loot_api");
  const stagedSo = path.join(lootApiDir, "libloot.so.0");
  const stagedLink = path.join(lootApiDir, "libloot.so");

  try {
    run("git", ["init", liblootDir]);
    run("git", ["-C", liblootDir, "remote", "add", "origin", "https://github.com/loot/libloot.git"]);
    run("git", ["-C", liblootDir, "fetch", "--depth", "1", "origin", liblootCommit]);
    run("git", ["-C", liblootDir, "checkout", "--detach", "FETCH_HEAD"]);
    const actualCommit = run("git", ["-C", liblootDir, "rev-parse", "HEAD"], { capture: true });
    if (actualCommit !== liblootCommit) {
      throw new Error(`libloot checkout mismatch: ${actualCommit}`);
    }

    const cmakeBuild = path.join(liblootDir, "cpp", "build");
    run("cmake", [
      "-S",
      path.join(liblootDir, "cpp"),
      "-B",
      cmakeBuild,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCPACK_PACKAGE_VERSION=0.29.3",
      "-DLIBLOOT_BUILD_TESTS=OFF",
      "-DLIBLOOT_INSTALL_DOCS=OFF",
      "-DRUST_TARGET=x86_64-unknown-linux-gnu",
    ]);
    run("cmake", ["--build", cmakeBuild, "--parallel", "2"]);

    const builtSo = path.join(cmakeBuild, "libloot.so.0.29.3");
    if (!fs.existsSync(builtSo)) {
      throw new Error(`libloot shared library was not produced at ${builtSo}`);
    }
    fs.copyFileSync(builtSo, stagedSo);
    fs.rmSync(stagedLink, { force: true });
    fs.symlinkSync("libloot.so.0", stagedLink);

    const libraryNeedle = '"-l../loot_api/libloot"';
    if (!originalBinding.includes(libraryNeedle)) {
      throw new Error("Expected node-loot linker stanza was not found");
    }
    fs.writeFileSync(
      bindingPath,
      originalBinding.replace(libraryNeedle, '"<(module_root_dir)/loot_api/libloot.so"'),
    );

    const includeNeedle = "#include <napi.h>\n";
    const wideNeedle =
      "#ifdef _WIN32\ntemplate<>\nstd::wstring fromNAPI(const Napi::Value &info) {\n  return u8Tou16(info.ToString().Utf8Value());\n}\n#endif";
    if (!originalNapi.includes(includeNeedle) || !originalNapi.includes(wideNeedle)) {
      throw new Error("Expected node-loot N-API conversion source was not found");
    }
    const wideReplacement =
      "template<>\nstd::wstring fromNAPI(const Napi::Value &info) {\n#ifdef _WIN32\n  return u8Tou16(info.ToString().Utf8Value());\n#else\n  std::wstring_convert<std::codecvt_utf8<wchar_t>> converter;\n  return converter.from_bytes(info.ToString().Utf8Value());\n#endif\n}";
    fs.writeFileSync(
      napiPath,
      originalNapi
        .replace(
          includeNeedle,
          "#include <napi.h>\n#ifndef _WIN32\n#include <codecvt>\n#include <locale>\n#endif\n",
        )
        .replace(wideNeedle, wideReplacement),
    );

    run("pnpm", ["exec", "autogypi"], { cwd: lootDir });
    run("pnpm", ["exec", "node-gyp", "rebuild"], { cwd: lootDir });

    const addon = copyNative(path.join(lootDir, "build", "Release", "node-loot.node"));
    copyNative(stagedSo, "libloot.so.0");
    writePatchedAsync();

    run("patchelf", ["--set-rpath", "$ORIGIN", addon]);
    const rpath = run("patchelf", ["--print-rpath", addon], { capture: true });
    if (rpath !== "$ORIGIN") {
      throw new Error(`Unexpected node-loot RUNPATH: ${rpath}`);
    }

    const smoke = [
      `const loot=require(${JSON.stringify(addon)});`,
      "if(typeof loot.Loot!=='function') throw new Error('Loot constructor missing');",
      "if(!loot.IsCompatible(0,29,3)) throw new Error('libloot 0.29.3 ABI mismatch');",
    ].join("");
    run(process.execPath, ["-e", smoke]);
  } finally {
    fs.writeFileSync(bindingPath, originalBinding);
    fs.writeFileSync(napiPath, originalNapi);
    fs.rmSync(stagedLink, { force: true });
    fs.rmSync(stagedSo, { force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.platform === "win32") {
  buildWindows();
} else if (process.platform === "linux") {
  buildLinux();
} else {
  console.log(`Skipping Gamebryo native LOOT build on ${process.platform}`);
}
