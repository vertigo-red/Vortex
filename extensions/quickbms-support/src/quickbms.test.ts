import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { util } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extract, list, parseQBMSList, reImport, write } from "./quickbms";
import { IQBMSOpProps } from "./types";

const helpers = util as any;
let root: string;
let props: IQBMSOpProps;
const discovery = { path: "/Secondary Library/Game 日本語", store: "steam" };
const api = {
  store: {
    getState: () => ({
      settings: {
        gameMode: { discovered: { requested: discovery, active: { path: "/Wrong game" } } },
      },
    }),
  },
} as any;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "vortex-qbms-test-"));
  props = {
    gameMode: "requested",
    bmsScriptPath: path.join(root, "script with space.BMS"),
    archivePath: path.join(root, "archive & ;.bin"),
    operationPath: root,
    qbmsOptions: {},
  };
  helpers.getVortexPath.mockReturnValue(root);
  helpers.getProtonToolCommand.mockImplementation(async (_exe, args, selected) => {
    if (!selected) throw new Error("No discovered game");
    return {
      executable: "/Selected Proton/proton",
      args: args.map((arg) => (typeof arg === "string" ? arg : arg.path)),
      env: { SELECTED_PREFIX: "yes" },
    };
  });
  helpers.executeToolProcess.mockResolvedValue({
    stdout: " 00000008 4 file with spaces.txt\n",
    stderr: "",
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function expectWorkspaceClean() {
  expect(await readdir(path.join(root, "temp", "archive-tools"))).toEqual([]);
}

describe("QuickBMS list parser", () => {
  const lines =
    " 00000008 4 folder\\a b.txt\n0000000c 8 folder\\c.txt\n00000014 1 literal[1].bin\n - filter: *.txt\n";
  it("preserves spaces and every matching entry", () => {
    expect(parseQBMSList(lines, ["{}/*.txt"]).map((entry) => entry.filePath)).toEqual([
      "folder/a b.txt",
      "folder/c.txt",
    ]);
  });
  it("escapes regular-expression characters in literal filters", () => {
    expect(parseQBMSList(lines, ["literal[1].bin"])).toEqual([
      { offset: "00000014", size: "1", filePath: "literal[1].bin" },
    ]);
  });
  it("matches case-insensitively unless requested otherwise", () => {
    expect(parseQBMSList(lines, ["FOLDER/*"]).length).toBe(2);
    expect(parseQBMSList(lines, ["FOLDER/*"], true)).toEqual([]);
  });
  it("accepts missing wildcards without dropping entries", () => {
    expect(parseQBMSList(lines)).toHaveLength(3);
    expect(parseQBMSList(lines, [])).toEqual([]);
  });
});

describe("QuickBMS Linux invocation", () => {
  it("returns its own process output using the requested game's prefix", async () => {
    expect(await list(api, props)).toEqual([
      { offset: "00000008", size: "4", filePath: "file with spaces.txt" },
    ]);
    expect(helpers.getProtonToolCommand.mock.calls[0][2]).toBe(discovery);
    expect(helpers.executeToolProcess.mock.calls[0][2].env.SELECTED_PREFIX).toBe("yes");
    await expectWorkspaceClean();
  });
  it("passes each reimport2 switch as a separate literal argument", async () => {
    props.qbmsOptions = { allowResize: true, overwrite: true };
    await reImport(api, props);
    const args = helpers.executeToolProcess.mock.calls[0][1];
    expect(args.slice(1, 5)).toEqual(["-w", "-r", "-r", "-o"]);
    expect(args.slice(-3)).toEqual([props.bmsScriptPath, props.archivePath, props.operationPath]);
    await expectWorkspaceClean();
  });
  it("does not apply reimport switches to list or extraction", async () => {
    props.qbmsOptions = { allowResize: true };
    await extract(api, props);
    expect(helpers.executeToolProcess.mock.calls[0][1]).not.toContain("-r");
    await expectWorkspaceClean();
  });
  it("uses independent filter files for concurrent operations", async () => {
    const filters: string[] = [];
    helpers.executeToolProcess.mockImplementation(async (_exe, args) => {
      const filename = args[args.indexOf("-f") + 1];
      filters.push(filename);
      const contents = await readFile(filename, "utf8");
      return { stdout: `00000008 4 ${contents}\n`, stderr: "" };
    });
    const results = await Promise.all(
      ["one.txt", "two.txt"].map((filter) =>
        list(api, { ...props, qbmsOptions: { wildCards: [filter] } }),
      ),
    );
    expect(new Set(filters).size).toBe(2);
    expect(results.map((entries) => entries[0].filePath)).toEqual(["one.txt", "two.txt"]);
    await expectWorkspaceClean();
  });
  it("removes filters and rejects nonzero process exit", async () => {
    props.qbmsOptions = { wildCards: ["*.txt"] };
    helpers.executeToolProcess.mockRejectedValue({ code: 8, stderr: "Error: syntax", stdout: "" });
    await expect(list(api, props)).rejects.toThrow("BMS script syntax error");
    await expectWorkspaceClean();
  });
  it("rejects status-zero reported errors and timeouts", async () => {
    helpers.executeToolProcess.mockResolvedValue({ stdout: "", stderr: "Error: invalid archive" });
    await expect(extract(api, props)).rejects.toThrow("reported an error");
    helpers.executeToolProcess.mockRejectedValue({ code: "ETIMEDOUT", stderr: "", stdout: "" });
    await expect(write(api, props)).rejects.toThrow("timed out");
    await expectWorkspaceClean();
  });
  it("rejects missing game discovery without launching a host fallback", async () => {
    props.gameMode = "missing";
    await expect(extract(api, props)).rejects.toThrow("No discovered game");
    expect(helpers.executeToolProcess).not.toHaveBeenCalled();
    await expectWorkspaceClean();
  });
  it("rejects relative script paths and missing reimport mode", async () => {
    await expect(reImport(api, props)).rejects.toThrow("Re-import version");
    props.bmsScriptPath = "relative.bms";
    await expect(list(api, props)).rejects.toThrow("bmsScriptPath");
    expect(helpers.executeToolProcess).not.toHaveBeenCalled();
  });
});
