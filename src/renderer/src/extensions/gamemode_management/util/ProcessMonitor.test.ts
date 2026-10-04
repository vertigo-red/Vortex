import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "path";

import { it, expect, vi } from "vitest";

import { setToolPid, setToolStopped } from "../../../actions";
import { makeExeId } from "../../../reducers/session";
import type { IDiscoveredTool } from "../../../types/IDiscoveredTool";
import type { IExtensionApi } from "../../../types/IExtensionContext";
import type { IState } from "../../../types/IState";
import { LinuxProcessProvider } from "./linuxProcessProvider";
import ProcessMonitor from "./ProcessMonitor";
import type { IProcessInfo, IProcessProvider } from "./processProvider";
import { defaultProcessProvider } from "./processProvider";

const gameId = "test-game";
const profileId = "profile-1";
const gamePath = "/games/test";
const gameExe = "Game.exe";
const gameExePath = path.join(gamePath, gameExe);
const toolPath = "/games/test/Tool.exe";
const hasMatchingProcfs =
  process.platform === "linux" &&
  (() => {
    try {
      return readFileSync("/proc/self/stat", "utf8").startsWith(`${process.pid} (`);
    } catch {
      return false;
    }
  })();

const buildTool = (overrides: Partial<IDiscoveredTool> = {}): IDiscoveredTool => ({
  id: "tool-1",
  name: "Tool",
  executable: () => "Tool.exe",
  requiredFiles: [],
  path: toolPath,
  hidden: false,
  custom: true,
  exclusive: false,
  ...overrides,
});

const buildState = (
  overrides: {
    toolsRunning?: IState["session"]["base"]["toolsRunning"];
    tools?: { [id: string]: IDiscoveredTool };
    gamePath?: string;
    gameExe?: string;
  } = {},
): IState => {
  const resolvedGamePath = overrides.gamePath ?? gamePath;
  const resolvedGameExe = overrides.gameExe ?? gameExe;

  return {
    session: {
      base: {
        toolsRunning: overrides.toolsRunning ?? {},
      },
      gameMode: {
        known: [
          {
            id: gameId,
            name: "Test Game",
            executable: resolvedGameExe,
            requiredFiles: [],
          },
        ],
      },
    },
    settings: {
      profiles: {
        activeProfileId: profileId,
      },
      gameMode: {
        discovered: {
          [gameId]: {
            path: resolvedGamePath,
            executable: resolvedGameExe,
            tools: overrides.tools ?? {},
          },
        },
      },
    },
    persistent: {
      profiles: {
        [profileId]: { id: profileId, gameId },
      },
    },
  } as unknown as IState;
};

const createMonitor = (state: IState, processes: IProcessInfo[] | IProcessProvider) => {
  const store = {
    dispatch: vi.fn(),
    getState: vi.fn(() => state),
  };
  const processProvider: IProcessProvider = Array.isArray(processes)
    ? { list: vi.fn().mockResolvedValue(processes) }
    : processes;
  const monitor = new ProcessMonitor({ store } as unknown as IExtensionApi, processProvider);
  return {
    monitor: monitor as unknown as { doCheck(): Promise<void> },
    store,
    processProvider,
  };
};

async function windowsContract(check: () => Promise<void>): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await check();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
}

it.skipIf(process.platform !== "linux")(
  "tracks nested executables declared with Windows separators",
  async () => {
    const executable = path.join(gamePath, "Binaries", "Win64", gameExe);
    const state = buildState({ gameExe: "Binaries\\Win64\\Game.exe" });
    const { monitor, store } = createMonitor(state, [
      { pid: 7001, ppid: 0, name: gameExe, path: executable },
    ]);
    await monitor.doCheck();
    expect(store.dispatch).toHaveBeenCalledWith(setToolPid(executable, 7001, true));
  },
);

it.skipIf(process.platform !== "linux")(
  "does not confuse Linux directories that differ only by case",
  async () => {
    const state = buildState();
    const { monitor, store } = createMonitor(state, [
      { pid: 7002, ppid: 0, name: gameExe, path: path.join(gamePath.toUpperCase(), gameExe) },
    ]);
    await monitor.doCheck();
    expect(store.dispatch).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== "linux")(
  "drops a cached PID that now belongs to another Linux path",
  async () => {
    const state = buildState({
      toolsRunning: { [makeExeId(gameExePath)]: { pid: 7003, started: 1, exclusive: true } },
    });
    const { monitor, store } = createMonitor(state, [
      { pid: 7003, ppid: 0, name: gameExe, path: path.join(gamePath.toUpperCase(), gameExe) },
    ]);
    await monitor.doCheck();
    expect(store.dispatch).toHaveBeenCalledWith(setToolStopped(gameExePath));
  },
);

it("replaces a reused PID with the current game process", async () => {
  const state = buildState({
    toolsRunning: { [makeExeId(gameExePath)]: { pid: 7004, started: 1, exclusive: true } },
  });
  const { monitor, store } = createMonitor(state, [
    { pid: 7004, ppid: 0, name: "Other.exe" },
    { pid: 7005, ppid: 0, name: gameExe, path: gameExePath },
  ]);
  await monitor.doCheck();
  expect(store.dispatch).toHaveBeenCalledWith(setToolPid(gameExePath, 7005, true));
});

it("dispatches setToolPid for matching child process", async () => {
  const tool = buildTool();
  const state = buildState({ tools: { [tool.id]: tool } });
  const processes: IProcessInfo[] = [
    {
      pid: 3001,
      ppid: process.pid,
      name: "Tool.exe",
      path: toolPath,
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenCalledWith(setToolPid(toolPath, 3001, false));
});

it("dispatches setToolStopped when no matching process exists", async () => {
  const tool = buildTool();
  const state = buildState({
    tools: { [tool.id]: tool },
    toolsRunning: {
      [makeExeId(toolPath)]: { pid: 4001, started: 1, exclusive: false },
    },
  });
  const { monitor, store } = createMonitor(state, []);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenCalledWith(setToolStopped(toolPath));
});

it("matches detached game but filters non-child tools", async () => {
  const tool = buildTool();
  const state = buildState({
    tools: { [tool.id]: tool },
    toolsRunning: {
      [makeExeId(toolPath)]: { pid: 5001, started: 1, exclusive: false },
    },
  });
  const processes: IProcessInfo[] = [
    {
      pid: 5001,
      ppid: 0,
      name: "Tool.exe",
      path: toolPath,
    },
    {
      pid: 6001,
      ppid: 0,
      name: "Game.exe",
      path: gameExePath,
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).toHaveBeenNthCalledWith(1, setToolPid(gameExePath, 6001, true));
  expect(store.dispatch).toHaveBeenNthCalledWith(2, setToolStopped(toolPath));
});

it("preserves command-path parsing outside Linux", () =>
  windowsContract(async () => {
    const spacedGamePath = "/games/test path";
    const spacedGameExe = "StardewValley";
    const spacedGameExePath = path.join(spacedGamePath, spacedGameExe);
    const state = buildState({
      gamePath: spacedGamePath,
      gameExe: spacedGameExe,
    });
    const processes: IProcessInfo[] = [
      {
        pid: 8001,
        ppid: 0,
        name: spacedGameExe,
        cmd: `${spacedGameExePath} --arg`,
      },
    ];
    const { monitor, store } = createMonitor(state, processes);

    await monitor.doCheck();

    expect(store.dispatch).toHaveBeenCalledWith(setToolPid(spacedGameExePath, 8001, true));
  }));

it("skips dispatch when known pid still exists", async () => {
  const state = buildState({
    tools: {},
    toolsRunning: {
      [makeExeId(gameExePath)]: {
        pid: 7001,
        started: 1,
        exclusive: true,
      },
    },
  });
  const processes: IProcessInfo[] = [
    {
      pid: 7001,
      ppid: 0,
      name: "Game.exe",
      path: gameExePath,
    },
  ];
  const { monitor, store } = createMonitor(state, processes);

  await monitor.doCheck();

  expect(store.dispatch).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== "linux")(
  "matches a Linux path despite a truncated process name",
  async () => {
    const executable = "VeryLongGameExecutableName";
    const state = buildState({ gameExe: executable });
    const { monitor, store } = createMonitor(state, [
      { pid: 9001, ppid: 0, name: executable.slice(0, 15), path: path.join(gamePath, executable) },
    ]);
    await monitor.doCheck();
    expect(store.dispatch).toHaveBeenCalledWith(
      setToolPid(path.join(gamePath, executable), 9001, true),
    );
  },
);

it.skipIf(process.platform !== "linux")(
  "tracks a script by its launch path instead of its interpreter name",
  async () => {
    const tool = buildTool({ path: "/tools/Sort Mods.py" });
    const { monitor, store } = createMonitor(buildState({ tools: { [tool.id]: tool } }), [
      { pid: 9002, ppid: process.pid, name: "python3", path: tool.path },
    ]);
    await monitor.doCheck();
    expect(store.dispatch).toHaveBeenCalledWith(setToolPid(tool.path, 9002, false));
  },
);

it.skipIf(process.platform !== "linux")(
  "detects a batch tool through cmd.exe, retains its PID and clears it when the command changes",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vortex-batch-monitor-"));
    try {
      const tools = path.join(root, "Tools '日本語'");
      const dosdevices = path.join(root, "pfx/dosdevices");
      const procRoot = path.join(root, "proc");
      const directory = path.join(procRoot, "9401");
      await Promise.all(
        [tools, dosdevices, directory].map((dir) => mkdir(dir, { recursive: true })),
      );
      const script = path.join(tools, "Sort Mods.cmd");
      const runtime = path.join(root, "wine64");
      await Promise.all([writeFile(script, "fixture"), writeFile(runtime, "fixture")]);
      await symlink(tools, path.join(dosdevices, "g:"));
      await symlink(runtime, path.join(directory, "exe"));
      const fields = ["S", String(process.pid), ...Array<string>(17).fill("0"), "12345"];
      await writeFile(path.join(directory, "stat"), `9401 (cmd.exe) ${fields.join(" ")}`);
      await writeFile(path.join(directory, "environ"), `WINEPREFIX=${path.join(root, "pfx")}\0`);
      const commandLine = path.join(directory, "cmdline");
      await writeFile(commandLine, "cmd.exe\0/c\0G:\\SORT MODS.CMD\0--mode\0sort\0");
      const tool = buildTool({ path: script });
      const state = buildState({ tools: { [tool.id]: tool } });
      const { monitor, store } = createMonitor(state, new LinuxProcessProvider(procRoot));
      await monitor.doCheck();
      expect(store.dispatch).toHaveBeenCalledExactlyOnceWith(setToolPid(script, 9401, false));

      state.session.base.toolsRunning[makeExeId(script)] = {
        pid: 9401,
        started: 1,
        exclusive: false,
      };
      store.dispatch.mockClear();
      await monitor.doCheck();
      expect(store.dispatch).not.toHaveBeenCalled();

      await writeFile(commandLine, "cmd.exe\0/c\0echo\0G:\\SORT MODS.CMD\0");
      await monitor.doCheck();
      expect(store.dispatch).toHaveBeenCalledExactlyOnceWith(setToolStopped(script));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "requires a Linux path before detecting a game",
  async () => {
    const { monitor, store } = createMonitor(buildState(), [{ pid: 9003, ppid: 0, name: gameExe }]);
    await monitor.doCheck();
    expect(store.dispatch).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== "linux")(
  "does not let an unrelated process name abort the poll",
  async () => {
    const { monitor, store } = createMonitor(buildState(), [
      { pid: 9301, ppid: 0, name: "constructor", path: "/usr/bin/constructor" },
      { pid: 9302, ppid: 0, name: gameExe, path: gameExePath },
    ]);
    await monitor.doCheck();
    expect(store.dispatch).toHaveBeenCalledWith(setToolPid(gameExePath, 9302, true));
  },
);

it.skipIf(process.platform !== "linux")(
  "revalidates a cached Linux PID when its path becomes unavailable",
  async () => {
    const state = buildState({
      toolsRunning: { [makeExeId(gameExePath)]: { pid: 9004, started: 1, exclusive: true } },
    });
    const { monitor, store } = createMonitor(state, [{ pid: 9004, ppid: 0, name: gameExe }]);
    await monitor.doCheck();
    expect(store.dispatch).toHaveBeenCalledWith(setToolStopped(gameExePath));
  },
);

it.skipIf(process.platform !== "linux")(
  "ignores a joined command line without an exact Linux launch path",
  async () => {
    const { monitor, store } = createMonitor(buildState(), [
      { pid: 9005, ppid: 0, name: gameExe, cmd: `${gameExePath} --data` },
    ]);
    await monitor.doCheck();
    expect(store.dispatch).not.toHaveBeenCalled();
  },
);

it("preserves the Windows basename fallback", () =>
  windowsContract(async () => {
    const { monitor, store } = createMonitor(buildState(), [{ pid: 9101, ppid: 0, name: gameExe }]);
    await monitor.doCheck();
    expect(store.dispatch).toHaveBeenCalledWith(setToolPid(gameExePath, 9101, true));
  }));

it("retains a known Windows PID without path information", () =>
  windowsContract(async () => {
    const state = buildState({
      toolsRunning: { [makeExeId(gameExePath)]: { pid: 9102, started: 1, exclusive: true } },
    });
    const { monitor, store } = createMonitor(state, [{ pid: 9102, ppid: 0, name: gameExe }]);
    await monitor.doCheck();
    expect(store.dispatch).not.toHaveBeenCalled();
  }));

it("preserves case-insensitive Windows path matching", () =>
  windowsContract(async () => {
    const { monitor, store } = createMonitor(buildState(), [
      { pid: 9103, ppid: 0, name: gameExe.toUpperCase(), path: gameExePath.toUpperCase() },
    ]);
    await monitor.doCheck();
    expect(store.dispatch).toHaveBeenCalledWith(setToolPid(gameExePath, 9103, true));
  }));

it.skipIf(!hasMatchingProcfs).each([
  { executable: "VeryLongGameExecutableName", remove: false },
  { executable: "VeryLongGameExecutableName", remove: true },
  { executable: "VeryLongGameExecutableName", remove: true, replace: true },
  { executable: "VeryLongGameExecutableName", remove: true, keepLink: true },
  { executable: "VeryLongGameExecutableName", remove: true, replace: true, keepLink: true },
  { executable: "VeryLongGameExecutableName (deleted)", remove: false },
])(
  "detects a real Linux process: $executable, unlinked=$remove, replaced=$replace, hardlink=$keepLink",
  async ({ executable, remove, replace, keepLink }) => {
    const root = await mkdtemp(path.join(tmpdir(), "vortex-process-monitor-"));
    const installation = path.join(root, "Steam Games '日本語'");
    const binary = path.join(root, executable);
    await copyFile("/bin/sleep", binary);
    if (keepLink) await link(binary, path.join(root, "staged-binary"));
    await symlink(root, installation);
    const child = spawn(path.join(installation, executable), ["30"]);
    try {
      await once(child, "spawn");
      if (remove) await rm(binary);
      if (replace) await copyFile("/bin/sleep", binary);
      const processes = await defaultProcessProvider.list();
      expect(processes.some((proc) => proc.pid === child.pid)).toBe(true);
      const { monitor, store } = createMonitor(
        buildState({ gamePath: installation, gameExe: executable }),
        processes,
      );
      await monitor.doCheck();
      expect(store.dispatch).toHaveBeenCalledWith(
        setToolPid(path.join(installation, executable), child.pid, true),
      );
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "resolves a symlinked installation after its running executable was removed",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vortex-unlinked-game-"));
    const alias = path.join(root, "Steam Games '日本語'");
    try {
      await symlink(root, alias);
      const { monitor, store } = createMonitor(buildState({ gamePath: alias }), [
        { pid: 9401, ppid: 0, name: gameExe, path: path.join(root, gameExe) },
      ]);
      await monitor.doCheck();
      expect(store.dispatch).toHaveBeenCalledWith(
        setToolPid(path.join(alias, gameExe), 9401, true),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
