import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LinuxProcessProvider } from "./linuxProcessProvider";

let root: string;
let procRoot: string;

const hasMatchingProcfs =
  process.platform === "linux" &&
  (() => {
    try {
      return readFileSync("/proc/self/stat", "utf8").startsWith(`${process.pid} (`);
    } catch {
      return false;
    }
  })();
const hasPython =
  process.platform === "linux" &&
  spawnSync("python3", ["--version"], { timeout: 5000 }).status === 0;

async function file(relative: string): Promise<string> {
  const result = path.join(root, relative);
  await mkdir(path.dirname(result), { recursive: true });
  await writeFile(result, "fixture");
  return result;
}

async function processFixture(
  options: {
    pid?: number;
    ppid?: number;
    name?: string;
    runtime?: string;
    args?: string[];
    cwd?: string;
    environment?: Record<string, string>;
    state?: string;
  } = {},
) {
  const pid = options.pid ?? 4001;
  const directory = path.join(procRoot, String(pid));
  await mkdir(directory, { recursive: true });
  const runtime =
    options.runtime === undefined ? undefined : await file(`runtimes/${options.runtime}`);
  const fields = [
    options.state ?? "S",
    String(options.ppid ?? 0),
    ...Array<string>(17).fill("0"),
    "12345",
  ];
  await writeFile(
    path.join(directory, "stat"),
    `${pid} (${options.name ?? "Game.exe"}) ${fields.join(" ")}`,
  );
  await writeFile(path.join(directory, "cmdline"), `${(options.args ?? []).join("\0")}\0`);
  await writeFile(
    path.join(directory, "environ"),
    Object.entries(options.environment ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\0"),
  );
  if (runtime !== undefined) await symlink(runtime, path.join(directory, "exe"));
  if (options.cwd !== undefined) await symlink(options.cwd, path.join(directory, "cwd"));
  return { pid, directory, runtime };
}

async function prefix(name: string, drive: string, target: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, "dosdevices"), { recursive: true });
  await symlink(
    path.relative(path.join(directory, "dosdevices"), target),
    path.join(directory, "dosdevices", `${drive}:`),
  );
  return directory;
}

describe.skipIf(process.platform !== "linux")("Linux procfs process identities", () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "vortex-procfs-"));
    procRoot = path.join(root, "proc");
    await mkdir(procRoot);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses the full native binary path despite a truncated comm and spoofed argv[0]", async () => {
    const proc = await processFixture({
      runtime: "VeryLongGameExecutableName",
      name: "VeryLongGameExe",
      args: ["/another/Game.exe", ""],
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toEqual([
      { pid: proc.pid, ppid: 0, name: "VeryLongGameExe", path: proc.runtime },
    ]);
  });

  it("parses parent IDs when comm contains spaces, parentheses and a newline", async () => {
    await processFixture({ name: "Game (Beta)\n.exe", ppid: 123 });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([
      { pid: 4001, ppid: 123 },
    ]);
  });

  it.each(["Z", "X"])("excludes a process in state %s", async (state) => {
    await processFixture({ state, runtime: "Game.exe" });
    expect(await new LinuxProcessProvider(procRoot).list()).toEqual([]);
  });

  it("keeps readable ancestors but skips vanished and malformed entries", async () => {
    await processFixture({ ppid: 10 });
    await mkdir(path.join(procRoot, "4002"));
    await mkdir(path.join(procRoot, "4003"));
    await writeFile(path.join(procRoot, "4003", "stat"), "invalid");
    await mkdir(path.join(procRoot, "not-a-pid"));
    expect(await new LinuxProcessProvider(procRoot).list()).toEqual([
      { pid: 4001, ppid: 10, name: "Game.exe", path: undefined },
    ]);
  });

  it.each(["python3.11", "bash", "dash"])(
    "resolves a relative script argument for %s with literal quotes and Unicode",
    async (runtime) => {
      const script = await file(`Tools '日本語'/Sort "Mods".py`);
      await processFixture({
        runtime,
        args: [runtime, "-u", path.basename(script), "", "--flag"],
        cwd: path.dirname(script),
      });
      expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: script }]);
    },
  );

  it("resolves a Python script after options with their own values", async () => {
    const script = await file("Tools/Sort.py");
    await processFixture({
      runtime: "python3",
      args: ["python3", "-W", "ignore", "-X", "utf8", "--", script],
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: script }]);
  });

  it.each([
    ["python3", "-c"],
    ["python3", "-m"],
    ["python3", "-"],
    ["python3", "-V"],
    ["bash", "-c"],
  ])("does not treat a data argument to %s %s as the running script", async (runtime, option) => {
    const script = await file("Tools/Sort.py");
    const proc = await processFixture({
      runtime,
      args: [runtime, option, "code-or-module", script],
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: proc.runtime }]);
  });

  it("resolves a Java archive after JVM and classpath options", async () => {
    const archive = await file("Tools/Sort Mods.jar");
    await processFixture({
      runtime: "java",
      args: ["java", "-Xmx1G", "-Dname=value", "-cp", "libs/*", "-jar", path.basename(archive)],
      cwd: path.dirname(archive),
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: archive }]);
  });

  it("does not interpret a Java main class's data arguments as an archive launch", async () => {
    const archive = await file("Tools/Sort.jar");
    const proc = await processFixture({
      runtime: "java",
      args: ["java", "MainClass", "-jar", archive],
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: proc.runtime }]);
  });

  it.each([true, false])(
    "resolves Wine's Unix executable with loader argv present=%s",
    async (loaderPresent) => {
      const executable = await file("Steam Games '日本語'/Game.exe");
      await processFixture({
        runtime: "wine64-preloader",
        args: [...(loaderPresent ? ["wine64"] : []), executable, "", "other argument", ""],
      });
      expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: executable }]);
    },
  );

  it("maps a Windows drive through that process's Wine prefix and preserves disk spelling", async () => {
    const executable = await file("Prefix A/drive_c/Games '日本語'/Game.exe");
    const winePrefix = await prefix("Prefix A", "c", path.join(root, "Prefix A", "drive_c"));
    await processFixture({
      runtime: "wine64",
      args: ["c:\\games '日本語'\\GAME.EXE"],
      environment: { WINEPREFIX: winePrefix, SECRET_TEST_VALUE: "do-not-export" },
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toEqual([
      { pid: 4001, ppid: 0, name: "Game.exe", path: executable },
    ]);
  });

  it("keeps identical Windows command lines in separate prefixes distinct", async () => {
    const first = await file("Prefix A/drive_c/Game.exe");
    const second = await file("Prefix B/drive_c/Game.exe");
    const prefixA = await prefix("Prefix A", "c", path.dirname(first));
    const prefixB = await prefix("Prefix B", "c", path.dirname(second));
    await processFixture({
      pid: 4101,
      runtime: "wine",
      args: ["C:\\Game.exe"],
      environment: { WINEPREFIX: prefixA },
    });
    await processFixture({
      pid: 4102,
      runtime: "wine",
      args: ["C:\\Game.exe"],
      environment: { WINEPREFIX: prefixB },
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: 4101, path: first }),
        expect.objectContaining({ pid: 4102, path: second }),
      ]),
    );
  });

  it("uses STEAM_COMPAT_DATA_PATH only when WINEPREFIX is absent", async () => {
    const executable = await file("compatdata/42/pfx/drive_c/Game.exe");
    await prefix("compatdata/42/pfx", "c", path.dirname(executable));
    await processFixture({
      runtime: "wine64",
      args: ["\\\\?\\C:\\Game.exe"],
      environment: { STEAM_COMPAT_DATA_PATH: path.join(root, "compatdata/42") },
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: executable }]);
  });

  it("does not replace an explicit Wine prefix with a different Steam prefix", async () => {
    const selected = await file("Selected/drive_c/Game.exe");
    const other = await file("Steam/pfx/drive_c/Game.exe");
    const selectedPrefix = await prefix("Selected", "c", path.dirname(selected));
    await prefix("Steam/pfx", "c", path.dirname(other));
    await processFixture({
      runtime: "wine64",
      args: ["C:\\Game.exe"],
      environment: { WINEPREFIX: selectedPrefix, STEAM_COMPAT_DATA_PATH: path.join(root, "Steam") },
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: selected }]);
  });

  it("resolves parent components in a relative Wine executable path", async () => {
    const executable = await file("Steam Games/Game.exe");
    await mkdir(path.join(root, "Steam Games", "Tools"));
    await processFixture({
      runtime: "wine64",
      args: ["..\\.\\GAME.EXE"],
      cwd: path.join(root, "Steam Games", "Tools"),
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: executable }]);
  });

  it("honors a custom Z: mapping instead of assuming the host root", async () => {
    const executable = await file("Custom drive/Game.exe");
    const winePrefix = await prefix("Custom prefix", "z", path.dirname(executable));
    await processFixture({
      runtime: "wine",
      args: ["Z:\\Game.exe"],
      environment: { WINEPREFIX: winePrefix },
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: executable }]);
  });

  it("does not guess a drive mapping when the Wine prefix is unavailable", async () => {
    await file("Game.exe");
    const proc = await processFixture({ runtime: "wine64", args: ["Z:\\Game.exe"] });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: proc.runtime }]);
  });

  it("rejects ambiguous Windows filename casing while preferring an exact spelling", async () => {
    const exact = await file("drive/Game.exe");
    await file("drive/game.exe");
    const winePrefix = await prefix("pfx", "c", path.dirname(exact));
    const ambiguous = await processFixture({
      pid: 4201,
      runtime: "wine",
      args: ["C:\\GAME.EXE"],
      environment: { WINEPREFIX: winePrefix },
    });
    await processFixture({
      pid: 4202,
      runtime: "wine",
      args: ["C:\\Game.exe"],
      environment: { WINEPREFIX: winePrefix },
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: 4201, path: ambiguous.runtime }),
        expect.objectContaining({ pid: 4202, path: exact }),
      ]),
    );
  });

  it("resolves a relative Wine executable in its working directory", async () => {
    const executable = await file("Steam Games/Binaries/Game.exe");
    await processFixture({
      runtime: "wine64",
      args: ["binaries\\GAME.EXE"],
      cwd: path.join(root, "Steam Games"),
    });
    expect(await new LinuxProcessProvider(procRoot).list()).toMatchObject([{ path: executable }]);
  });

  it("does not match later Wine data arguments or an unrelated native program", async () => {
    const executable = await file("Game.exe");
    const wine = await processFixture({
      pid: 4301,
      runtime: "wine",
      args: ["C:\\missing.exe", executable],
    });
    const other = await processFixture({ pid: 4302, runtime: "grep", args: ["grep", executable] });
    expect(await new LinuxProcessProvider(procRoot).list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pid: 4301, path: wine.runtime }),
        expect.objectContaining({ pid: 4302, path: other.runtime }),
      ]),
    );
  });

  it.skipIf(!hasMatchingProcfs || !hasPython)(
    "identifies a real Python tool with a quoted Unicode filename",
    async () => {
      const script = await file("Tools '日本語'/Sort \"Mods\".py");
      await writeFile(script, "import time\nprint('ready', flush=True)\ntime.sleep(30)\n");
      const child = spawn("python3", ["-u", path.basename(script), "", "quoted ' argument"], {
        cwd: path.dirname(script),
      });
      try {
        await once(child.stdout, "data");
        const processes = await new LinuxProcessProvider().list();
        expect(processes.find((proc) => proc.pid === child.pid)).toMatchObject({
          path: script,
          ppid: process.pid,
        });
      } finally {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    },
  );
});
