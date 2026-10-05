import { util } from "@nexusmods/vortex-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

import init from "./index";
import * as qbms from "./quickbms";

vi.mock("./quickbms", () => ({
  list: vi.fn(),
  extract: vi.fn(),
  write: vi.fn(),
  reImport: vi.fn(),
}));
const methods = new Map<string, (...args: any[]) => any>();
const api = {
  store: {
    getState: () => ({
      persistent: { mods: {} },
      session: {
        gameMode: {
          known: [{ id: "requested", contributed: "contributor" }],
          activeGameId: "other",
        },
      },
    }),
  },
  showErrorNotification: vi.fn(),
  sendNotification: vi.fn(),
};
const context = {
  api,
  registerAPI: (name, method) => methods.set(name, method),
  once: () => {},
} as any;
const props = {
  gameMode: "requested",
  bmsScriptPath: "/script.bms",
  archivePath: "/archive.bin",
  operationPath: "/output",
};
beforeEach(() => {
  vi.clearAllMocks();
  methods.clear();
  (util.getVortexPath as any).mockReturnValue("/missing-qbms-user-data");
  init(context);
});

describe("QuickBMS public API", () => {
  it("returns list entries when no callback is supplied", async () => {
    const entries = [{ offset: "8", size: "4", filePath: "file.txt" }];
    vi.mocked(qbms.list).mockResolvedValue(entries);
    expect(await methods.get("qbmsList")(props)).toBe(entries);
    expect(qbms.list).toHaveBeenCalledWith(api, expect.objectContaining({ gameMode: "requested" }));
  });
  it("rejects failures to promise callers and uses the requested game for reporting", async () => {
    const error = new Error("tool failed");
    vi.mocked(qbms.extract).mockRejectedValue(error);
    await expect(methods.get("qbmsExtract")(props)).rejects.toBe(error);
    expect(api.showErrorNotification).toHaveBeenCalledWith(
      expect.any(String),
      error,
      expect.objectContaining({ allowReport: true }),
    );
  });
  it("delivers callback failures once even when another game is active", async () => {
    const error = new Error("tool failed");
    vi.mocked(qbms.write).mockRejectedValue(error);
    const callback = vi.fn();
    await methods.get("qbmsWrite")({ ...props, quiet: true, callback });
    expect(callback).toHaveBeenCalledExactlyOnceWith(error, undefined);
    expect(api.showErrorNotification).not.toHaveBeenCalled();
  });
  it("does not mutate caller-owned options while defaulting reimport mode", async () => {
    vi.mocked(qbms.reImport).mockResolvedValue(undefined);
    const options = { overwrite: true };
    await methods.get("qbmsReimport")({ ...props, qbmsOptions: options });
    expect(options).toEqual({ overwrite: true });
    expect(qbms.reImport).toHaveBeenCalledWith(
      api,
      expect.objectContaining({ qbmsOptions: { overwrite: true, allowResize: false } }),
    );
  });
});
