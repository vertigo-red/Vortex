import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IDiscoveredTool } from "../../types/IDiscoveredTool";
import StarterInfo from "../../util/StarterInfo";
import type { IDiscoveryResult } from "../gamemode_management/types/IDiscoveryResult";
import type { IGameStored } from "../gamemode_management/types/IGameStored";
import { splitCommandLine, toEditStarter, toToolDiscovery } from "./util";

vi.mock("../../util/exeIcon", () => ({ default: vi.fn() }));
vi.mock("../analytics/utils/modListSnapshot", () => ({ emitModListSnapshot: vi.fn() }));
vi.mock("../../util/gameLaunchAnalytics", () => ({
  emitGameLaunched: vi.fn(),
  recordLaunchExit: vi.fn(),
}));

const game: IGameStored = {
  id: "game",
  name: "Game",
  executable: "Game.exe",
  requiredFiles: [],
};
const discovery: IDiscoveryResult = { path: path.resolve("game") };
const tool: IDiscoveredTool = {
  id: "native-tool",
  name: "Native tool",
  path: path.resolve("native-tool"),
  executable: null,
  requiredFiles: [],
  hidden: false,
  custom: true,
};

describe.skipIf(process.platform !== "linux")("Linux dashboard command lines", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["  alpha\t beta   gamma\n", ["alpha", "beta", "gamma"]],
    ["--name=\"two words\" 'single quoted'", ["--name=two words", "single quoted"]],
    ["\"\" '' next", ["", "", "next"]],
    ['one\\ word "say \\"hello\\""', ["one word", 'say "hello"']],
    ["'don'\"'\"'t'", ["don't"]],
    ["'$HOME; $(echo literal) *.esp'", ["$HOME; $(echo literal) *.esp"]],
    ["\"C:\\Games\\Tool\" 'C:\\Other\\Tool'", ["C:\\Games\\Tool", "C:\\Other\\Tool"]],
    ["one\\\ntwo", ["onetwo"]],
    ["\\\n \t", []],
    ['"unfinished argument', ["unfinished argument"]],
  ])("parses %s without shell expansion", (input, expected) => {
    expect(splitCommandLine(input)).toEqual(expected);
  });

  it("retains shell syntax when shell mode is explicitly selected", () => {
    expect(splitCommandLine('"$HOME/two words" > \'out file\' && echo "$USER"', true)).toEqual([
      '"$HOME/two words"',
      ">",
      "'out file'",
      "&&",
      "echo",
      '"$USER"',
    ]);
  });

  it("preserves literal arguments through editing, saving and reconstructing a starter", () => {
    vi.spyOn(StarterInfo, "getIconPath").mockReturnValue("icon.png");
    const parameters = [
      "two words",
      '"quoted"',
      '{"name":"Mod Manager"}',
      "",
      "don't",
      "$HOME",
      "C:\\Games\\Tool",
    ];
    let starter = new StarterInfo(game, discovery, undefined, {
      ...tool,
      parameters,
      parametersLiteral: true,
    });
    for (let iteration = 0; iteration < 2; ++iteration) {
      const saved = toToolDiscovery(toEditStarter(starter));
      expect(saved.parametersLiteral).toBe(true);
      expect(saved.parameters).toEqual(parameters);
      starter = new StarterInfo(game, discovery, undefined, saved);
      expect(starter.commandLine).toEqual(parameters);
    }
  });

  it("reads legacy quoted tool settings without passing grouping quotes to the process", () => {
    const starter = new StarterInfo(game, discovery, undefined, {
      ...tool,
      parameters: ['"two words"', 'RedirectFiles="C:\\My Mods"'],
    });
    expect(starter.commandLine).toEqual(["two words", "RedirectFiles=C:\\My Mods"]);
  });

  it.each([false, true])("preserves game arguments from new settings (literal: %s)", (literal) => {
    const parameters = literal ? ["two words", '"literal"', ""] : ['"two words"'];
    const starter = new StarterInfo(game, { ...discovery, parameters, parametersLiteral: literal });
    expect(starter.commandLine).toEqual(literal ? parameters : ["two words"]);
  });

  it("preserves raw arguments supplied by a game extension", () => {
    const parameters = ['{"name":"Mod Manager"}', "two words", ""];
    const starter = new StarterInfo({ ...game, parameters }, discovery);
    expect(starter.commandLine).toEqual(parameters);
  });

  it("preserves raw arguments supplied by a tool extension", () => {
    const parameters = ['{"name":"Mod Manager"}', "two words", ""];
    const starter = new StarterInfo(
      game,
      discovery,
      {
        ...tool,
        executable: "native-tool",
        logo: "tool.png",
        environment: {},
        parameters,
      },
      { ...tool, custom: false },
    );
    expect(starter.commandLine).toEqual(parameters);
  });

  it("preserves a shell command through editing and saving", () => {
    vi.spyOn(StarterInfo, "getIconPath").mockReturnValue("icon.png");
    const parameters = ['"$HOME/two words"', ">", "'output file'"];
    const starter = new StarterInfo(game, discovery, undefined, {
      ...tool,
      parameters,
      shell: true,
    });
    const saved = toToolDiscovery(toEditStarter(starter));
    expect(saved.parameters).toEqual(parameters);
    expect(saved.shell).toBe(true);
    expect(saved.parametersLiteral).toBe(false);
    expect(new StarterInfo(game, discovery, undefined, saved).commandLine).toEqual(parameters);
  });

  it("allows game settings to disable an extension's shell default", () => {
    const starter = new StarterInfo(
      { ...game, shell: true },
      {
        ...discovery,
        shell: false,
        parameters: ['"literal"'],
        parametersLiteral: true,
      },
    );
    expect(starter.shell).toBe(false);
    expect(starter.commandLine).toEqual(['"literal"']);
  });
});
