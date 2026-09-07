import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logging", () => ({ log: vi.fn() }));

import { log } from "../logging";
import type QueryRegistry from "./QueryRegistry";
import QueryInvalidator from "./QueryInvalidator";
import type QueryWatcher from "./QueryWatcher";

const dirtyTable = (table: string, database = "gamedata") =>
  ({ database, table, type: "insert" }) as const;

class FakeRegistry {
  hasQueries = true;
  getAffectedQueries = vi.fn<(tables: string[]) => string[]>().mockReturnValue([]);
}

class FakeWatcher {
  onQueriesInvalidated = vi.fn<(queries: string[]) => Promise<void>>().mockResolvedValue(undefined);
}

function createInvalidator() {
  const registry = new FakeRegistry();
  const watcher = new FakeWatcher();
  const invalidator = new QueryInvalidator(registry as unknown as QueryRegistry, 16);
  invalidator.setWatcher(watcher as unknown as QueryWatcher);
  return { invalidator, registry, watcher };
}

describe("QueryInvalidator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is a no-op when no queries are registered", async () => {
    const invalidator = new QueryInvalidator(
      { hasQueries: false } as unknown as QueryRegistry,
      16,
    );
    invalidator.notifyDirtyTables([dirtyTable("mods")]);
    await vi.advanceTimersByTimeAsync(100);
  });

  it("debounces and reports qualified and unqualified dirty table names", async () => {
    const { invalidator, registry, watcher } = createInvalidator();
    registry.getAffectedQueries.mockReturnValue(["modList"]);

    invalidator.notifyDirtyTables([dirtyTable("mods")]);
    invalidator.notifyDirtyTables([dirtyTable("load_order")]);

    // Still inside the debounce window: nothing flushed yet.
    expect(registry.getAffectedQueries).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);

    expect(registry.getAffectedQueries).toHaveBeenCalledTimes(1);
    expect(registry.getAffectedQueries).toHaveBeenCalledWith([
      "gamedata.mods",
      "mods",
      "gamedata.load_order",
      "load_order",
    ]);
    expect(watcher.onQueriesInvalidated).toHaveBeenCalledWith(["modList"]);
  });

  it("does not notify the watcher when no query references the dirty tables", async () => {
    const { invalidator, watcher } = createInvalidator();

    invalidator.notifyDirtyTables([dirtyTable("unrelated")]);
    await vi.advanceTimersByTimeAsync(16);

    expect(watcher.onQueriesInvalidated).not.toHaveBeenCalled();
  });

  it("deduplicates repeated notifications of the same table", async () => {
    const { invalidator, registry } = createInvalidator();

    invalidator.notifyDirtyTables([dirtyTable("mods")]);
    invalidator.notifyDirtyTables([dirtyTable("mods")]);
    await vi.advanceTimersByTimeAsync(16);

    expect(registry.getAffectedQueries).toHaveBeenCalledTimes(1);
    expect(registry.getAffectedQueries).toHaveBeenCalledWith(["gamedata.mods", "mods"]);
  });

  it("logs and swallows a watcher notification failure", async () => {
    const { invalidator, watcher } = createInvalidator();
    watcher.onQueriesInvalidated.mockRejectedValue(new Error("watcher down"));
    invalidator.notifyDirtyTables([dirtyTable("mods")]);

    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(0);

    expect(log).toHaveBeenCalledWith("warn", "QueryWatcher notification failed", expect.any(Error));
  });

  it("does not require a watcher to be set", async () => {
    const registry = new FakeRegistry();
    registry.getAffectedQueries.mockReturnValue(["modList"]);
    const invalidator = new QueryInvalidator(registry as unknown as QueryRegistry, 16);

    invalidator.notifyDirtyTables([dirtyTable("mods")]);
    await vi.advanceTimersByTimeAsync(16);

    expect(registry.getAffectedQueries).toHaveBeenCalledTimes(1);
  });
});