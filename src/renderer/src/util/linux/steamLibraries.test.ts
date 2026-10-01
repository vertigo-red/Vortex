import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSteamLibraries, readSteamLibraries } from "./steamLibraries";

const base = path.resolve("Steam");
const alternate = path.resolve("Steam Games");
const third = path.resolve("Other Library");
const folders = (lines: string[]) => ['"LibraryFolders"', "{", ...lines, "}"].join("\n");
let temporary: string | undefined;
afterEach(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe("Steam library discovery", () => {
  it("reads sparse and legacy indices, ignores metadata, and deduplicates paths", () => {
    const contents = folders([
      `"0" ${JSON.stringify(base)}`,
      '"2"',
      "{",
      `"path" ${JSON.stringify(alternate)}`,
      "}",
      `"8" ${JSON.stringify(third)}`,
      `"9" ${JSON.stringify(alternate)}`,
      '"TimeNextStatsReport" "1234"',
      '"10" "relative/path"',
    ]);
    expect(parseSteamLibraries(contents, base)).toEqual([base, alternate, third]);
  });
  it("accepts malformed blocks without interpreting them as filesystem paths", () => {
    expect(
      parseSteamLibraries(folders(['"2"', "{", '"path"', "{", '"x" "y"', "}", "}"]), base),
    ).toEqual([base]);
  });
  it("prefers steamapps/libraryfolders.vdf to the legacy config copy", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "vortex-steam-"));
    for (const directory of ["steamapps", "config"]) await mkdir(path.join(temporary, directory));
    await writeFile(
      path.join(temporary, "steamapps", "libraryfolders.vdf"),
      folders([`"4" ${JSON.stringify(alternate)}`]),
    );
    await writeFile(
      path.join(temporary, "config", "libraryfolders.vdf"),
      folders([`"1" ${JSON.stringify(third)}`]),
    );
    expect(await readSteamLibraries(temporary)).toEqual([temporary, alternate]);
  });
  it("falls back to the legacy file when the current file is missing", async () => {
    temporary = await mkdtemp(path.join(tmpdir(), "vortex-steam-"));
    await mkdir(path.join(temporary, "config"));
    await writeFile(
      path.join(temporary, "config", "libraryfolders.vdf"),
      folders([`"1" ${JSON.stringify(third)}`]),
    );
    expect(await readSteamLibraries(temporary)).toEqual([temporary, third]);
  });
});
