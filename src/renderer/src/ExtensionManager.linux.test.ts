import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import PromiseBB from "bluebird";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ExtensionManager from "./ExtensionManager";
import { toEditStarter, toToolDiscovery } from "./extensions/starter_dashlet/util";
import { makeTempDir } from "./test-utils/tempDir";
import type { IRunOptions, ThunkStore } from "./types/IExtensionContext";
import type { IState } from "./types/IState";
import { quoteArgument } from "./util/linux/commandLine";
import StarterInfo from "./util/StarterInfo";
import { Steam } from "./util/Steam";

vi.mock("./StyleManager", () => ({ default: class {} }));
vi.mock("./IPCDownloadAdapter", () => ({ IPCDownloadAdapter: class {} }));
vi.mock("./extensions/analytics/utils/modListSnapshot", () => ({ emitModListSnapshot: vi.fn() }));
vi.mock("./util/gameLaunchAnalytics", () => ({
  emitGameLaunched: vi.fn(),
  recordLaunchExit: vi.fn(),
}));

describe.skipIf(process.platform !== "linux")("Linux extension tool execution", () => {
  let manager: ExtensionManager;
  let root: string;
  let script: string;
  let output: string;

  beforeEach(async () => {
    vi.spyOn(
      ExtensionManager.prototype as unknown as { prepareExtensions: () => [] },
      "prepareExtensions",
    ).mockReturnValue([]);
    manager = new ExtensionManager();
    manager.getApi().store = {
      getState: () => ({ settings: { profiles: {} }, persistent: { profiles: {} } }),
    } as unknown as ThunkStore<IState>;
    root = await makeTempDir("vortex-tool-launch-");
    script = path.join(root, "capture.cjs");
    output = path.join(root, "arguments.json");
    await writeFile(
      script,
      `require("node:fs").writeFileSync(process.argv[2], JSON.stringify({
        args: process.argv.slice(3), cwd: process.cwd(),
        marker: process.env.VORTEX_TOOL_TEST, path: process.env.PATH
      }));`,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  const run = (args: string[], options: IRunOptions = {}) =>
    manager.getApi().runExecutable(process.execPath, [script, output, ...args], {
      cwd: root,
      detach: false,
      expectSuccess: true,
      ...options,
    });

  it("passes native arguments literally, including quotes, empty strings and shell characters", async () => {
    const args = [
      "two words",
      '"quoted value"',
      '{"name":"Mod Manager"}',
      'print("hello")',
      "",
      "$HOME; $(touch never-created) `echo ignored` *.esp",
      "C:\\Games\\Tool",
      "Путь к моду",
    ];
    await run(args);
    expect(JSON.parse(await readFile(output, "utf8")).args).toEqual(args);
  });

  it("uses the working directory and environment returned by a start hook", async () => {
    manager["mStartHooks"] = [
      {
        priority: 100,
        id: "native-wrapper",
        hook: (call) =>
          PromiseBB.resolve({
            ...call,
            options: {
              ...call.options,
              cwd: path.dirname(root),
              env: { VORTEX_TOOL_TEST: "hook" },
            },
          }),
      },
    ];
    await run([], { env: { VORTEX_TOOL_TEST: "original" } });
    const captured = JSON.parse(await readFile(output, "utf8"));
    expect(captured.cwd).toBe(path.dirname(root));
    expect(captured.marker).toBe("hook");
  });

  it("defaults to the directory of the executable selected by a hook", async () => {
    const executable = path.join(root, "replacement.sh");
    await writeFile(executable, '#!/bin/sh\nexec "$VORTEX_TOOL_NODE" "$@"\n');
    await chmod(executable, 0o755);
    manager["mStartHooks"] = [
      {
        priority: 100,
        id: "native-wrapper",
        hook: (call) =>
          PromiseBB.resolve({
            ...call,
            executable,
            options: {
              detach: false,
              expectSuccess: true,
              env: { VORTEX_TOOL_NODE: process.execPath },
            },
          }),
      },
    ];
    await manager.getApi().runExecutable(process.execPath, [script, output], {});
    expect(JSON.parse(await readFile(output, "utf8")).cwd).toBe(root);
  });

  it("preserves substituted quotes and supplies the hook environment to tool-variable callbacks", async () => {
    manager["mStartHooks"] = [
      {
        priority: 100,
        id: "native-environment",
        hook: (call) =>
          PromiseBB.resolve({
            ...call,
            options: { ...call.options, env: { VORTEX_TOOL_TEST: '"hook value"' } },
          }),
      },
    ];
    manager["mToolParameterCBs"] = [(call) => ({ marker: call.options.env.VORTEX_TOOL_TEST })];
    await run(["{marker}"]);
    expect(JSON.parse(await readFile(output, "utf8")).args).toEqual(['"hook value"']);
  });

  it.each([false, true])(
    "passes saved dashboard arguments through Proton to a real wrapper process (shell: %s)",
    async (shell) => {
      vi.spyOn(StarterInfo, "getIconPath").mockReturnValue("icon.png");
      const parameters = ['{"name":"Mod Manager"}', '"literal"', "two words", "", "$HOME"];
      const game = { id: "game", name: "Game", executable: "Game.exe", requiredFiles: [] };
      const discovery = { path: root };
      const starter = new StarterInfo(game, discovery, undefined, {
        id: "tool",
        name: "Tool",
        path: path.join(root, 'Tool "Folder"', "Tool.exe"),
        executable: null,
        requiredFiles: [],
        hidden: false,
        custom: true,
        parameters: shell ? parameters.map(quoteArgument) : parameters,
        parametersLiteral: !shell,
        shell,
      });
      const savedStarter = new StarterInfo(
        game,
        discovery,
        undefined,
        toToolDiscovery(toEditStarter(starter)),
      );
      const protonPath = path.join(root, "Proton Test");
      await mkdir(protonPath);
      const executable = path.join(protonPath, "proton");
      await writeFile(
        executable,
        '#!/bin/sh\nexec "$VORTEX_TOOL_NODE" "$VORTEX_TOOL_CAPTURE" "$VORTEX_TOOL_OUTPUT" "$@"\n',
      );
      await chmod(executable, 0o755);
      const steam = new Steam();
      steam["mBaseFolder"] = PromiseBB.resolve(root);
      await steam.runToolWithProton(
        manager.getApi(),
        savedStarter.exePath,
        savedStarter.commandLine,
        {
          shell,
          detach: false,
          expectSuccess: true,
          env: {
            VORTEX_TOOL_NODE: process.execPath,
            VORTEX_TOOL_CAPTURE: script,
            VORTEX_TOOL_OUTPUT: output,
          },
        },
        {
          appid: "42",
          name: "Game",
          gameStoreId: "steam",
          gamePath: root,
          usesProton: true,
          protonPath,
          compatDataPath: path.join(root, "compatdata", "42"),
        },
      );
      expect(JSON.parse(await readFile(output, "utf8")).args).toEqual([
        "run",
        savedStarter.exePath,
        ...parameters,
      ]);
    },
  );

  it.each([false, true])(
    "runs a shebang script from a literal special-character path (shell: %s)",
    async (shell) => {
      const executable = path.join(
        root,
        "tool $VORTEX_TOOL_TEST \"quotes\" 'single' `backticks`.sh",
      );
      await writeFile(
        executable,
        '#!/bin/sh\nexec "$VORTEX_TOOL_NODE" "$VORTEX_TOOL_CAPTURE" "$VORTEX_TOOL_OUTPUT" "$@"\n',
      );
      await chmod(executable, 0o755);
      const args = ['{"label":"two words"}', "", "$HOME; $(echo unexpected)"];
      const options: IRunOptions = {
        detach: false,
        expectSuccess: true,
        env: {
          VORTEX_TOOL_NODE: process.execPath,
          VORTEX_TOOL_CAPTURE: script,
          VORTEX_TOOL_OUTPUT: output,
          VORTEX_TOOL_TEST: "expanded",
        },
        ...(shell ? { shell: true } : {}),
      };
      await manager
        .getApi()
        .runExecutable(executable, shell ? args.map(quoteArgument) : args, options);
      expect(JSON.parse(await readFile(output, "utf8")).args).toEqual(args);
      expect(options.shell).toBe(shell ? true : undefined);
    },
  );

  it("reports a real PID before the exit notification", async () => {
    const events: Array<{ type: string; value: number }> = [];
    await run([], {
      onSpawned: (pid) => events.push({ type: "spawn", value: pid }),
      onExit: (code) => events.push({ type: "exit", value: code }),
    });
    expect(events).toEqual([
      { type: "spawn", value: expect.any(Number) },
      { type: "exit", value: 0 },
    ]);
    expect(events[0].value).toBeGreaterThan(0);
  });

  it.each(["missing", "not-executable"])(
    "does not announce a %s executable as spawned",
    async (kind) => {
      const executable = path.join(root, "native-tool");
      if (kind === "not-executable") {
        await writeFile(executable, "#!/bin/sh\nexit 0\n");
        await chmod(executable, 0o644);
      }
      const onSpawned = vi.fn();
      const onExit = vi.fn();
      await expect(
        manager.getApi().runExecutable(executable, [], {
          detach: false,
          onSpawned,
          onExit,
        }),
      ).rejects.toMatchObject({ code: kind === "missing" ? "ENOENT" : "EACCES" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(onSpawned).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();
    },
  );
});
