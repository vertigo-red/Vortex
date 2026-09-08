import { beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";

import DuckDBSingleton from "./DuckDBSingleton";

const { logMock, createMock, connectMock, instanceCloseSyncMock, connections } = vi.hoisted(() => {
  const logMock = vi.fn<(level: string, message: string, details?: unknown) => void>();
  const instanceCloseSyncMock = vi.fn<() => void>();

  type Connection = {
    run: MockedFunction<(sql: string) => Promise<unknown>>;
    closeSync: MockedFunction<() => void>;
  };

  const connections: Connection[] = [];

  const makeConnection = (): Connection => {
    const conn = {
      run: vi.fn<(sql: string) => Promise<unknown>>(async (_sql: string) => {}),
      closeSync: vi.fn<() => void>(() => {}),
    };
    connections.push(conn);
    return conn;
  };

  const connectMock = vi.fn<() => Promise<unknown>>(async () => makeConnection());

  const defaultCreateImpl = async () => ({
    connect: connectMock,
    closeSync: instanceCloseSyncMock,
  });

  const createMock =
    vi.fn<
      (
        db: string,
        config: { allow_unsigned_extensions: string; extension_directory: string },
      ) => Promise<unknown>
    >(defaultCreateImpl);

  return { logMock, createMock, connectMock, instanceCloseSyncMock, connections };
});

vi.mock("@duckdb/node-api", () => ({
  DuckDBInstance: { create: createMock },
}));

vi.mock("../logging", () => ({
  log: logMock,
}));

beforeEach(() => {
  DuckDBSingleton.getInstance().close();
  vi.clearAllMocks();
  connections.length = 0;
});

describe("getInstance", () => {
  it("returns the same instance across calls", () => {
    expect(DuckDBSingleton.getInstance()).toBe(DuckDBSingleton.getInstance());
  });

  it("returns a fresh instance after close", () => {
    const first = DuckDBSingleton.getInstance();
    first.close();
    expect(DuckDBSingleton.getInstance()).not.toBe(first);
  });
});

describe("isInitialized", () => {
  it("starts as false", () => {
    expect(DuckDBSingleton.getInstance().isInitialized).toBe(false);
  });

  it("becomes true once initialization completes", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize("/extensions");
    expect(instance.isInitialized).toBe(true);
  });
});

describe("initialize", () => {
  const extensionDir = "/extensions";

  it("creates an in-memory instance with unsigned extensions enabled and the extension directory", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    expect(createMock).toHaveBeenCalledWith(":memory:", {
      allow_unsigned_extensions: "true",
      extension_directory: extensionDir,
    });
    expect(logMock).toHaveBeenCalledWith("debug", "duckdb-singleton: creating shared instance", {
      extensionDir,
    });
  });

  it("loads level_pivot on a temporary connection and closes it", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    const loader = connections[0];
    expect(loader).toBeDefined();
    expect(loader?.run).toHaveBeenCalledWith("LOAD level_pivot");
    expect(loader?.closeSync).toHaveBeenCalledWith();
    expect(instanceCloseSyncMock).not.toHaveBeenCalled();
  });

  it("only initializes once when called repeatedly", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    await instance.initialize(extensionDir);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("shares the in-flight promise between concurrent callers", async () => {
    const instance = DuckDBSingleton.getInstance();
    const first = instance.initialize(extensionDir);
    const second = instance.initialize(extensionDir);
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("propagates instance creation failures and stays uninitialized", async () => {
    createMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    const instance = DuckDBSingleton.getInstance();
    await expect(instance.initialize(extensionDir)).rejects.toThrow("boom");
    expect(instance.isInitialized).toBe(false);
    createMock.mockImplementation(async () => ({
      connect: connectMock,
      closeSync: instanceCloseSyncMock,
    }));
  });
});

describe("attachDatabase", () => {
  const extensionDir = "/extensions";

  it("rejects when the singleton is not initialized", async () => {
    const instance = DuckDBSingleton.getInstance();
    await expect(instance.attachDatabase("C:/vortex/hive", "db")).rejects.toThrow(
      "DuckDBSingleton not initialized",
    );
  });

  it("attaches the database, records it under the alias and returns a tracked connection", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    const connection = await instance.attachDatabase("C:/vortex/hive", "db");
    const attached = connections.at(-1);
    expect(connection).toBe(attached);
    expect(attached?.run).toHaveBeenCalledWith(
      "ATTACH 'C:/vortex/hive' AS db (TYPE level_pivot, CREATE_IF_MISSING true)",
    );
    expect(attached?.run).toHaveBeenCalledWith(
      "CALL level_pivot_create_table('db', 'kv', NULL, ['key', 'value'], table_mode := 'raw')",
    );
    expect(instance.attachedDatabases.get("db")).toBe("C:/vortex/hive");
    expect(logMock).toHaveBeenCalledWith("debug", "duckdb-singleton: database attached", {
      alias: "db",
    });
  });

  it("escapes single quotes in the persisted path", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    await instance.attachDatabase("C:/vortex/hive's.db", "db");
    const attached = connections.at(-1);
    expect(attached?.run).toHaveBeenCalledWith(
      "ATTACH 'C:/vortex/hive''s.db' AS db (TYPE level_pivot, CREATE_IF_MISSING true)",
    );
  });

  it("rejects when the alias is already attached", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    await instance.attachDatabase("C:/vortex/hive", "db");
    await expect(instance.attachDatabase("C:/vortex/other", "db")).rejects.toThrow(
      "Database alias 'db' already attached",
    );
    expect(connections).toHaveLength(2);
  });
});

describe("detachDatabase", () => {
  const extensionDir = "/extensions";

  it("is a no-op when the singleton is not initialized", async () => {
    const instance = DuckDBSingleton.getInstance();
    await expect(instance.detachDatabase("db")).resolves.toBeUndefined();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it("is a no-op when the alias is not attached", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    await expect(instance.detachDatabase("missing")).resolves.toBeUndefined();
    expect(connections).toHaveLength(1);
  });

  it("detaches an attached database without closing the persistent connection", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    await instance.attachDatabase("C:/vortex/hive", "db");
    const attached = connections.at(-1);
    await instance.detachDatabase("db");
    const detacher = connections.at(-1);
    expect(detacher?.run).toHaveBeenCalledWith("DETACH db");
    expect(detacher?.closeSync).toHaveBeenCalledWith();
    expect(attached?.closeSync).not.toHaveBeenCalled();
    expect(instance.attachedDatabases.has("db")).toBe(false);
    expect(logMock).toHaveBeenCalledWith("debug", "duckdb-singleton: database detached", {
      alias: "db",
    });
  });
});

describe("createConnection", () => {
  const extensionDir = "/extensions";

  it("rejects when the singleton is not initialized", async () => {
    const instance = DuckDBSingleton.getInstance();
    await expect(instance.createConnection()).rejects.toThrow("DuckDBSingleton not initialized");
  });

  it("returns a new tracked connection once initialized", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    const connection = await instance.createConnection();
    expect(connection).toBe(connections.at(-1));
    expect(connections).toHaveLength(2);
  });
});

describe("nextAlias", () => {
  it("returns a unique monotonically-increasing alias", () => {
    const instance = DuckDBSingleton.getInstance();
    expect(instance.nextAlias()).toBe("db");
    expect(instance.nextAlias()).toBe("db_1");
    expect(instance.nextAlias()).toBe("db_2");
  });

  it("restarts at the base alias after close", () => {
    const first = DuckDBSingleton.getInstance();
    first.nextAlias();
    first.nextAlias();
    first.close();
    const second = DuckDBSingleton.getInstance();
    expect(second.nextAlias()).toBe("db");
  });
});

describe("close", () => {
  const extensionDir = "/extensions";

  it("closes every tracked connection and the shared instance", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    await instance.attachDatabase("C:/vortex/hive", "db");
    await instance.createConnection();
    const [loader, attached, extra] = connections;
    instance.close();
    expect(attached?.closeSync).toHaveBeenCalledTimes(1);
    expect(extra?.closeSync).toHaveBeenCalledTimes(1);
    expect(loader?.closeSync).toHaveBeenCalledTimes(1);
    expect(instanceCloseSyncMock).toHaveBeenCalledTimes(1);
  });

  it("swallows errors from already-closed connections", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    await instance.attachDatabase("C:/vortex/hive", "db");
    const attached = connections.at(-1);
    attached?.closeSync.mockImplementationOnce(() => {
      throw new Error("already closed");
    });
    await instance.createConnection();
    const extra = connections.at(-1);
    expect(() => instance.close()).not.toThrow();
    expect(extra?.closeSync).toHaveBeenCalledTimes(1);
    expect(instanceCloseSyncMock).toHaveBeenCalledTimes(1);
  });

  it("resets all state and the singleton instance", async () => {
    const instance = DuckDBSingleton.getInstance();
    await instance.initialize(extensionDir);
    await instance.attachDatabase("C:/vortex/hive", "db");
    instance.close();
    expect(instance.isInitialized).toBe(false);
    expect(instance.attachedDatabases.size).toBe(0);
    expect(DuckDBSingleton.getInstance()).not.toBe(instance);
    expect(instance.nextAlias()).toBe("db");
    expect(logMock).toHaveBeenCalledWith("debug", "duckdb-singleton: closed");
  });

  it("is safe to call before initialization", () => {
    const instance = DuckDBSingleton.getInstance();
    expect(() => instance.close()).not.toThrow();
    expect(instanceCloseSyncMock).not.toHaveBeenCalled();
  });
});
