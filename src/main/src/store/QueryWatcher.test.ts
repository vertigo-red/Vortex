import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging", () => ({ log: vi.fn() }));

import { log } from "../logging";
import type QueryRegistry from "./QueryRegistry";
import QueryWatcher, { type WatchDiff } from "./QueryWatcher";

function createRegistry() {
  return {
    executeQuery: vi.fn<(name: string, params?: Record<string, unknown>) => Promise<unknown>>(),
  };
}

function createWatcher(registry?: ReturnType<typeof createRegistry>) {
  const reg = registry ?? createRegistry();
  const watcher = new QueryWatcher(reg as unknown as QueryRegistry);
  return { watcher, registry: reg };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("QueryWatcher.watch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("performs an initial fetch to establish the baseline without notifying", async () => {
    const { watcher, registry } = createWatcher();
    registry.executeQuery.mockResolvedValue([{ a: 1 }]);
    const callback = vi.fn();

    watcher.watch("queryA", {}, callback);
    await flush();

    expect(registry.executeQuery).toHaveBeenCalledWith("queryA", {});
    expect(callback).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe function that stops updates", async () => {
    const { watcher, registry } = createWatcher();
    registry.executeQuery.mockResolvedValue([{ a: 1 }]);
    const callback = vi.fn();

    const unsubscribe = watcher.watch("queryA", {}, callback);
    unsubscribe();
    await flush();

    await watcher.onQueriesInvalidated(["queryA"]);
    expect(callback).not.toHaveBeenCalled();
  });

  it("logs and swallows an initial fetch failure", async () => {
    const { watcher, registry } = createWatcher();
    registry.executeQuery.mockRejectedValue(new Error("down"));
    watcher.watch("queryA", {}, vi.fn());
    await flush();

    expect(log).toHaveBeenCalledWith("warn", "QueryWatcher: initial fetch failed", {
      queryName: "queryA",
      error: "down",
    });
  });
});

describe("QueryWatcher.onQueriesInvalidated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-executes affected queries and notifies on a diff", async () => {
    const { watcher, registry } = createWatcher();
    registry.executeQuery.mockResolvedValueOnce([{ a: 1 }]).mockResolvedValueOnce([{ a: 2 }]);
    const callback = vi.fn<(diff: WatchDiff) => void>();

    watcher.watch("queryA", { gameId: "skyrim" }, callback);
    await flush();

    await watcher.onQueriesInvalidated(["queryA"]);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]?.[0]).toEqual({
      queryName: "queryA",
      previous: [{ a: 1 }],
      current: [{ a: 2 }],
    });
  });

  it("does not notify when the results are identical", async () => {
    const { watcher, registry } = createWatcher();
    registry.executeQuery.mockResolvedValue([{ a: 1 }]);
    const callback = vi.fn();

    watcher.watch("queryA", {}, callback);
    await flush();

    await watcher.onQueriesInvalidated(["queryA"]);
    expect(callback).not.toHaveBeenCalled();
  });

  it("ignores invalidation of queries nobody watches", async () => {
    const { watcher, registry } = createWatcher();
    registry.executeQuery.mockResolvedValue([{ a: 1 }]);
    const callback = vi.fn();

    watcher.watch("queryA", {}, callback);
    await flush();

    await watcher.onQueriesInvalidated(["queryB"]);
    expect(registry.executeQuery).toHaveBeenCalledTimes(1); // initial fetch only
    expect(callback).not.toHaveBeenCalled();
  });

  it("only re-executes the affected watches", async () => {
    const { watcher, registry } = createWatcher();
    registry.executeQuery.mockResolvedValue([]);
    watcher.watch("queryA", {}, vi.fn());
    watcher.watch("queryB", {}, vi.fn());
    await flush();

    await watcher.onQueriesInvalidated(["queryA"]);
    expect(registry.executeQuery).toHaveBeenCalledTimes(3); // two baselines + queryA refetch
  });

  it("updates the baseline after a notification", async () => {
    const { watcher, registry } = createWatcher();
    registry.executeQuery
      .mockResolvedValueOnce([{ value: 1 }])
      .mockResolvedValueOnce([{ value: 2 }])
      .mockResolvedValueOnce([{ value: 3 }]);
    const callback = vi.fn<(diff: WatchDiff) => void>();

    watcher.watch("queryA", {}, callback);
    await flush();

    await watcher.onQueriesInvalidated(["queryA"]);
    await watcher.onQueriesInvalidated(["queryA"]);

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[1]?.[0]?.previous).toEqual([{ value: 2 }]);
    expect(callback.mock.calls[1]?.[0]?.current).toEqual([{ value: 3 }]);
  });

  it("logs and swallows refetch failures", async () => {
    const { watcher, registry } = createWatcher();
    registry.executeQuery
      .mockResolvedValueOnce([{ a: 1 }])
      .mockRejectedValueOnce(new Error("boom"));
    const callback = vi.fn();

    watcher.watch("queryA", {}, callback);
    await flush();

    await watcher.onQueriesInvalidated(["queryA"]);

    expect(callback).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("warn", "QueryWatcher: re-fetch failed", {
      queryName: "queryA",
      error: "boom",
    });
  });
});
