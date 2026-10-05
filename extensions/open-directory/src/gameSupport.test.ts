import * as path from "node:path";

import { fs, util } from "@nexusmods/vortex-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appDataPath,
  hasAppDataPath,
  hasSettingsPath,
  initGameSupport,
  settingsPath,
} from "./gameSupport";
import init from "./index";

let state: any;
let api: any;
beforeEach(() => {
  vi.clearAllMocks();
  state = {
    settings: {
      gameMode: { discovered: { skyrimse: { path: "/Secondary Steam/Game", store: "steam" } } },
      profiles: { activeGameId: "skyrimse" },
    },
  };
  api = { store: { getState: () => state }, getState: () => state, showErrorNotification: vi.fn() };
  initGameSupport(api);
  vi.mocked(util.getGameUserPath).mockImplementation((id) => `/prefix/redirected/${id}`);
});
afterEach(() => vi.restoreAllMocks());
const game = { id: "skyrimse" } as any;

describe.skipIf(process.platform !== "linux")("game folder actions", () => {
  it("opens Documents and Local AppData from the discovered game's prefix", () => {
    expect(settingsPath(game)).toBe("/prefix/redirected/documents/My Games/Skyrim Special Edition");
    expect(appDataPath(game)).toBe("/prefix/redirected/localAppData/Skyrim Special Edition");
    expect(util.getGameUserPath).toHaveBeenCalledWith(
      "documents",
      {
        path: "/Secondary Steam/Game",
        store: "steam",
      },
      true,
    );
    expect(util.getGameUserPath).toHaveBeenCalledWith(
      "localAppData",
      {
        path: "/Secondary Steam/Game",
        store: "steam",
      },
      true,
    );
    expect(util.getVortexPath).not.toHaveBeenCalled();
  });

  it("rereads discovery and folder redirections instead of caching them", () => {
    settingsPath(game);
    state.settings.gameMode.discovered.skyrimse.path = "/Another library/Game";
    vi.mocked(util.getGameUserPath).mockReturnValue("/new/redirect");
    expect(settingsPath(game)).toBe("/new/redirect/My Games/Skyrim Special Edition");
    expect(util.getGameUserPath).toHaveBeenLastCalledWith(
      "documents",
      {
        path: "/Another library/Game",
        store: "steam",
      },
      true,
    );
  });

  it("requires a prefix even when a Windows store discovery would otherwise fall back to host folders", () => {
    state.settings.gameMode.discovered.skyrimse.store = "gog";
    settingsPath(game);
    expect(util.getGameUserPath).toHaveBeenLastCalledWith(
      "documents",
      {
        path: "/Secondary Steam/Game",
        store: "gog",
      },
      true,
    );
  });

  it("does not resolve user folders while rendering action visibility", () => {
    vi.mocked(util.getGameUserPath).mockImplementation(() => {
      throw new util.ProcessCanceled("Invalid registry path");
    });
    expect(hasSettingsPath(game)).toBe(true);
    expect(hasAppDataPath(game)).toBe(true);
    expect(util.getGameUserPath).not.toHaveBeenCalled();
    expect(() => settingsPath(game)).toThrow("Invalid registry path");
    expect(() => appDataPath(game)).toThrow("Invalid registry path");
  });

  it("preserves an explicit non-Steam settings prefix", () => {
    state.settings.gameMode.discovered.skyrimse = {
      path: "/Games/Skyrim",
      store: "gog",
      modSettingsPrefix: "/Custom Wine Prefix",
    };
    settingsPath(game);
    expect(util.getGameUserPath).toHaveBeenLastCalledWith(
      "documents",
      {
        path: "/Games/Skyrim",
        store: "gog",
        modSettingsPrefix: "/Custom Wine Prefix",
      },
      true,
    );
  });

  it("rejects unavailable discovery without opening a host directory", () => {
    delete state.settings.gameMode.discovered.skyrimse;
    expect(() => settingsPath(game)).toThrow("Discover the game's installation");
    expect(() => appDataPath(game)).toThrow("Discover the game's installation");
    expect(util.getGameUserPath).not.toHaveBeenCalled();
    expect(util.getVortexPath).not.toHaveBeenCalled();
  });

  it("shows prefix errors from a clicked action without throwing from visibility checks", () => {
    const actions = new Map<string, { click: () => void; visible?: () => boolean }>();
    const context = {
      api,
      registerAction: vi.fn((_group, _order, _icon, _options, title, click, visible) =>
        actions.set(title, { click, visible }),
      ),
    } as any;
    vi.mocked(util.getGame).mockReturnValue(game);
    vi.mocked(util.getGameUserPath).mockImplementation(() => {
      throw new util.ProcessCanceled("Unavailable prefix");
    });
    init(context);
    for (const title of ["Open Game Settings Folder", "Open Game Application Data Folder"]) {
      expect(actions.get(title).visible()).toBe(true);
      expect(() => actions.get(title).click()).not.toThrow();
    }
    expect(api.showErrorNotification).toHaveBeenCalledTimes(2);
    expect(util.opn).not.toHaveBeenCalled();
    expect(fs.statAsync).not.toHaveBeenCalled();
  });

  it("retains custom paths and hides unavailable game actions", () => {
    const custom = {
      id: "custom",
      details: { settingsPath: () => "/custom/settings", appDataPath: () => "/custom/data" },
    } as any;
    expect(settingsPath(custom)).toBe("/custom/settings");
    expect(appDataPath(custom)).toBe("/custom/data");
    expect(hasSettingsPath(custom)).toBe(true);
    expect(hasAppDataPath(custom)).toBe(true);
    expect(hasSettingsPath(undefined)).toBe(false);
    expect(hasAppDataPath({ id: "unsupported" } as any)).toBe(false);
  });

  it.each(["xbox", "gog", "epic"])("retains the %s Windows store overlay", (store) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    state.settings.gameMode.discovered.skyrimse.store = store;
    const suffix = { xbox: "MS", gog: "GOG", epic: "EPIC" }[store];
    expect(settingsPath(game)).toBe(
      path.join("/host/documents", "My Games", `Skyrim Special Edition ${suffix}`),
    );
    expect(util.getGameUserPath).not.toHaveBeenCalled();
  });
});
