import { describe, it, expect, vi, beforeEach } from "vitest";

import type { IState } from "../../types/IState";
import type { IDownload } from "./types/IDownload";

vi.mock("../../util/log", () => ({ log: vi.fn() }));
vi.mock("../profile_management/selectors", () => ({ activeGameId: vi.fn() }));
vi.mock("./util/getDownloadPath", () => ({ default: vi.fn() }));

import { activeGameId } from "../profile_management/selectors";
import getDownloadPath from "./util/getDownloadPath";
import {
  activeDownloads,
  downloadPath,
  downloadPathForGame,
  downloadsForActiveGame,
  downloadsForGame,
  getDownloadByIds,
  queueClearingDownloads,
} from "./selectors";

const mockActiveGameId = vi.mocked(activeGameId);
const mockGetDownloadPath = vi.mocked(getDownloadPath);

type FileLike = Partial<IDownload>;

function file(game: string[], state: IDownload["state"], modInfo?: unknown): FileLike {
  return { game, state, modInfo } as unknown as IDownload;
}

function makeState(files: Record<string, FileLike>): IState {
  return {
    settings: { downloads: { path: "/dl" } },
    persistent: { downloads: { files: files as Record<string, IDownload> } },
  } as unknown as IState;
}

const downloads = {
  fin1: file(["skyrim"], "finished"),
  fin2: file(["fallout4", "skyrim"], "finished"),
  fin3: file(["fallout4"], "finished"),
  running: file(["skyrim"], "started"),
  finalizing: file(["skyrim"], "finalizing"),
  paused: file(["skyrim"], "paused"),
  queued: file(["skyrim"], "init"),
  installing: file(["skyrim"], "started"),
};

describe("downloadsForGame", () => {
  it("returns the finished downloads for a game", () => {
    const state = makeState(downloads);
    const result = downloadsForGame(state, "skyrim");
    expect(Object.keys(result)).toEqual(["fin1", "fin2"]);
  });

  it("returns only finished downloads, not queued or running ones", () => {
    const state = makeState(downloads);
    const result = downloadsForGame(state, "skyrim");
    expect(result.fin1?.state).toBe("finished");
    expect(result.running).toBeUndefined();
    expect(result.queued).toBeUndefined();
  });

  it("returns an empty map for a game without finished downloads", () => {
    const state = makeState(downloads);
    expect(downloadsForGame(state, "unknown")).toEqual({});
  });
});

describe("activeDownloads", () => {
  it("returns downloads in active states", () => {
    const state = makeState(downloads);
    const result = activeDownloads(state);
    expect(Object.keys(result).sort()).toEqual(["finalizing", "installing", "running"]);
  });

  it("excludes finished, paused and queued downloads", () => {
    const state = makeState(downloads);
    const result = activeDownloads(state);
    expect(result.fin1).toBeUndefined();
    expect(result.paused).toBeUndefined();
    expect(result.queued).toBeUndefined();
  });
});

describe("queueClearingDownloads", () => {
  it("returns downloads that would be lost when clearing the queue", () => {
    const state = makeState(downloads);
    const result = queueClearingDownloads(state);
    expect(result.running?.state).toBe("started");
    expect(result.paused?.state).toBe("paused");
    expect(result.queued?.state).toBe("init");
  });

  it("excludes finished and finalizing downloads", () => {
    const state = makeState(downloads);
    const result = queueClearingDownloads(state);
    expect(result.fin1).toBeUndefined();
    expect(result.finalizing).toBeUndefined();
  });
});

describe("downloadsForActiveGame", () => {
  it("delegates to the active game id", () => {
    mockActiveGameId.mockReturnValue("fallout4");
    const state = makeState(downloads);

    const selector = downloadsForActiveGame(state);
    expect(Object.keys(selector(state))).toEqual(["fin2", "fin3"]);
  });
});

describe("getDownloadByIds", () => {
  it("finds a download by file and mod id", () => {
    const state = makeState({
      matched: file(["skyrim"], "finished", {
        nexus: { ids: { fileId: 7, modId: 42 } },
      }),
      other: file(["skyrim"], "finished", { nexus: { ids: { fileId: 8, modId: 42 } } }),
    });

    const result = getDownloadByIds(state, { fileId: 7, modId: 42, gameId: "skyrim" });
    expect(result?.game).toEqual(["skyrim"]);
  });

  it("returns undefined when no download matches", () => {
    const state = makeState({
      other: file(["skyrim"], "finished", { nexus: { ids: { fileId: 8, modId: 42 } } }),
    });

    expect(getDownloadByIds(state, { fileId: 7, modId: 42, gameId: "skyrim" })).toBeUndefined();
  });

  it("returns undefined when the download belongs to a different game", () => {
    const state = makeState({
      other: file(["fallout4"], "finished", { nexus: { ids: { fileId: 7, modId: 42 } } }),
    });

    expect(getDownloadByIds(state, { fileId: 7, modId: 42, gameId: "skyrim" })).toBeUndefined();
  });
});

describe("downloadPath", () => {
  beforeEach(() => {
    mockActiveGameId.mockReturnValue("skyrim");
    mockGetDownloadPath.mockReturnValue("/mocked/downloads");
  });

  it("routes the download path through getDownloadPath for the active game", () => {
    const state = makeState(downloads);
    expect(downloadPath(state)).toBe("/mocked/downloads");
    expect(mockGetDownloadPath).toHaveBeenCalledWith("/dl", "skyrim");
  });

  it("uses the explicit game for downloadPathForGame", () => {
    const state = makeState(downloads);
    expect(downloadPathForGame(state, "fallout4")).toBe("/mocked/downloads");
    expect(mockGetDownloadPath).toHaveBeenCalledWith("/dl", "fallout4");
  });

  it("falls back to the active game for downloadPathForGame", () => {
    const state = makeState(downloads);
    expect(downloadPathForGame(state)).toBe("/mocked/downloads");
    expect(mockGetDownloadPath).toHaveBeenCalledWith("/dl", "skyrim");
  });
});