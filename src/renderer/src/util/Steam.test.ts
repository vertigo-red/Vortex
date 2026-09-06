import * as nativeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import PromiseBB from "bluebird";
import { stringify } from "simple-vdf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("winapi-bindings", () => ({ RegGetValue: () => ({ value: fixture.root }) }));
vi.mock("./linux/steamPaths", () => ({ findLinuxSteamPath: () => fixture.root }));
vi.mock("./linux/proton", () => ({ getProtonInfo: async () => ({ usesProton: false }) }));
vi.mock("./fs", () => ({
  readFileAsync: (...args: Parameters<typeof nativeFs.readFile>) =>
    PromiseBB.resolve(nativeFs.readFile(...args)),
}));
vi.mock("./log", () => ({ log: vi.fn() }));

import { Steam } from "./Steam";

async function manifest(library: string, id: string, name = `Game ${id}`) {
  const apps = path.join(library, "steamapps");
  await nativeFs.mkdir(apps, { recursive: true });
  await nativeFs.writeFile(
    path.join(apps, `appmanifest_${id}.acf`),
    stringify({ AppState: { appid: id, name, installdir: name } }),
  );
}

beforeEach(async () => {
  fixture.root = await nativeFs.mkdtemp(path.join(os.tmpdir(), "vortex-steam-"));
});
afterEach(async () => {
  await nativeFs.rm(fixture.root, { recursive: true, force: true });
});

describe("Steam library discovery and launch", () => {
  it("keeps the primary library when libraryfolders.vdf is missing", async () => {
    await manifest(fixture.root, "10");
    expect((await new Steam().allGames()).map((g) => g.appid)).toEqual(["10"]);
  });

  it("reads non-contiguous modern and legacy library entries", async () => {
    const modern = path.join(fixture.root, "second");
    const legacy = path.join(fixture.root, "third");
    await manifest(fixture.root, "10");
    await manifest(modern, "20");
    await manifest(legacy, "30");
    await nativeFs.writeFile(
      path.join(fixture.root, "steamapps", "libraryfolders.vdf"),
      stringify({
        libraryfolders: { "0": { path: fixture.root }, "2": { path: modern }, "5": legacy },
      }),
    );
    expect((await new Steam().allGames()).map((g) => g.appid).sort()).toEqual(["10", "20", "30"]);
  });

  it("isolates an unreadable manifest instead of discarding its library", async () => {
    await manifest(fixture.root, "10");
    await nativeFs.mkdir(path.join(fixture.root, "steamapps", "appmanifest_20.acf"));
    expect((await new Steam().allGames()).map((g) => g.appid)).toEqual(["10"]);
  });

  it("launches the matched AppID when given an executable directory", async () => {
    await manifest(fixture.root, "10");
    const store = new Steam();
    const gamePath = path.join(fixture.root, "steamapps", "common", "Game 10");
    expect((await store.getExecInfo(path.join(gamePath, "bin"))).arguments).toEqual([
      "-applaunch",
      "10",
    ]);
    await expect(store.getExecInfo(`${gamePath} Remastered`)).rejects.toThrow();
  });

  it("preserves explicit launch parameters", async () => {
    await manifest(fixture.root, "10");
    expect(
      (await new Steam().getExecInfo({ appId: "10", parameters: ["-windowed"] })).arguments,
    ).toEqual(["-applaunch", "10", "-windowed"]);
  });
});
