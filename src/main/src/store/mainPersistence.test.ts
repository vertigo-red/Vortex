import * as path from "node:path";

import type { DiffOperation } from "@vortex/shared/ipc";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type LevelPersist from "./LevelPersist";

const {
  logMock,
  getVortexPathMock,
  betterIpcSendMock,
  browserWindowsGetAll,
  setupPersistenceIPCMock,
  parseAllQueriesMock,
  duckdbGetInstanceMock,
  ReduxPersistorMock,
  reduxPersistorInstances,
  SubPersistorMock,
  subPersistorInstances,
  subPersistorPlan,
  QueryRegistryMock,
  queryRegistryInstances,
  QueryInvalidatorMock,
  queryInvalidatorInstances,
  QueryWatcherMock,
  DatabaseMock,
} = vi.hoisted(() => {
  const logMock = vi.fn<(level: string, message: string, meta?: Record<string, unknown>) => void>();
  const getVortexPathMock = vi.fn<(key: string) => string>();
  const betterIpcSendMock =
    vi.fn<(wc: unknown, channel: string, hive: string, operations: unknown[]) => void>();
  const browserWindowsGetAll =
    vi.fn<() => Array<{ isDestroyed: () => boolean; webContents: unknown }>>();
  const setupPersistenceIPCMock = vi.fn<() => void>();
  const parseAllQueriesMock = vi.fn<() => unknown[]>();
  const duckdbGetInstanceMock =
    vi.fn<() => { isInitialized: boolean; createConnection: () => Promise<unknown> }>();

  const reduxPersistorInstances: ReduxPersistorMock[] = [];
  class ReduxPersistorMock {
    public setPersistorFactory = vi.fn<(factory: (hive: string) => unknown) => void>();
    public finalizeWrite = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    public insertPersistor = vi
      .fn<(hive: string, persistor: unknown) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    public applyDiffOperations = vi.fn<(hive: string, operations: unknown[]) => void>();
    public setQueryInvalidator = vi.fn<() => void>();

    constructor() {
      reduxPersistorInstances.push(this);
    }
  }

  const subPersistorPlan = {
    getItem: () => Promise.resolve(""),
    setItem: () => Promise.resolve(undefined),
  };
  const subPersistorInstances: SubPersistorMock[] = [];
  class SubPersistorMock {
    public getItem = vi.fn<(path: string[]) => Promise<string>>(subPersistorPlan.getItem);
    public setItem = vi.fn<(path: string[], value: string) => Promise<void>>(
      subPersistorPlan.setItem,
    );

    constructor(
      public wrapped: unknown,
      public hive: string,
    ) {
      subPersistorInstances.push(this);
    }
  }

  const queryRegistryInstances: QueryRegistryMock[] = [];
  class QueryRegistryMock {
    public initialize = vi.fn<(queries: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    public getQueryNames = vi.fn<() => string[]>().mockReturnValue(["a"]);

    constructor(public connection: unknown) {
      queryRegistryInstances.push(this);
    }
  }

  const queryInvalidatorInstances: QueryInvalidatorMock[] = [];
  class QueryInvalidatorMock {
    public setWatcher = vi.fn<() => void>();

    constructor() {
      queryInvalidatorInstances.push(this);
    }
  }

  class QueryWatcherMock {
    constructor(public registry: unknown) {}
  }
  class DatabaseMock {
    constructor(
      public levelPersist: unknown,
      public invalidator: unknown,
    ) {}
  }

  return {
    logMock,
    getVortexPathMock,
    betterIpcSendMock,
    browserWindowsGetAll,
    setupPersistenceIPCMock,
    parseAllQueriesMock,
    duckdbGetInstanceMock,
    ReduxPersistorMock,
    reduxPersistorInstances,
    SubPersistorMock,
    subPersistorInstances,
    subPersistorPlan,
    QueryRegistryMock,
    queryRegistryInstances,
    QueryInvalidatorMock,
    queryInvalidatorInstances,
    QueryWatcherMock,
    DatabaseMock,
  };
});

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: browserWindowsGetAll } }));
vi.mock("../getVortexPath", () => ({ getVortexPath: getVortexPathMock }));
vi.mock("../ipc", () => ({ betterIpcMain: { send: betterIpcSendMock } }));
vi.mock("../logging", () => ({ log: logMock }));
vi.mock("./Database", () => ({ Database: DatabaseMock }));
vi.mock("./DuckDBSingleton", () => ({
  __esModule: true,
  default: { getInstance: duckdbGetInstanceMock },
}));
vi.mock("./persistenceIPC", () => ({ setupPersistenceIPC: setupPersistenceIPCMock }));
vi.mock("./QueryInvalidator", () => ({ __esModule: true, default: QueryInvalidatorMock }));
vi.mock("./queryParser", () => ({ parseAllQueries: parseAllQueriesMock }));
vi.mock("./QueryRegistry", () => ({ __esModule: true, default: QueryRegistryMock }));
vi.mock("./QueryWatcher", () => ({ __esModule: true, default: QueryWatcherMock }));
vi.mock("./ReduxPersistorIPC", () => ({ __esModule: true, default: ReduxPersistorMock }));
vi.mock("./SubPersistor", () => ({ __esModule: true, default: SubPersistorMock }));

import {
  closeMainPersistence,
  finalizeMainWrite,
  getDatabase,
  getMainPersistor,
  getPersistedHives,
  initMainPersistence,
  pushStateToRenderer,
  readHiveData,
  readPersistedValue,
  registerAllPersistedHives,
  registerHive,
  writePersistedValue,
} from "./mainPersistence";

const levelPersist = {
  getAllKVs: vi.fn<(prefix: string) => Promise<Array<{ key: string[]; value: string }>>>(),
  getPersistedHives: vi.fn<() => Promise<string[]>>(),
  close: vi.fn<() => Promise<void>>(),
};

const init = () => initMainPersistence(levelPersist as unknown as LevelPersist);

function resetState(): void {
  subPersistorInstances.length = 0;
  subPersistorPlan.getItem = () => Promise.resolve("");
  subPersistorPlan.setItem = () => Promise.resolve(undefined);
  reduxPersistorInstances.length = 0;
  queryRegistryInstances.length = 0;
  queryInvalidatorInstances.length = 0;
  levelPersist.getAllKVs.mockResolvedValue([]);
  levelPersist.getPersistedHives.mockResolvedValue([]);
  levelPersist.close.mockResolvedValue(undefined);
  duckdbGetInstanceMock.mockReturnValue({
    isInitialized: false,
    createConnection: vi.fn<() => Promise<unknown>>(),
  });
  getVortexPathMock.mockReturnValue("/data/base");
  parseAllQueriesMock.mockReturnValue([]);
}

describe("mainPersistence initial state", () => {
  beforeEach(async () => {
    await closeMainPersistence();
    vi.clearAllMocks();
    resetState();
  });

  it("exposes undefined persistor and database before initialization", () => {
    expect(getMainPersistor()).toBeUndefined();
    expect(getDatabase()).toBeUndefined();
  });

  it("resolves finalizeMainWrite without a persistor", async () => {
    await expect(finalizeMainWrite()).resolves.toBeUndefined();
  });

  it("no-ops closeMainPersistence when uninitialized", async () => {
    await expect(closeMainPersistence()).resolves.toBeUndefined();
    expect(levelPersist.close).not.toHaveBeenCalled();
  });
});

describe("mainPersistence initialization", () => {
  beforeEach(async () => {
    await closeMainPersistence();
    vi.clearAllMocks();
    resetState();
  });

  it("creates a persistor, sets the factory and wires persistence IPC", () => {
    const persistor = init();

    expect(persistor).toBeInstanceOf(ReduxPersistorMock);
    expect(setupPersistenceIPCMock).toHaveBeenCalledTimes(1);
    expect(setupPersistenceIPCMock).toHaveBeenCalledWith(persistor);
    expect(reduxPersistorInstances.at(-1)?.setPersistorFactory).toHaveBeenCalledTimes(1);
    expect(getMainPersistor()).toBe(persistor);
  });

  it("is a singleton - later calls return the existing instance", () => {
    const first = init();
    const second = init();

    expect(second).toBe(first);
    expect(reduxPersistorInstances).toHaveLength(1);
    expect(setupPersistenceIPCMock).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh instance after closeMainPersistence", async () => {
    const first = init();
    await closeMainPersistence();
    const second = init();

    expect(second).not.toBe(first);
    expect(reduxPersistorInstances).toHaveLength(2);
  });

  it("skips the query system when DuckDB is not initialized", () => {
    init();

    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "DuckDBSingleton not initialized, skipping query system",
    );
    expect(queryRegistryInstances).toHaveLength(0);
    expect(getDatabase()).toBeUndefined();
  });

  it("warns and skips the query system when parseAllQueries throws", async () => {
    duckdbGetInstanceMock.mockReturnValue({
      isInitialized: true,
      createConnection: vi.fn<() => Promise<unknown>>().mockResolvedValue("connection"),
    });
    parseAllQueriesMock.mockImplementation(() => {
      throw new Error("bad sql");
    });

    init();
    await vi.waitFor(() =>
      expect(logMock).toHaveBeenCalledWith("warn", "No query files found or parse error", {
        dir: path.join("/data/base", "queries"),
        error: "bad sql",
      }),
    );
    expect(queryRegistryInstances).toHaveLength(0);
  });

  it("initializes the full query system when DuckDB is ready", async () => {
    duckdbGetInstanceMock.mockReturnValue({
      isInitialized: true,
      createConnection: vi.fn<() => Promise<unknown>>().mockResolvedValue("connection"),
    });
    parseAllQueriesMock.mockReturnValue([{ table: "games", query: "select 1" }]);

    init();
    await vi.waitFor(() =>
      expect(logMock).toHaveBeenCalledWith("info", "Query system initialized", {
        queryCount: 1,
      }),
    );

    expect(reduxPersistorInstances.at(-1)?.setQueryInvalidator).toHaveBeenCalledTimes(1);
    expect(getDatabase()).toBeInstanceOf(DatabaseMock);
  });

  it("creates persistors on demand via the persistor factory", () => {
    init();
    const factory = reduxPersistorInstances.at(-1)?.setPersistorFactory.mock.calls[0]?.[0];

    expect(factory).toBeTypeOf("function");
    expect(factory?.("extraHive")).toBeInstanceOf(SubPersistorMock);
    expect(subPersistorInstances.at(-1)?.hive).toBe("extraHive");
  });
});

describe("registerHive", () => {
  beforeEach(async () => {
    await closeMainPersistence();
    vi.clearAllMocks();
    resetState();
  });

  it("rejects before persistence is initialized", async () => {
    await expect(registerHive("settings")).rejects.toThrow(
      "Main persistence not initialized. Call initMainPersistence() first.",
    );
    expect(reduxPersistorInstances).toHaveLength(0);
  });

  it("creates a SubPersistor and registers it with the persistor", async () => {
    init();
    reduxPersistorInstances.at(-1)?.insertPersistor.mockResolvedValue({ theme: "dark" });

    await expect(registerHive("settings")).resolves.toEqual({ theme: "dark" });

    expect(subPersistorInstances.at(-1)?.hive).toBe("settings");
    expect(reduxPersistorInstances.at(-1)?.insertPersistor).toHaveBeenCalledTimes(1);
    expect(reduxPersistorInstances.at(-1)?.insertPersistor.mock.calls[0]?.[0]).toBe("settings");
  });
});

describe("pushStateToRenderer", () => {
  const operations: DiffOperation[] = [{ type: "set", path: ["a"], value: 1 }];

  beforeEach(async () => {
    await closeMainPersistence();
    vi.clearAllMocks();
    resetState();
    browserWindowsGetAll.mockReturnValue([
      { isDestroyed: () => false, webContents: { id: 1 } },
      { isDestroyed: () => true, webContents: { id: 2 } },
    ]);
  });

  it("warns and does not send before persistence is initialized", async () => {
    await expect(pushStateToRenderer("settings", operations)).resolves.toBeUndefined();

    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "pushStateToRenderer called before persistence is initialized",
    );
    expect(betterIpcSendMock).not.toHaveBeenCalled();
  });

  it("applies, finalizes and pushes to live windows only", async () => {
    const persistor = init();

    await expect(pushStateToRenderer("settings", operations)).resolves.toBeUndefined();

    expect(reduxPersistorInstances.at(-1)?.applyDiffOperations).toHaveBeenCalledWith(
      "settings",
      operations,
    );
    expect(reduxPersistorInstances.at(-1)?.finalizeWrite).toHaveBeenCalledTimes(1);
    expect(betterIpcSendMock).toHaveBeenCalledTimes(1);
    expect(persistor).toBe(reduxPersistorInstances.at(-1));
  });
});

describe("readPersistedValue", () => {
  beforeEach(async () => {
    await closeMainPersistence();
    vi.clearAllMocks();
    resetState();
  });

  it("returns undefined before persistence is initialized", async () => {
    await expect(readPersistedValue("settings", ["window"])).resolves.toBeUndefined();
    expect(subPersistorInstances).toHaveLength(0);
  });

  it("parses a direct hit on the leaf key", async () => {
    init();
    subPersistorPlan.getItem = () => Promise.resolve('{"width":100}');

    await expect(readPersistedValue<{ width: number }>("settings", ["window"])).resolves.toEqual({
      width: 100,
    });
    expect(levelPersist.getAllKVs).not.toHaveBeenCalled();
  });

  it("returns undefined for an empty direct value", async () => {
    init();

    await expect(readPersistedValue("settings", ["window"])).resolves.toBeUndefined();
    expect(levelPersist.getAllKVs).not.toHaveBeenCalled();
  });

  it("reconstructs nested objects from the prefix scan after a key miss", async () => {
    init();
    subPersistorPlan.getItem = () =>
      Promise.reject(Object.assign(new Error("not found"), { name: "NotFoundError" }));
    levelPersist.getAllKVs.mockResolvedValue([
      { key: ["settings", "window", "x", "y"], value: "1" },
      { key: ["settings", "window", "title"], value: '"V"' },
    ]);

    await expect(readPersistedValue("settings", ["window"])).resolves.toEqual({
      x: { y: 1 },
      title: "V",
    });
    expect(levelPersist.getAllKVs).toHaveBeenCalledWith("settings###window");
  });

  it("keeps non-JSON leaves as raw strings", async () => {
    init();
    subPersistorPlan.getItem = () => Promise.reject(new Error("miss"));
    levelPersist.getAllKVs.mockResolvedValue([
      { key: ["settings", "window", "theme"], value: "not json" },
    ]);

    await expect(readPersistedValue("settings", ["window"])).resolves.toEqual({
      theme: "not json",
    });
  });

  it("returns undefined when the prefix scan yields nothing", async () => {
    init();
    subPersistorPlan.getItem = () => Promise.reject(new Error("miss"));
    levelPersist.getAllKVs.mockResolvedValue([]);

    await expect(readPersistedValue("settings", ["window"])).resolves.toBeUndefined();
  });

  it("warns and returns undefined when the prefix scan fails", async () => {
    init();
    subPersistorPlan.getItem = () => Promise.reject(new Error("miss"));
    levelPersist.getAllKVs.mockRejectedValue(new Error("db down"));

    await expect(readPersistedValue("settings", ["window"])).resolves.toBeUndefined();
    expect(logMock).toHaveBeenCalledWith("warn", "Could not read persisted value", {
      hive: "settings",
      path: ["window"],
      error: "db down",
    });
  });
});

describe("writePersistedValue", () => {
  beforeEach(async () => {
    await closeMainPersistence();
    vi.clearAllMocks();
    resetState();
  });

  it("does nothing before persistence is initialized", async () => {
    await expect(writePersistedValue("app", ["instanceId"], "abc")).resolves.toBeUndefined();
    expect(subPersistorInstances).toHaveLength(0);
  });

  it("writes the JSON-serialized value via a SubPersistor", async () => {
    init();

    await expect(writePersistedValue("app", ["instanceId"], "abc")).resolves.toBeUndefined();

    expect(subPersistorInstances.at(-1)?.hive).toBe("app");
    expect(subPersistorInstances.at(-1)?.setItem).toHaveBeenCalledWith(
      ["instanceId"],
      JSON.stringify("abc"),
    );
  });

  it("logs and swallows write failures", async () => {
    init();
    subPersistorPlan.setItem = () => Promise.reject(new Error("nope"));

    await expect(writePersistedValue("app", ["instanceId"], "abc")).resolves.toBeUndefined();
    expect(logMock).toHaveBeenCalledWith("warn", "Could not write persisted value", {
      hive: "app",
      path: ["instanceId"],
      error: "nope",
    });
  });
});

describe("readHiveData", () => {
  beforeEach(async () => {
    await closeMainPersistence();
    vi.clearAllMocks();
    resetState();
  });

  it("returns an empty object before persistence is initialized", async () => {
    await expect(readHiveData("settings")).resolves.toEqual({});
  });

  it("returns hydration data via insertPersistor", async () => {
    init();
    reduxPersistorInstances.at(-1)?.insertPersistor.mockResolvedValue({ theme: "dark" });

    await expect(readHiveData("settings")).resolves.toEqual({ theme: "dark" });
    expect(reduxPersistorInstances.at(-1)?.insertPersistor.mock.calls[0]?.[0]).toBe("settings");
  });

  it("returns an empty object and warns when hydration fails", async () => {
    init();
    reduxPersistorInstances
      .at(-1)
      ?.insertPersistor.mockRejectedValue(new Error("hydration failed"));

    await expect(readHiveData("settings")).resolves.toEqual({});
    expect(logMock).toHaveBeenCalledWith("warn", "Could not read hive data", {
      hive: "settings",
      error: "hydration failed",
    });
  });
});

describe("getPersistedHives", () => {
  beforeEach(async () => {
    await closeMainPersistence();
    vi.clearAllMocks();
    resetState();
  });

  it("returns an empty array before persistence is initialized", async () => {
    await expect(getPersistedHives()).resolves.toEqual([]);
  });

  it("returns the discovered hives", async () => {
    init();
    levelPersist.getPersistedHives.mockResolvedValue(["settings", "app"]);

    await expect(getPersistedHives()).resolves.toEqual(["settings", "app"]);
  });

  it("logs and returns an empty array on failure", async () => {
    init();
    levelPersist.getPersistedHives.mockRejectedValue(new Error("can't list"));

    await expect(getPersistedHives()).resolves.toEqual([]);
    expect(logMock).toHaveBeenCalledWith("warn", "Could not get persisted hives", {
      error: "can't list",
    });
  });
});

describe("registerAllPersistedHives", () => {
  beforeEach(async () => {
    await closeMainPersistence();
    vi.clearAllMocks();
    resetState();
  });

  it("returns an empty object before persistence is initialized", async () => {
    await expect(registerAllPersistedHives()).resolves.toEqual({});
  });

  it("registers every discovered hive and isolates per-hive failures", async () => {
    init();
    levelPersist.getPersistedHives.mockResolvedValue(["a", "b"]);
    reduxPersistorInstances
      .at(-1)
      ?.insertPersistor.mockResolvedValueOnce({ x: 1 })
      .mockRejectedValueOnce(new Error("bad hive"));

    await expect(registerAllPersistedHives()).resolves.toEqual({ a: { x: 1 }, b: {} });
    expect(logMock).toHaveBeenCalledWith("info", "Discovered persisted hives", {
      hives: ["a", "b"],
    });
    expect(logMock).toHaveBeenCalledWith("warn", "Could not register hive", {
      hive: "b",
      error: "bad hive",
    });
  });
});
